#!/usr/bin/env bash
#
# tests/redteam/oci.sh <image-id> [options]
#
# Adversarial test of a candidate Safebox OCI custom image. It creates
# throwaway OCI resources (every one named safebox-redteam-*), really performs
# each attack from docs/HARDENING-PLAN.md "Red team tests", and prints:
#
#   PASS <name>        the attack failed as it must
#   FAIL <name>: ...   the attack succeeded, or it failed for a reason that
#                      is not the designed refusal (nothing proven)
#   SKIP <name>: ...   cannot be automated here, or OCI refused the TESTER
#                      (NotAuthorizedOrNotFound and friends), which says
#                      nothing about the box
#
# A non-zero exit from an attack command is never a PASS on its own. OCI IAM
# is allow-only, so "NotAuthorized" on the console or agent-command APIs is
# indistinguishable from the tester simply lacking the grant; those checks
# SKIP with a note unless the API gives a more specific refusal.
#
# It exits 1 if any check FAILs. A trap terminates every instance, volume,
# console connection, bastion and NSG it created, on any exit.
#
# Required:
#   <image-id>                     image OCID to test
#   --compartment-id <ocid>        compartment for the throwaway resources
#   --subnet-id <ocid>             subnet to launch in (its AD is used)
# Optional:
#   --shape <shape>                default VM.Standard.E4.Flex (shielded-capable)
#   --relay-url <url>              base URL of a DNS relay (tools/dns-relay) named in
#                                  the image's defaults.json; GET <url>/announces/<id>
#                                  is the announce oracle (run it with --owners)
#   --owner-pubkey <hex64>         an owner key the relay knows, for the main instance
#   --launch-authorization <b64>   a launch authorization for the main instance's id
#                                  signed with that key, so the "healthy box" baseline
#                                  is a box whose announce was accepted; without it the
#                                  baseline is "answers on 443 or 8443"
#   --helper-instance-id <ocid>    running instance in the same AD that this script
#                                  has root on (default: the instance this script runs
#                                  on, read from IMDS); used to dd into the boot clone
#   --bastion-id <ocid>            existing Bastion to try managed SSH through;
#                                  otherwise a throwaway one is created
#
# What each check does is described above its function. The two container
# checks SKIP: the only container the system component starts for a caller
# runs with --network none, so a probe through /test would prove nothing
# about the DOCKER-USER rule or the safebox-app network. See
# docs/HARDENING-PLAN.md, "10. Verification", for the in-host procedure.

set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

die() { echo "redteam: FATAL: $*" >&2; exit 2; }
log() { echo "redteam: $*" >&2; }

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
IMAGE_ID="${1:-}"
[ -n "$IMAGE_ID" ] || die "usage: oci.sh <image-id> --compartment-id <ocid> --subnet-id <ocid> [options]"
shift || true

COMPARTMENT_ID=""
SUBNET_ID=""
SHAPE="VM.Standard.E4.Flex"
RELAY_URL=""
OWNER_PUBKEY=""
LAUNCH_AUTH=""
HELPER_ID=""
BASTION_ID=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --compartment-id)     COMPARTMENT_ID="${2:-}"; shift 2 ;;
        --subnet-id)          SUBNET_ID="${2:-}"; shift 2 ;;
        --shape)              SHAPE="${2:-}"; shift 2 ;;
        --relay-url)          RELAY_URL="${2:-}"; shift 2 ;;
        --owner-pubkey)       OWNER_PUBKEY="${2:-}"; shift 2 ;;
        --launch-authorization) LAUNCH_AUTH="${2:-}"; shift 2 ;;
        --helper-instance-id) HELPER_ID="${2:-}"; shift 2 ;;
        --bastion-id)         BASTION_ID="${2:-}"; shift 2 ;;
        *) die "unknown argument: $1" ;;
    esac
done

[ -n "$COMPARTMENT_ID" ] || die "--compartment-id is required"
[ -n "$SUBNET_ID" ] || die "--subnet-id is required"
for t in oci jq curl ssh ssh-keygen openssl; do
    command -v "$t" >/dev/null || die "$t not found"
done

