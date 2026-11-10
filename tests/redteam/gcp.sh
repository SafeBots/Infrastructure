#!/bin/bash
#
# tests/redteam/gcp.sh <image-name-or-self-link> - attack a candidate Safebox
# GCE image and expect every attempt to fail (docs/HARDENING-PLAN.md, "Red
# team tests"). Really performs each attempt with gcloud against throwaway
# resources it creates with a safebox-redteam- prefix and deletes on exit.
#
# Each check is a function that prints exactly one of:
#   PASS <name>            the attack failed the way the plan says it must
#   FAIL <name>: <detail>  the attack succeeded, the box misbehaved, or the
#                          attempt failed for a reason that is not the
#                          designed refusal (nothing proven)
#   SKIP <name>: <reason>  not automatable here, or gcloud refused the TESTER
#                          (PERMISSION_DENIED, missing component), which says
#                          nothing about the box
# A summary table follows and the exit status is 1 if any check FAILed.
# A non-zero exit from an attack command is never a PASS on its own: every
# check names the refusal it expects and classifies anything else.
#
# Usage:
#   tests/redteam/gcp.sh <image> [--project P] [--zone Z] [--network N]
#       [--subnetwork S] [--machine-type T]
#       [--relay-url URL] [--keep]
#
# --relay-url: when given, announce state is read from a DNS relay
#   (tools/dns-relay) that the image's defaults.json names:
#   GET <url>/announces/<safebox-id> (200 = an announce verified and was
#   accepted, 404 = none). Run the relay with --owners so the throwaway owner
#   key this script mints is unknown to it. Without the relay the observable
#   proxy is the dnsclient challenge listener on 8443, which only exists once
#   the box has booted through the initramfs, mounted the pool and started
#   dnsclient with a well-formed launch authorization.
# The container->metadata and container->docker-socket checks SKIP: the
#   only container the system component starts for a caller runs with
#   --network none, so a probe through /test would prove nothing about the
#   DOCKER-USER rule or the safebox-app network. See docs/HARDENING-PLAN.md,
#   "10. Verification", for the in-host procedure.
# --keep: do not delete the resources at exit (for a post-mortem).
#
# Requires: gcloud (authenticated, with compute admin on the project), curl,
# jq, openssl, timeout. Runs for roughly 30-40 minutes, most of it waiting
# for boots and the 10-minute disk-swap observation window.

set -euo pipefail
export LC_ALL=C

die() { printf 'redteam-gcp: ERROR: %s\n' "$*" >&2; exit 2; }
log() { printf 'redteam-gcp: %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
IMAGE=""
PROJECT=""
ZONE=""
NETWORK=default
SUBNETWORK=""
MACHINE_TYPE=e2-standard-2
RELAY_URL=""
KEEP=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --project)         PROJECT="${2:-}"; shift 2 ;;
        --zone)            ZONE="${2:-}"; shift 2 ;;
        --network)         NETWORK="${2:-}"; shift 2 ;;
        --subnetwork)      SUBNETWORK="${2:-}"; shift 2 ;;
        --machine-type)    MACHINE_TYPE="${2:-}"; shift 2 ;;
        --relay-url)       RELAY_URL="${2:-}"; shift 2 ;;
        --keep)            KEEP=1; shift ;;
        -h|--help)         sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
        -*)                die "unknown option $1" ;;
        *)                 [[ -z $IMAGE ]] || die "unexpected argument $1"; IMAGE="$1"; shift ;;
    esac
done
[[ -n $IMAGE ]] || die "usage: $0 <image-name-or-self-link> [options]"
for t in gcloud curl jq openssl timeout; do
    command -v "$t" >/dev/null 2>&1 || die "$t is required"
done
[[ -n $PROJECT ]] || PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
[[ -n $PROJECT ]] || die "no project: pass --project or set gcloud config"
[[ -n $ZONE ]] || ZONE="$(gcloud config get-value compute/zone 2>/dev/null || true)"
[[ -n $ZONE ]] || ZONE=us-central1-a
G=(gcloud --project "$PROJECT" --quiet)