PREFIX="safebox-redteam-$$"
WORK="$(mktemp -d /tmp/safebox-redteam.XXXXXX)"
# A throwaway owner key and a launch authorization signed with it: well
# formed, so the first-boot unit accepts it and the box boots and announces,
# but no relying party knows the key, so no announce is accepted anywhere.
# Without node on the tester, fall back to junk base64 (the box then never
# starts dnsclient).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BOGUS_OWNER="$(printf 'a%.0s' {1..64})"
BOGUS_AUTH="$(printf 'x%.0s' {1..60} | base64 -w0)"
make_bogus_auth() {
    # make_bogus_auth <safebox-id>: prints a base64 authorization for the id
    # under the throwaway key, or the junk fallback.
    local key
    if command -v node >/dev/null 2>&1; then
        key="$(mktemp)"
        BOGUS_OWNER="$(node "$REPO/tools/dns-relay/authorize.js" keygen "$key")"
        node "$REPO/tools/dns-relay/authorize.js" sign "$key" "$1" 4
        rm -f "$key"
    else
        printf '%s\n' "$BOGUS_AUTH"
    fi
}

AD="$(oci network subnet get --subnet-id "$SUBNET_ID" --query 'data."availability-domain"' --raw-output)"
[ -n "$AD" ] || die "could not read the subnet's availability domain"
VCN_ID="$(oci network subnet get --subnet-id "$SUBNET_ID" --query 'data."vcn-id"' --raw-output)"

# ---------------------------------------------------------------------------
# Resource bookkeeping and cleanup
# ---------------------------------------------------------------------------
INSTANCES=()
VOLUMES=()
BOOT_VOLUMES=()
CONSOLES=()
BASTIONS=()
NSGS=()
RESULTS=()
FAILED=0

# shellcheck disable=SC2317  # invoked by the EXIT trap
cleanup() {
    local rc=$? x
    set +e
    log "cleaning up throwaway resources"
    for x in "${CONSOLES[@]}"; do
        oci compute instance-console-connection delete --instance-console-connection-id "$x" --force >/dev/null 2>&1
    done
    for x in "${INSTANCES[@]}"; do
        oci compute instance terminate --instance-id "$x" --preserve-boot-volume false --force >/dev/null 2>&1
    done
    for x in "${INSTANCES[@]}"; do
        oci compute instance get --instance-id "$x" --wait-for-state TERMINATED --max-wait-seconds 900 >/dev/null 2>&1
    done
    for x in "${BOOT_VOLUMES[@]}"; do
        oci bv boot-volume delete --boot-volume-id "$x" --force >/dev/null 2>&1
    done
    for x in "${VOLUMES[@]}"; do
        oci bv volume delete --volume-id "$x" --force >/dev/null 2>&1
    done
    for x in "${BASTIONS[@]}"; do
        oci bastion bastion delete --bastion-id "$x" --force >/dev/null 2>&1
    done
    for x in "${NSGS[@]}"; do
        oci network nsg delete --network-security-group-id "$x" --force >/dev/null 2>&1
    done
    rm -rf "$WORK"
    exit "$rc"
}
trap cleanup EXIT

pass() { echo "PASS $1"; RESULTS+=("PASS $1"); }
fail() { echo "FAIL $1: ${2:-}"; RESULTS+=("FAIL $1: ${2:-}"); FAILED=1; }
skip() { echo "SKIP $1: ${2:-}"; RESULTS+=("SKIP $1: ${2:-}"); }

# Errors that mean the TESTER was refused or misused the CLI. They say nothing
# about the box, so a check that sees one is SKIP, never PASS.
TESTER_ERR_RE='NotAuthorizedOrNotFound|NotAuthenticated|NotAuthorized|not authorized|Unauthorized|Forbidden|\b40[13]\b|Insufficient permissions|InsufficientPermissions|Error: No such command|Error: no such option|Error: Missing option|Invalid value for|Usage: oci|command not found|Could not find config|ConfigFileNotFound|InvalidParameter.*(compartment|target|display-name)'
first_line() { printf '%s' "$1" | grep -v '^[[:space:]]*$' | head -n1 | head -c 200; }
# classify <name> <output> <expected-refusal-regex>
# PASS when the output shows the refusal the design predicts, SKIP when it
# shows the tester being refused, FAIL otherwise.
classify() {
    local name="$1" out="$2" expect_re="$3"
    if printf '%s' "$out" | grep -qiE "$expect_re"; then
        pass "$name"
    elif printf '%s' "$out" | grep -qiE "$TESTER_ERR_RE"; then
        skip "$name" "tester lacks permission or CLI issue: $(first_line "$out")"
    else
        fail "$name" "failed for an unexpected reason (not the designed refusal): $(first_line "$out")"
    fi
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
make_nsg() {
    # 443 and 8443 in, all out: the production NSG shape.
    local id
    id="$(oci network nsg create --compartment-id "$COMPARTMENT_ID" --vcn-id "$VCN_ID" \
        --display-name "$PREFIX-nsg" --query data.id --raw-output)"
    NSGS+=("$id")
    oci network nsg rules add --nsg-id "$id" --security-rules '[
      {"direction":"INGRESS","protocol":"6","source":"0.0.0.0/0","sourceType":"CIDR_BLOCK","tcpOptions":{"destinationPortRange":{"min":443,"max":443}}},
      {"direction":"INGRESS","protocol":"6","source":"0.0.0.0/0","sourceType":"CIDR_BLOCK","tcpOptions":{"destinationPortRange":{"min":8443,"max":8443}}},
      {"direction":"EGRESS","protocol":"all","destination":"0.0.0.0/0","destinationType":"CIDR_BLOCK"}
    ]' >/dev/null
    echo "$id"
}

make_data_volume() {
    local id
    id="$(oci bv volume create --compartment-id "$COMPARTMENT_ID" --availability-domain "$AD" \
        --display-name "$PREFIX-data-$1" --size-in-gbs 50 --vpus-per-gb 10 \
        --wait-for-state AVAILABLE --query data.id --raw-output)"
    VOLUMES+=("$id")
    echo "$id"
}

# launch_instance <suffix> <metadata-json> : a shielded instance exactly as the
# Terraform module launches it (agent plugins off, legacy IMDS off, no SSH
# key), with an empty 50 GB data volume. Prints the instance OCID.
launch_instance() {
    local suffix="$1" metadata="$2" nsg vol id
    nsg="$(make_nsg)"
    id="$(oci compute instance launch \
        --compartment-id "$COMPARTMENT_ID" --availability-domain "$AD" \
        --display-name "$PREFIX-$suffix" --shape "$SHAPE" \
        --shape-config '{"ocpus":2,"memoryInGBs":16}' \
        --image-id "$IMAGE_ID" \
        --subnet-id "$SUBNET_ID" --assign-public-ip true --nsg-ids "[\"$nsg\"]" \
        --metadata "$metadata" \
        --agent-config '{"areAllPluginsDisabled":true,"isManagementDisabled":true,"isMonitoringDisabled":true}' \
        --instance-options '{"areLegacyImdsEndpointsDisabled":true}' \
        --launch-options '{"bootVolumeType":"PARAVIRTUALIZED","networkType":"PARAVIRTUALIZED","isConsistentVolumeNamingEnabled":true}' \
        --is-pv-encryption-in-transit-enabled true \
        --platform-config '{"type":"AMD_VM","isSecureBootEnabled":true,"isMeasuredBootEnabled":true,"isTrustedPlatformModuleEnabled":true}' \
        --freeform-tags '{"safebox-redteam":"true"}' \
        --wait-for-state RUNNING --max-wait-seconds 900 \
        --query data.id --raw-output)"
    INSTANCES+=("$id")
    vol="$(make_data_volume "$suffix")"
    oci compute volume-attachment attach --instance-id "$id" --volume-id "$vol" \
        --type paravirtualized --wait-for-state ATTACHED >/dev/null
    echo "$id"
}

public_ip() {
    oci compute instance list-vnics --instance-id "$1" --query 'data[0]."public-ip"' --raw-output
}

boot_volume_id() {
    # shellcheck disable=SC2016  # JMESPath backticks, not shell
    oci compute boot-volume-attachment list --compartment-id "$COMPARTMENT_ID" \
        --availability-domain "$AD" --instance-id "$1" \
        --query 'data[?"lifecycle-state"==`ATTACHED`] | [0]."boot-volume-id"' --raw-output
}