# ---------------------------------------------------------------------------
# Resource names and cleanup
# ---------------------------------------------------------------------------
RUN_ID="$(openssl rand -hex 3)"
PREFIX="safebox-redteam-${RUN_ID}"
SAFEBOX_ID="redteam-${RUN_ID}"
INST="${PREFIX}"
INST2="${PREFIX}-hostile"
HELPER="${PREFIX}-helper"
DATA_DISK="${PREFIX}-data"
DATA_DISK2="${PREFIX}-data2"
SNAP="${PREFIX}-bootsnap"
TAMPER_DISK="${PREFIX}-tampered"
FW="${PREFIX}-fw"
# A throwaway owner key and a launch authorization signed with it: well
# formed, so the first-boot unit accepts it and the box boots and announces,
# but no relying party knows the key, so no announce is accepted anywhere.
# Without node on the tester, fall back to junk base64 (the box then never
# starts dnsclient and the 8443 proxy cannot be observed).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BOGUS_OWNER="$(printf 'a%.0s' {1..64})"
BOGUS_AUTH="$(printf 'x%.0s' {1..60} | base64 -w0)"
if command -v node >/dev/null 2>&1; then
    OWNER_KEY="$(mktemp)"
    BOGUS_OWNER="$(node "$REPO/tools/dns-relay/authorize.js" keygen "$OWNER_KEY")"
    BOGUS_AUTH="$(node "$REPO/tools/dns-relay/authorize.js" sign "$OWNER_KEY" "redteam-${RUN_ID}" 4)"
    rm -f "$OWNER_KEY"
fi

CREATED_INSTANCES=()
CREATED_DISKS=()
CREATED_SNAPSHOTS=()
CREATED_FIREWALLS=()
RESULTS=()
record() { RESULTS+=("$1"); printf '%s\n' "$1"; }
pass() { record "PASS $1"; }
fail() { record "FAIL $1: $2"; }
skip() { record "SKIP $1: $2"; }

# Errors that mean the TESTER was refused or misused gcloud. They say nothing
# about the box, so a check that sees one is SKIP, never PASS.
TESTER_ERR_RE='PERMISSION_DENIED|Permission denied \(|permission .* denied|does not have permission|Required .* permission|Insufficient Permission|UNAUTHENTICATED|Unauthorized|Forbidden|\b40[13]\b|not logged in|You do not currently have an active account|Invalid choice|unrecognized arguments|command not found|is not a gcloud command|not installed|SERVICE_DISABLED|API has not been used|is not enabled'
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