# box_alive <ip> <seconds>: liveness without a shell. nginx answers on 443
# (autovhost's catch-all with its bootstrap certificate) as soon as the pool
# is open and the services are up; dnsclient's challenge listener on 8443
# starts once dnsclient has a well-formed launch authorization, so it is
# accepted as a second signal but not required. An image built without the
# autovhost component has no other listener; test such images with node on
# the tester (so the throwaway authorization is well formed) or a real
# --launch-authorization so 8443 can be observed.
box_alive() {
    local ip="$1" seconds="$2" deadline
    deadline=$(( $(date +%s) + seconds ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if curl -sk -o /dev/null --max-time 5 "https://$ip/" 2>/dev/null \
           || curl -s -o /dev/null --max-time 5 "http://$ip:8443/" 2>/dev/null; then
            return 0
        fi
        sleep 15
    done
    return 1
}

# announce_hash <safebox-id>: prints the relay's lastAnnounceHash for the id,
# or "none" when the relay has accepted no announce for it (404).
announce_hash() {
    curl -fsS --max-time 10 "${RELAY_URL%/}/announces/$1" 2>/dev/null | jq -r '.lastAnnounceHash // "none"' 2>/dev/null || echo none
}

# poll_announced <safebox-id> <seconds>: 0 if the relay accepts an announce
# for the box within the window, 1 if never. Callers SKIP without --relay-url.
poll_announced() {
    local sid="$1" seconds="$2" deadline
    deadline=$(( $(date +%s) + seconds ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        [ "$(announce_hash "$sid")" != none ] && return 0
        sleep 20
    done
    return 1
}

# ---------------------------------------------------------------------------
# Main throwaway instance
# ---------------------------------------------------------------------------
MAIN_SID="redteam-$(date +%s | tail -c 7)"
if [ -n "$LAUNCH_AUTH" ]; then
    MAIN_OWNER="$OWNER_PUBKEY"; MAIN_AUTH="$LAUNCH_AUTH"
else
    MAIN_AUTH="$(make_bogus_auth "$MAIN_SID")"; MAIN_OWNER="$BOGUS_OWNER"
fi
MAIN_META="$(jq -cn --arg id "$MAIN_SID" --arg owner "$MAIN_OWNER" --arg auth "$MAIN_AUTH" \
    '{"safebox-id":$id,"owner-pubkey":$owner,"launch-authorization":$auth}')"
log "launching main instance ($PREFIX-main, safebox-id $MAIN_SID)"
MAIN_ID="$(launch_instance main "$MAIN_META")"
MAIN_IP="$(public_ip "$MAIN_ID")"
log "main instance $MAIN_ID at $MAIN_IP; waiting for it to come up"
if ! box_alive "$MAIN_IP" 600; then
    die "main instance never answered on 443 or 8443 within 10 minutes; the image does not boot, nothing to red-team"
fi
if [ -n "$LAUNCH_AUTH" ] && [ -n "$RELAY_URL" ]; then
    poll_announced "$MAIN_SID" 300 || die "main instance's announce was not accepted by the relay with a real authorization; fix that before red-teaming"
fi

# ---------------------------------------------------------------------------
# Check 1: serial console login
# ---------------------------------------------------------------------------
# Attack: create an instance console connection (OCI's serial console over
# SSH) and look for a login prompt. The on-image control is that there is no
# getty, so the console shows kernel/systemd output and never "login:". The
# cloud-level control in oci/INSTRUCTIONS.md is the ABSENCE of the
# instance-console-connection grant; OCI IAM is allow-only, so a
# NotAuthorized here cannot be told apart from the tester lacking the grant
# and is a SKIP, not a PASS. To exercise the on-image half, run with a
# principal that may create console connections.
check_serial_console() {
    local name="serial-console-login" out cid state ep
    ssh-keygen -q -t ed25519 -N '' -f "$WORK/console_key" >/dev/null
    if ! out="$(oci compute instance-console-connection create --instance-id "$MAIN_ID" \
            --ssh-public-key-file "$WORK/console_key.pub" 2>&1)"; then
        CONSOLE_REFUSED=1
        if printf '%s' "$out" | grep -qiE "$TESTER_ERR_RE"; then
            skip "$name" "tester may not create console connections (cannot distinguish the deny-by-omission policy from a missing grant): $(first_line "$out")"
        else
            fail "$name" "console connection create failed for an unexpected reason: $(first_line "$out")"
        fi
        return
    fi
    cid="$(printf '%s' "$out" | jq -r '.data.id')"
    CONSOLES+=("$cid")
    oci compute instance-console-connection get --instance-console-connection-id "$cid" \
        --wait-for-state ACTIVE --max-wait-seconds 300 >/dev/null 2>&1 || true
    state="$(oci compute instance-console-connection get --instance-console-connection-id "$cid" \
        --query 'data."lifecycle-state"' --raw-output)"
    [ "$state" = "ACTIVE" ] || { fail "$name" "console connection reached state $state"; return; }
    # The connection-string field is an ssh ProxyCommand incantation; use the
    # endpoint it names and send a newline, expecting no login prompt.
    ep="$(oci compute instance-console-connection get --instance-console-connection-id "$cid" \
        --query 'data."connection-string"' --raw-output)"
    local rc=0
    out="$(timeout 20 bash -c "printf '\n\n' | ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o BatchMode=yes -i '$WORK/console_key' -o ProxyCommand=\"$(printf '%s' "$ep" | sed -n 's/.*ProxyCommand=\x27\([^\x27]*\)\x27.*/\1/p')\" \
        '$MAIN_ID' 2>&1")" || rc=$?
    oci compute instance-console-connection delete --instance-console-connection-id "$cid" --force >/dev/null 2>&1 || true
    if printf '%s' "$out" | grep -qE 'login:|Password:'; then
        fail "$name" "console shows a login prompt"
    elif [ "$rc" -eq 124 ] || [ "$rc" -eq 0 ]; then
        # The session opened and showed no prompt until the timeout cut it.
        pass "$name"
    elif printf '%s' "$out" | grep -qiE 'Permission denied|Connection closed|Connection refused|Could not resolve|kex_exchange'; then
        fail "$name" "console connection was created but the ssh session could not be opened (no-login not proven): $(first_line "$out")"
    else
        fail "$name" "console session ended for an unexpected reason (rc=$rc): $(first_line "$out")"
    fi
}
CONSOLE_REFUSED=0

# ---------------------------------------------------------------------------
# Check 2: GRUB interrupt via the console
# ---------------------------------------------------------------------------
# The real attack (press a key during the GRUB timeout, press e, add
# init=/bin/bash) needs keystrokes on the serial websocket during a reboot,
# which this script does not drive. Observable proxy: if the console cannot be
# opened at all (check 1 refused), the vector is closed at the cloud level and
# this PASSes. If it can be opened, this is a manual check:
#   1. oci compute instance-console-connection create ... ; ssh to it
#   2. oci compute instance action --action SOFTRESET --instance-id <id>
#   3. hold Escape/F10 during boot; GRUB has timeout 0 and a hidden menu, so the
#      menu should not appear; if it does, press e: GRUB must ask for the
#      superuser password. Any edit changes PCR 8 and the pool will not open.
check_grub_interrupt() {
    local name="grub-interrupt"
    if [ "$CONSOLE_REFUSED" -eq 1 ]; then
        skip "$name" "manual: no console connection could be created by this tester (see serial-console-login); PCR 8 covers the cmdline"
    else
        skip "$name" "manual: console is openable; follow the procedure in tests/redteam/oci.sh"
    fi
}

# ---------------------------------------------------------------------------
# Check 3: Run Command (instance agent)
# ---------------------------------------------------------------------------
# Attack: create a Run Command. Expected: the agent is not in the image and
# every plugin is disabled, so creation is refused or the command never
# reaches SUCCEEDED.
check_run_command() {
    local name="run-command" out cmd state deadline
    if ! out="$(oci instance-agent command create --compartment-id "$COMPARTMENT_ID" \
            --target "{\"instanceId\":\"$MAIN_ID\"}" \
            --content '{"source":{"sourceType":"TEXT","text":"id; touch /tmp/pwned"},"output":{"outputType":"TEXT"}}' \
            --execution-time-out-in-seconds 120 --display-name "$PREFIX-runcmd" 2>&1)"; then
        # Designed refusal: the API rejects a command for an instance whose
        # agent plugins are disabled. A bare NotAuthorized is the tester's
        # missing instance-agent-command grant (allow-only IAM) and is a SKIP.
        classify "$name" "$out" 'agent|plugin|not enabled|disabled|NotSupported|unsupported|InstanceAgent'
        return
    fi
    cmd="$(printf '%s' "$out" | jq -r '.data.id')"
    deadline=$(( $(date +%s) + 180 ))
    state=""
    while [ "$(date +%s)" -lt "$deadline" ]; do
        state="$(oci instance-agent command-execution get --instance-agent-command-id "$cmd" \
            --instance-id "$MAIN_ID" --query 'data."lifecycle-state"' --raw-output 2>/dev/null || echo NONE)"
        case "$state" in
            SUCCEEDED) fail "$name" "Run Command executed on the box"; oci instance-agent command cancel --instance-agent-command-id "$cmd" >/dev/null 2>&1 || true; return ;;
            FAILED|TIMED_OUT|CANCELED) break ;;
        esac
        sleep 15
    done
    oci instance-agent command cancel --instance-agent-command-id "$cmd" >/dev/null 2>&1 || true
    pass "$name"
}

# ---------------------------------------------------------------------------
# Check 4: Bastion managed SSH
# ---------------------------------------------------------------------------
# Attack: a managed-SSH Bastion session, which needs the agent's Bastion
# plugin inside the instance. Expected: session creation fails or never
# becomes ACTIVE.
check_bastion() {
    local name="bastion-managed-ssh" bid out sid state
    bid="$BASTION_ID"
    if [ -z "$bid" ]; then
        local berr="$WORK/bastion.err"
        if ! bid="$(oci bastion bastion create --compartment-id "$COMPARTMENT_ID" --bastion-type STANDARD \
                --target-subnet-id "$SUBNET_ID" --name "$(printf '%s' "$PREFIX" | tr -d '-')bastion" \
                --client-cidr-block-allow-list '["0.0.0.0/0"]' \
                --wait-for-state SUCCEEDED --query 'data.resources[0].identifier' --raw-output 2>"$berr")"; then
            # Creating the bastion is the attacker's own setup step; not being
            # able to do it says nothing about the box.
            skip "$name" "tester could not create a bastion (pass --bastion-id to use an existing one): $(first_line "$(cat "$berr")")"
            return
        fi
        BASTIONS+=("$bid")
    fi
    ssh-keygen -q -t ed25519 -N '' -f "$WORK/bastion_key" >/dev/null
    if ! out="$(oci bastion session create-managed-ssh --bastion-id "$bid" \
            --target-resource-id "$MAIN_ID" --target-os-username opc \
            --ssh-public-key-file "$WORK/bastion_key.pub" --session-ttl 1800 2>&1)"; then
        # Designed refusal: the Bastion plugin is not running on the target.
        classify "$name" "$out" 'plugin|agent|not (enabled|running|available)|InvalidParameter.*target|target .* not'
        return
    fi
    sid="$(printf '%s' "$out" | jq -r '.data.resources[0].identifier // .data.id')"
    state="$(oci bastion session get --session-id "$sid" --wait-for-state ACTIVE --wait-for-state FAILED \
        --max-wait-seconds 300 --query 'data."lifecycle-state"' --raw-output 2>/dev/null)" || state=UNKNOWN
    oci bastion session delete --session-id "$sid" --force >/dev/null 2>&1 || true
    case "$state" in
        ACTIVE) fail "$name" "managed SSH session became ACTIVE (agent plugin answered)" ;;
        FAILED|DELETED|DELETING) pass "$name" ;;
        *) fail "$name" "session state '$state' after 300 s; cannot tell whether the plugin answered" ;;
    esac
}

# ---------------------------------------------------------------------------
# Check 5: user-data injection on the running box, then reboot
# ---------------------------------------------------------------------------
# Attack: rewrite the instance metadata with a user_data script and reboot.
# Expected: either the API refuses to change user_data after launch, or the
# box reboots and nothing happens (no cloud-init; the firstboot unit reads
# three named keys and executes nothing). Observable: the box comes back
# answering on 8443, and its announce state at the relay is unchanged apart
# from the box's own heartbeat (same box key).
check_userdata_injection() {
    local name="userdata-injection-reboot" script meta out before after
    script="$(printf '#!/bin/bash\ntouch /tmp/pwned\ncurl -s http://canary.invalid/pwned\n' | base64 -w0)"
    before=unknown
    if [ -n "$RELAY_URL" ]; then
        before="$(curl -fsS --max-time 10 "${RELAY_URL%/}/announces/$MAIN_SID" 2>/dev/null | jq -r '.boxPubkey // "none"' || echo none)"
    fi
    meta="$(printf '%s' "$MAIN_META" | jq -c --arg ud "$script" '. + {"user_data":$ud}')"
    if ! out="$(oci compute instance update --instance-id "$MAIN_ID" --metadata "$meta" --force 2>&1)"; then
        # Designed refusal: the API will not change user_data after launch.
        # A NotAuthorized is the tester's own missing update grant.
        classify "$name" "$out" 'user_data|cannot be (updated|changed|modified)|immutable|InvalidParameter.*metadata'
        return
    fi
    oci compute instance action --instance-id "$MAIN_ID" --action SOFTRESET \
        --wait-for-state RUNNING --max-wait-seconds 600 >/dev/null
    if ! box_alive "$MAIN_IP" 600; then
        fail "$name" "box did not come back after the metadata change and reboot"; return
    fi
    if [ "$before" != unknown ]; then
        after="$(curl -fsS --max-time 10 "${RELAY_URL%/}/announces/$MAIN_SID" 2>/dev/null | jq -r '.boxPubkey // "none"' || echo none)"
        [ "$after" = "$before" ] || { fail "$name" "box identity at the relay changed from $before to $after"; return; }
    fi
    # The canary URL above is unobservable from here; see check 6.
    pass "$name"
}