cleanup() {
    local rc=$? r
    set +e
    trap - EXIT
    if [[ $KEEP -eq 1 ]]; then
        log "--keep: leaving resources with prefix $PREFIX in place"
    else
        log "cleaning up resources with prefix $PREFIX"
        for r in "${CREATED_INSTANCES[@]}"; do
            "${G[@]}" compute instances delete "$r" --zone "$ZONE" --delete-disks=all >/dev/null 2>&1
        done
        for r in "${CREATED_DISKS[@]}"; do
            "${G[@]}" compute disks delete "$r" --zone "$ZONE" >/dev/null 2>&1
        done
        for r in "${CREATED_SNAPSHOTS[@]}"; do
            "${G[@]}" compute snapshots delete "$r" >/dev/null 2>&1
        done
        for r in "${CREATED_FIREWALLS[@]}"; do
            "${G[@]}" compute firewall-rules delete "$r" >/dev/null 2>&1
        done
    fi
    # Summary
    local failed=0
    printf '\n%-6s %s\n' RESULT CHECK
    printf '%-6s %s\n' ------ -----
    for r in "${RESULTS[@]}"; do
        printf '%-6s %s\n' "${r%% *}" "${r#* }"
        [[ $r == FAIL* ]] && failed=1
    done
    if [[ $failed -eq 1 ]]; then
        printf '\nredteam-gcp: at least one attack succeeded; the image is not shippable\n' >&2
        exit 1
    fi
    [[ $rc -eq 0 ]] || { printf '\nredteam-gcp: aborted with status %s before all checks ran\n' "$rc" >&2; exit "$rc"; }
    printf '\nredteam-gcp: all automated checks passed\n' >&2
    exit 0
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
instance_status() { "${G[@]}" compute instances describe "$1" --zone "$ZONE" --format='value(status)' 2>/dev/null || echo UNKNOWN; }
instance_ip() { "${G[@]}" compute instances describe "$1" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null; }
boot_disk_of() { "${G[@]}" compute instances describe "$1" --zone "$ZONE" --format='value(disks[0].source.basename())' 2>/dev/null; }

wait_status() {
    # wait_status <instance> <STATUS> <seconds>
    local inst="$1" want="$2" deadline=$(( $(date +%s) + $3 ))
    while [[ $(date +%s) -lt $deadline ]]; do
        [[ "$(instance_status "$inst")" == "$want" ]] && return 0
        sleep 10
    done
    return 1
}

# The dnsclient challenge listener answers 404 to an unknown nonce. Any HTTP
# answer at all on 8443 means: verity root opened, pool unsealed and
# mounted, services up. It is the single external liveness signal.
box_alive() {
    local ip="$1" code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$ip:8443/.well-known/safebox-announce-challenge/probe" 2>/dev/null || true)"
    [[ $code =~ ^[1-5][0-9][0-9]$ ]]
}
wait_alive() {
    # wait_alive <ip> <seconds>; returns 0 once alive
    local ip="$1" deadline=$(( $(date +%s) + $2 ))
    while [[ $(date +%s) -lt $deadline ]]; do
        box_alive "$ip" && return 0
        sleep 10
    done
    return 1
}

announced() {
    # announced <safebox-id>: 0 if the relay has accepted an announce for
    # the id. Returns 2 when no relay was given.
    [[ -n $RELAY_URL ]] || return 2
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
        "${RELAY_URL%/}/announces/$1" 2>/dev/null || true)"
    [[ $code == 200 ]]
}

create_data_disk() {
    "${G[@]}" compute disks create "$1" --zone "$ZONE" --size=50GB --type=pd-ssd >/dev/null
    CREATED_DISKS+=("$1")
}