# ---------------------------------------------------------------------------
# Check 6: hostile user-data on a fresh launch
# ---------------------------------------------------------------------------
# Attack: launch from the image with a bogus launch authorization plus a
# shell script as user_data. Expected: no announce for the box is accepted
# anywhere (the authorization is signed by nobody a relying party knows)
# and the script never runs. The "never runs" half needs a canary
# listener for http://<listener>/pwned that this script does not provide, so
# that sub-check SKIPs. Manual: run `nc -l 8080` (or a request bin) on a host
# you control, put its URL in CANARY below, launch, and expect no request.
check_hostile_userdata() {
    local name="hostile-userdata-launch" sid meta id ip script
    sid="redteam-hostile-$(date +%s | tail -c 6)"
    script="$(printf '#!/bin/bash\ntouch /tmp/pwned\ncurl -s http://canary.invalid/pwned\n' | base64 -w0)"
    local auth
    auth="$(make_bogus_auth "$sid")"
    meta="$(jq -cn --arg id "$sid" --arg owner "$BOGUS_OWNER" --arg auth "$auth" --arg ud "$script" \
        '{"safebox-id":$id,"owner-pubkey":$owner,"launch-authorization":$auth,"user_data":$ud}')"
    id="$(launch_instance hostile "$meta")"
    ip="$(public_ip "$id")"
    if ! box_alive "$ip" 600; then
        fail "$name" "hostile-launch instance never came up; cannot tell whether user-data ran"; return
    fi
    pass "$name-boot"
    if [ -n "$RELAY_URL" ]; then
        if poll_announced "$sid" 300; then
            fail "$name-announce-rejected" "the relay accepted an announce for $sid under the bogus authorization"; return
        fi
        pass "$name-announce-rejected"
    else
        skip "$name-announce-rejected" "needs --relay-url to observe that no announce for $sid is accepted"
    fi
    skip "hostile-userdata-canary" "manual: point the script's canary URL at a listener you control and expect no request"
}

# ---------------------------------------------------------------------------
# Check 7: boot disk clone, edit, swap
# ---------------------------------------------------------------------------
# Attack: stop the box, clone its boot volume, attach the clone to a helper
# as a block volume, write one byte into the root partition (p3, the verity
# data), detach, swap the clone in as the boot volume, start. Expected: the
# ext4 superblock is now a block whose hash does not match the tree, the
# kernel refuses it, the root never mounts, and the box never announces or
# answers on 443 or 8443 within 10 minutes.
#
# The helper is the instance this script runs on by default (it must be in
# the same AD and the script must run as root there), so no second shell-
# capable image is needed.
check_disk_swap() {
    local name="boot-disk-clone-edit-swap" bv clone att dev p3 bva
    if [ -z "$HELPER_ID" ]; then
        HELPER_ID="$(curl -fsS --max-time 5 -H 'Authorization: Bearer Oracle' http://169.254.169.254/opc/v2/instance/id 2>/dev/null || true)"
    fi
    if [ -z "$HELPER_ID" ] || [ "$(id -u)" -ne 0 ]; then
        skip "$name" "needs --helper-instance-id (a running instance in $AD this script runs on as root) to dd into the clone"
        return
    fi
    bv="$(boot_volume_id "$MAIN_ID")"
    if [ -z "$bv" ] || [ "$bv" = null ]; then
        fail "$name" "could not find the main instance's boot volume"; return
    fi
    log "stopping main instance for the disk swap"
    oci compute instance action --instance-id "$MAIN_ID" --action STOP \
        --wait-for-state STOPPED --max-wait-seconds 600 >/dev/null
    clone="$(oci bv boot-volume create --compartment-id "$COMPARTMENT_ID" --availability-domain "$AD" \
        --source-boot-volume-id "$bv" --display-name "$PREFIX-bootclone" \
        --wait-for-state AVAILABLE --max-wait-seconds 900 --query data.id --raw-output)"
    BOOT_VOLUMES+=("$clone")
    # Attach the clone to the helper as a data volume and find its device by
    # the attachment's reported path (consistent naming) or by lsblk delta.
    att="$(oci compute volume-attachment attach --instance-id "$HELPER_ID" --volume-id "$clone" \
        --type paravirtualized --device /dev/oracleoci/oraclevdz \
        --wait-for-state ATTACHED --max-wait-seconds 600 --query data.id --raw-output)"
    sleep 5
    udevadm settle 2>/dev/null || true
    dev="$(readlink -f /dev/oracleoci/oraclevdz 2>/dev/null || true)"
    if [ -z "$dev" ] || [ ! -b "$dev" ]; then
        oci compute volume-attachment detach --volume-attachment-id "$att" --force >/dev/null 2>&1 || true
        fail "$name" "could not locate the attached clone on the helper"; return
    fi
    p3="$(lsblk -rno PATH,PARTLABEL "$dev" | awk '$2=="SAFEBOX-ROOT"{print $1}' | head -n1)"
    [ -b "$p3" ] || { oci compute volume-attachment detach --volume-attachment-id "$att" --force >/dev/null 2>&1; fail "$name" "no SAFEBOX-ROOT partition on the clone"; return; }
    # One byte, into the ext4 superblock (offset 1024), the first block the
    # kernel reads on mount.
    printf '\x5a' | dd of="$p3" bs=1 seek=1024 count=1 conv=notrunc status=none
    sync
    oci compute volume-attachment detach --volume-attachment-id "$att" --wait-for-state DETACHED --max-wait-seconds 600 >/dev/null
    # shellcheck disable=SC2016  # JMESPath backticks, not shell
    bva="$(oci compute boot-volume-attachment list --compartment-id "$COMPARTMENT_ID" --availability-domain "$AD" \
        --instance-id "$MAIN_ID" --query 'data[?"lifecycle-state"==`ATTACHED`] | [0].id' --raw-output)"
    oci compute boot-volume-attachment detach --boot-volume-attachment-id "$bva" \
        --wait-for-state DETACHED --max-wait-seconds 600 >/dev/null
    BOOT_VOLUMES+=("$bv")   # the original is now unattached; delete it at the end
    oci compute boot-volume-attachment attach --instance-id "$MAIN_ID" --boot-volume-id "$clone" \
        --wait-for-state ATTACHED --max-wait-seconds 600 >/dev/null
    oci compute instance action --instance-id "$MAIN_ID" --action START \
        --wait-for-state RUNNING --max-wait-seconds 600 >/dev/null
    MAIN_IP="$(public_ip "$MAIN_ID")"
    if box_alive "$MAIN_IP" 600; then
        fail "$name" "box came up on a modified root"; return
    fi
    pass "$name"
}