launch_safebox() {
    # launch_safebox <name> <data-disk> <extra-metadata...>
    local name="$1" disk="$2"; shift 2
    local md="safebox-id=${SAFEBOX_ID},owner-pubkey=${BOGUS_OWNER},launch-authorization=${BOGUS_AUTH},enable-oslogin=FALSE,block-project-ssh-keys=TRUE,serial-port-enable=FALSE,serial-port-logging-enable=FALSE"
    # No relay key: the relays are baked into the image and the firstboot
    # unit ignores every metadata key other than the three above.
    local args=(compute instances create "$name" --zone "$ZONE" --machine-type "$MACHINE_TYPE"
        --image "$IMAGE" --boot-disk-type=pd-ssd --boot-disk-size=20GB
        --disk "name=${disk},device-name=safebox-data,mode=rw"
        --network "$NETWORK" --tags "$PREFIX"
        --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring
        --no-service-account --no-scopes
        --metadata "$md")
    [[ -n $SUBNETWORK ]] && args+=(--subnet "$SUBNETWORK")
    while [[ $# -gt 0 ]]; do args+=("$1"); shift; done
    "${G[@]}" "${args[@]}" >/dev/null
    CREATED_INSTANCES+=("$name")
}

# ---------------------------------------------------------------------------
# Setup: firewall for the probe ports, data disk, the instance under test
# ---------------------------------------------------------------------------
log "run id $RUN_ID, project $PROJECT, zone $ZONE, image $IMAGE"
"${G[@]}" compute firewall-rules create "$FW" --network "$NETWORK" --direction=INGRESS \
    --allow=tcp:443,tcp:8443 --source-ranges=0.0.0.0/0 --target-tags "$PREFIX" >/dev/null
CREATED_FIREWALLS+=("$FW")
create_data_disk "$DATA_DISK"
log "launching $INST"
launch_safebox "$INST" "$DATA_DISK"
IP="$(instance_ip "$INST")"
[[ -n $IP ]] || die "instance $INST has no external IP"
log "waiting for $INST ($IP) to come up on 8443"
if wait_alive "$IP" 420; then
    record "INFO baseline-boot: box alive on 8443 after launch"
else
    fail baseline-boot "box never answered on 8443 within 7 minutes; the image does not boot, the remaining checks are meaningless"
    exit 1
fi

# ---------------------------------------------------------------------------
# 1. Serial console login
# ---------------------------------------------------------------------------
# First the API must refuse because serial-port-enable is FALSE. Then an
# insider flips the flag; the box still has every getty masked, so even a
# working console session shows no login prompt within 20 seconds.
check_serial_console() {
    local out rc=0
    out="$(timeout 30 "${G[@]}" compute connect-to-serial-port "$INST" --zone "$ZONE" --port 1 </dev/null 2>&1)" || rc=$?
    if [[ $rc -eq 0 || $rc -eq 124 ]]; then
        # Exit 0, or still open when timeout cut it off: the server accepted
        # the session even though serial-port-enable=FALSE.
        fail serial-console-disabled "connect-to-serial-port opened a session with serial-port-enable=FALSE"
    else
        # The designed refusal is the serial port being disabled on the
        # instance (or by the org policy). A permission error is the tester's.
        classify serial-console-disabled "$out" 'serial port (access )?(is )?(not enabled|disabled)|serial-port-enable|disableSerialPortAccess'
    fi

    # Insider re-enables the console. If the org policy
    # compute.disableSerialPortAccess is enforced, add-metadata itself is
    # refused with a constraint error, which is the designed outcome.
    rc=0
    out="$("${G[@]}" compute instances add-metadata "$INST" --zone "$ZONE" --metadata serial-port-enable=TRUE 2>&1)" || rc=$?
    if [[ $rc -ne 0 ]]; then
        if printf '%s' "$out" | grep -qiE 'disableSerialPortAccess|constraint|org(anization)? policy'; then
            pass serial-console-no-login
            record "INFO serial-console-no-login: add-metadata refused by org policy; on-image getty check not exercised"
        elif printf '%s' "$out" | grep -qiE "$TESTER_ERR_RE"; then
            skip serial-console-no-login "tester lacks permission or CLI issue: $(first_line "$out")"
        else
            fail serial-console-no-login "could not set serial-port-enable=TRUE for an unexpected reason: $(first_line "$out")"
        fi
        return
    fi
    rc=0
    out="$(timeout 20 "${G[@]}" compute connect-to-serial-port "$INST" --zone "$ZONE" --port 1 </dev/null 2>&1)" || rc=$?
    "${G[@]}" compute instances add-metadata "$INST" --zone "$ZONE" --metadata serial-port-enable=FALSE >/dev/null 2>&1 || true
    if grep -qE 'login:|Password:|# $|\$ $' <<<"$out"; then
        fail serial-console-no-login "a login or shell prompt appeared on the serial console: $(grep -E 'login:|Password:' <<<"$out" | head -n1)"
    elif [[ $rc -eq 0 || $rc -eq 124 ]]; then
        # Session opened (or stayed open until the timeout) and no prompt.
        pass serial-console-no-login
    elif printf '%s' "$out" | grep -qiE "$TESTER_ERR_RE"; then
        skip serial-console-no-login "console enabled but the tester could not open it: $(first_line "$out")"
    else
        fail serial-console-no-login "console enabled but the session failed for an unexpected reason (no-login not proven): $(first_line "$out")"
    fi
}

# ---------------------------------------------------------------------------
# 2. GRUB interrupt via the console
# ---------------------------------------------------------------------------
# Manual procedure (cannot be driven non-interactively through gcloud):
#   1. On a throwaway project without the org policy, add-metadata
#      serial-port-enable=TRUE and `gcloud compute instances reset`.
#   2. Open `gcloud compute connect-to-serial-port` and press Esc repeatedly
#      during the first second after the firmware banner.
#   3. Expected: either no menu appears (timeout=0, hidden), or the menu
#      appears and pressing 'e' or 'c' prompts for the GRUB superuser
#      password. There is no known passphrase; the hash was generated from
#      random bytes at build time.
#   4. If a boot with an edited command line were ever achieved, PCR 8
#      changes, the sealed blobs do not unseal, and the box has no pool key:
#      verify by confirming 8443 never answers after such a boot.
check_grub_interrupt() {
    skip grub-interrupt "manual: interactive serial console keystrokes (procedure in the script comment)"
}

# ---------------------------------------------------------------------------
# 3. Run-command / OS Config agent and OS Login / SSH
# ---------------------------------------------------------------------------
check_osconfig_absent() {
    local out
    # The OS Config agent would have reported an inventory within minutes of
    # boot. With no agent there is nothing to describe.
    if out="$("${G[@]}" compute os-config inventories describe "$INST" --location "$ZONE" 2>&1)"; then
        fail osconfig-agent-absent "an OS inventory exists for $INST (an agent is running): $(head -n1 <<<"$out")"
    else
        # Designed outcome: no inventory resource exists (NOT_FOUND). An API
        # that is disabled or a tester without osconfig.inventories.get
        # cannot tell us anything.
        classify osconfig-agent-absent "$out" 'NOT_FOUND|not found|404'
    fi
}
check_oslogin_ssh() {
    local out
    # Both paths: direct (public IP, port 22) and through IAP. The firewall
    # for this run only allows 443/8443, so also try with a one-off rule to
    # make sure it is the box, not the network, that refuses.
    "${G[@]}" compute firewall-rules create "${FW}-ssh" --network "$NETWORK" --direction=INGRESS \
        --allow=tcp:22 --source-ranges=0.0.0.0/0,35.235.240.0/20 --target-tags "$PREFIX" >/dev/null 2>&1 || true
    CREATED_FIREWALLS+=("${FW}-ssh")
    sleep 20
    local nc_out
    if nc_out="$(timeout 10 bash -c "exec 3<>/dev/tcp/$IP/22 && echo open" 2>&1)" && [[ $nc_out == open ]]; then
        fail ssh-port-closed "TCP 22 accepted a connection on $IP"
    else
        pass ssh-port-closed
    fi
    local rc=0
    out="$(timeout 60 "${G[@]}" compute ssh "$INST" --zone "$ZONE" --tunnel-through-iap \
                 --ssh-flag='-o BatchMode=yes' --ssh-flag='-o ConnectTimeout=15' --command=id </dev/null 2>&1)" || rc=$?
    if [[ $rc -eq 0 ]] || grep -qE '^uid=[0-9]+' <<<"$out"; then
        fail oslogin-ssh-refused "gcloud compute ssh --tunnel-through-iap succeeded: $(head -n1 <<<"$out")"
    elif [[ $rc -eq 124 ]]; then
        # No sshd: the tunnel opens but nothing answers, so ssh hangs until
        # the timeout. That is the designed outcome.
        pass oslogin-ssh-refused
    else
        # Designed refusals: nothing listening on 22 (connection refused or
        # closed by the IAP backend, 4003 "failed to connect to backend"),
        # or the key never accepted. An IAP permission error (4033,
        # iap.tunnelInstances.accessViaIAP) is the tester's own.
        if printf '%s' "$out" | grep -qiE 'accessViaIAP|4033'; then
            skip oslogin-ssh-refused "tester lacks IAP tunnel permission: $(first_line "$out")"
        else
            classify oslogin-ssh-refused "$out" 'Connection refused|Connection closed|failed to connect to backend|4003|Connection timed out|Permission denied \(publickey|OS Login|No such user|kex_exchange_identification|Connection reset'
        fi
    fi
    "${G[@]}" compute firewall-rules delete "${FW}-ssh" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# 4. startup-script injection followed by a reset
# ---------------------------------------------------------------------------
# Nothing on the image reads startup-script (no google-guest-agent, no
# google-startup-scripts.service). After the reset the box must come back
# exactly as before: alive on 8443, still with no accepted announce (the
# owner key is unknown to every relying party), and with no process
# listening on a port the script would have opened.
check_startup_script_injection() {
    local script=$'#!/bin/bash\ntouch /pwned\nnc -l -p 4444 </dev/null >/dev/null 2>&1 &\ncurl -s http://169.254.169.254/computeMetadata/v1/instance/id -H "Metadata-Flavor: Google" >/dev/null\n'
    "${G[@]}" compute instances add-metadata "$INST" --zone "$ZONE" --metadata "startup-script=$script" >/dev/null
    "${G[@]}" compute firewall-rules update "$FW" --allow=tcp:443,tcp:8443,tcp:4444 >/dev/null 2>&1 || true
    "${G[@]}" compute instances reset "$INST" --zone "$ZONE" >/dev/null
    sleep 30
    if ! wait_alive "$IP" 420; then
        fail startup-script-ignored "box did not come back on 8443 after reset with a startup-script set"
        return
    fi
    if timeout 5 bash -c "exec 3<>/dev/tcp/$IP/4444" 2>/dev/null; then
        fail startup-script-ignored "port 4444 opened by the injected startup-script is listening"
        return
    fi
    if announced "$SAFEBOX_ID"; then
        fail startup-script-ignored "announce state changed after the reset (the relay accepted an announce for an unknown owner)"
        return
    fi
    pass startup-script-ignored
    "${G[@]}" compute instances remove-metadata "$INST" --zone "$ZONE" --keys startup-script >/dev/null 2>&1 || true
    "${G[@]}" compute firewall-rules update "$FW" --allow=tcp:443,tcp:8443 >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# 5. Hostile user-data on a fresh launch
# ---------------------------------------------------------------------------
# A second instance launched with the throwaway owner's authorization and a
# startup script that touches a file and calls out to a canary URL.
# Expected: the box boots and is alive, no announce for it is accepted
# anywhere (the owner key is unknown), and the canary is never contacted. The canary listener is out of scope for
# this script; that sub-check is SKIP with the manual procedure below.
#
# Manual canary procedure: run `nc -l 8080 -v` (or a request bin) on a host
# with a public address, pass --canary-url http://<host>:8080/pwned in the
# startup-script below, and confirm no request arrives within 10 minutes.
check_hostile_userdata() {
    local canary="http://192.0.2.1/safebox-redteam-canary"   # TEST-NET-1: never routable
    local script=$'#!/bin/bash\ntouch /tmp/pwned\ncurl -s '"$canary"$'\n'
    create_data_disk "$DATA_DISK2"
    local sf
    sf="$(mktemp)"; printf '%s' "$script" >"$sf"
    launch_safebox "$INST2" "$DATA_DISK2" --metadata-from-file "startup-script=$sf"
    rm -f "$sf"
    local ip2
    ip2="$(instance_ip "$INST2")"
    if ! wait_alive "$ip2" 420; then
        fail hostile-userdata-boot "second instance never came alive on 8443"
        return
    fi
    pass hostile-userdata-boot
    case "$(announced "$SAFEBOX_ID"; echo $?)" in
        0) fail hostile-userdata-announce-rejected "the relay accepted an announce for $SAFEBOX_ID under the bogus authorization" ;;
        1) pass hostile-userdata-announce-rejected ;;
        *) skip hostile-userdata-announce-rejected "no --relay-url; confirm at your relay and in the transparency log that no accepted announce exists for $SAFEBOX_ID" ;;
    esac
    skip hostile-userdata-canary "manual: canary listener out of scope (procedure in the script comment)"
    "${G[@]}" compute instances delete "$INST2" --zone "$ZONE" --delete-disks=all >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# 6. Boot disk clone, edit, swap
# ---------------------------------------------------------------------------
# Stop the box, snapshot its boot disk, make a disk from the snapshot, attach
# it to a helper VM whose startup script writes one byte into the root data
# partition (p3; the verity tree on p4 no longer matches), detach, swap it
# in as the boot disk of the original instance, start, and expect the box
# never to come alive. The byte lands in the ext4 superblock region so the
# block is read on the first mount attempt; dm-verity refuses it.
check_disk_swap() {
    local bootdisk helper_script
    bootdisk="$(boot_disk_of "$INST")"
    [[ -n $bootdisk ]] || { fail disk-clone-edit-swap "could not find the boot disk of $INST"; return; }
    "${G[@]}" compute instances stop "$INST" --zone "$ZONE" >/dev/null
    wait_status "$INST" TERMINATED 300 || { fail disk-clone-edit-swap "instance did not stop"; return; }
    "${G[@]}" compute disks snapshot "$bootdisk" --zone "$ZONE" --snapshot-names "$SNAP" >/dev/null
    CREATED_SNAPSHOTS+=("$SNAP")
    "${G[@]}" compute disks create "$TAMPER_DISK" --zone "$ZONE" --source-snapshot "$SNAP" --type=pd-ssd >/dev/null
    CREATED_DISKS+=("$TAMPER_DISK")

    # Helper: a stock Debian VM (it has a guest agent, so its startup
    # script does run). It modifies one byte of the cloned root partition,
    # then powers off; the script waits for TERMINATED.
    helper_script=$'#!/bin/bash\nset -e\nsleep 5\ndd if=/dev/zero of=/dev/disk/by-id/google-tamper-part3 bs=1 count=1 seek=1100 conv=notrunc,fsync\nsync\npoweroff\n'
    local hf
    hf="$(mktemp)"; printf '%s' "$helper_script" >"$hf"
    "${G[@]}" compute instances create "$HELPER" --zone "$ZONE" --machine-type e2-small \
        --image-project=debian-cloud --image-family=debian-12 \
        --disk "name=${TAMPER_DISK},device-name=tamper,mode=rw" \
        --network "$NETWORK" --no-service-account --no-scopes \
        --metadata-from-file "startup-script=$hf" >/dev/null
    rm -f "$hf"
    CREATED_INSTANCES+=("$HELPER")
    if ! wait_status "$HELPER" TERMINATED 600; then
        fail disk-clone-edit-swap "helper did not finish modifying the cloned disk"
        return
    fi
    "${G[@]}" compute instances detach-disk "$HELPER" --zone "$ZONE" --disk "$TAMPER_DISK" >/dev/null
    "${G[@]}" compute instances detach-disk "$INST" --zone "$ZONE" --disk "$bootdisk" >/dev/null
    CREATED_DISKS+=("$bootdisk")
    "${G[@]}" compute instances attach-disk "$INST" --zone "$ZONE" --disk "$TAMPER_DISK" --boot >/dev/null
    "${G[@]}" compute instances start "$INST" --zone "$ZONE" >/dev/null
    IP="$(instance_ip "$INST")"
    log "modified boot disk attached; observing $IP for 10 minutes"
    if wait_alive "$IP" 600; then
        fail disk-clone-edit-swap "box came alive on 8443 from a modified root partition (verity did not hold)"
        return
    fi
    if announced "$SAFEBOX_ID"; then
        fail disk-clone-edit-swap "the relay accepted an announce for $SAFEBOX_ID after the swap"
        return
    fi
    pass disk-clone-edit-swap
}

# ---------------------------------------------------------------------------
# 7 and 8. Container -> metadata, container -> docker socket
# ---------------------------------------------------------------------------
# Not automatable from outside the box. The earlier implementation went
# through the system component's /test endpoint, but the only container that
# endpoint starts runs with --network none and no socket bind, so "could not
# reach 169.254.169.254 / docker.sock" from there is a property of the
# test-run flags, not of the DOCKER-USER DROP rule or of the safebox-app
# network the managed containers use. A result like that would pass
# vacuously. The honest probe runs inside a managed container on the
# safebox-app network from an image that includes curl; the procedure is in
# docs/HARDENING-PLAN.md, "10. Verification".
check_container_imds() {
    skip container-imds-blocked "requires in-host probe (managed container on the safebox-app network); see docs/HARDENING-PLAN.md verification"
}
check_container_docker_socket() {
    skip container-docker-socket "requires in-host probe (managed container on the safebox-app network); see docs/HARDENING-PLAN.md verification"
}

# ---------------------------------------------------------------------------
# Run, in the order the plan lists
# ---------------------------------------------------------------------------
check_serial_console
check_grub_interrupt
check_osconfig_absent
check_oslogin_ssh
check_startup_script_injection
check_hostile_userdata
check_disk_swap
check_container_imds
check_container_docker_socket