# ---------------------------------------------------------------------------
# Checks 8 and 9: container -> IMDS and container -> Docker socket
# ---------------------------------------------------------------------------
# Not automatable from outside the box. The earlier implementation went
# through the system component's /test endpoint, but the only container that
# endpoint starts runs with --network none and no socket bind, so "could not
# reach 169.254.169.254 / docker.sock" from there is a property of the
# test-run flags, not of the DOCKER-USER DROP rule or of the safebox-app
# network the managed containers use. Such a result passes vacuously. The
# honest probe runs inside a managed container on the safebox-app network
# from an image that includes curl; the procedure is in
# docs/HARDENING-PLAN.md, "10. Verification".
check_container_imds() {
    skip "container-to-imds" "requires in-host probe (managed container on the safebox-app network); see docs/HARDENING-PLAN.md verification"
}

check_container_docker_socket() {
    skip "container-to-docker-socket" "requires in-host probe (managed container on the safebox-app network); see docs/HARDENING-PLAN.md verification"
}

# ---------------------------------------------------------------------------
# Check 10: legacy IMDS v1 endpoints (Terraform assertion)
# ---------------------------------------------------------------------------
# Not testable from a helper: IMDS answers only the instance itself. The
# observable is the launch option, which the Terraform module sets and the
# API reports back.
check_legacy_imds() {
    local name="legacy-imds-disabled" v
    v="$(oci compute instance get --instance-id "$MAIN_ID" \
        --query 'data."instance-options"."are-legacy-imds-endpoints-disabled"' --raw-output 2>/dev/null || echo null)"
    if [ "$v" = "true" ]; then pass "$name"; else fail "$name" "are-legacy-imds-endpoints-disabled is $v"; fi
}

# ---------------------------------------------------------------------------
# Run, in the contract's order (the disk swap last among the destructive ones
# because it leaves the main box unbootable).
# ---------------------------------------------------------------------------
log "image $IMAGE_ID (throwaway prefix $PREFIX)"
check_serial_console
check_grub_interrupt
check_run_command
check_bastion
check_legacy_imds
check_userdata_injection
check_hostile_userdata
check_container_imds
check_container_docker_socket
check_disk_swap

echo ""
echo "================ redteam summary ================"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "================================================="
[ "$FAILED" -eq 0 ] || { echo "redteam: one or more checks FAILED" >&2; exit 1; }
echo "redteam: all checks passed or skipped"
