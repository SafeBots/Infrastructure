#!/usr/bin/env bash
#
# tests/redteam/aws.sh <image-id> [options]
#
# Adversarial test of a candidate Safebox AMI. It creates throwaway EC2
# resources (all named/tagged safebox-redteam-*), really performs each attack
# from docs/HARDENING-PLAN.md "Red team tests", and prints:
#
#   PASS <name>        the attack failed as it must
#   FAIL <name>: ...   the attack succeeded, or it failed for a reason that
#                      is not the designed refusal (so nothing was proven)
#   SKIP <name>: ...   needs a credential/listener not provided here, or the
#                      cloud refused the TESTER (AccessDenied and friends),
#                      which says nothing about the box
#
# A non-zero exit from an attack command is never a PASS by itself. Each
# check names the refusal it expects (SerialConsoleAccessDisabled,
# InvalidInstanceId, ...) and classifies anything else as SKIP (the tester's
# own permissions or CLI) or FAIL (unexplained).
#
# It exits non-zero if any check FAILs. A trap terminates every instance,
# volume, snapshot, and security group it created, on any exit.
#
# Required:
#   <image-id>                 AMI to test
#   --subnet-id <subnet>       subnet to launch throwaway instances in
# Optional:
#   --region <region>          default: from `aws configure get region`
#   --instance-type <type>     default: m5.large (Nitro, NitroTPM)
#   --relay-url <url>          base URL of a DNS relay (tools/dns-relay) the image's
#                              defaults.json names; GET <url>/announces/<id> is the
#                              oracle for "this box's announce was accepted"
#   --helper-ami <ami>         shell-capable AL2023 AMI for the disk-swap dd step
#   --helper-key <file.pem>    SSH key for the helper (its own key pair)
#
# The container->IMDS and container->docker-socket checks cannot be driven
# from outside the box: the only container the system component will start
# for a caller is a test container with --network none and no socket bind,
# which proves nothing about the DOCKER-USER rule or the safebox-app network.
# They SKIP with a pointer to the in-host procedure in docs/HARDENING-PLAN.md.

set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

die() { echo "redteam: FATAL: $*" >&2; exit 2; }

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
IMAGE_ID="${1:-}"
[ -n "$IMAGE_ID" ] || die "usage: aws.sh <image-id> --subnet-id <subnet> [options]"
shift || true

REGION=""
SUBNET_ID=""
INSTANCE_TYPE="m5.large"
RELAY_URL=""
HELPER_AMI=""      # a shell-capable AL2023 AMI used only to dd into the clone
HELPER_KEY=""      # SSH private key file for the helper (its own key pair)

while [ "$#" -gt 0 ]; do
    case "$1" in
        --region)        REGION="${2:-}"; shift 2 ;;
        --helper-ami)    HELPER_AMI="${2:-}"; shift 2 ;;
        --helper-key)    HELPER_KEY="${2:-}"; shift 2 ;;
        --subnet-id)     SUBNET_ID="${2:-}"; shift 2 ;;
        --instance-type) INSTANCE_TYPE="${2:-}"; shift 2 ;;
        --relay-url)     RELAY_URL="${2:-}"; shift 2 ;;
        *) die "unknown argument: $1" ;;
    esac
done

[ -n "$SUBNET_ID" ] || die "--subnet-id is required"
command -v aws >/dev/null || die "aws CLI not found"
command -v jq  >/dev/null || die "jq not found"
command -v ssh-keygen >/dev/null || die "ssh-keygen not found"
[ -n "$REGION" ] || REGION="$(aws configure get region 2>/dev/null || true)"
[ -n "$REGION" ] || die "no region (pass --region or set a default in aws config)"

AWS=(aws --region "$REGION")
PREFIX="safebox-redteam-$$"
WORK="$(mktemp -d)"

# ---------------------------------------------------------------------------
# Resource tracking and teardown
# ---------------------------------------------------------------------------
CREATED_INSTANCES=()
CREATED_VOLUMES=()
CREATED_SNAPSHOTS=()
CREATED_SGS=()

cleanup() {
    local rc=$? r
    set +e
    rm -rf "${WORK:-}"
    echo "redteam: cleaning up created resources" >&2
    if [ "${#CREATED_INSTANCES[@]}" -gt 0 ]; then
        "${AWS[@]}" ec2 terminate-instances --instance-ids "${CREATED_INSTANCES[@]}" >/dev/null 2>&1
        "${AWS[@]}" ec2 wait instance-terminated --instance-ids "${CREATED_INSTANCES[@]}" >/dev/null 2>&1
    fi
    for r in "${CREATED_VOLUMES[@]:-}"; do
        [ -n "$r" ] && "${AWS[@]}" ec2 delete-volume --volume-id "$r" >/dev/null 2>&1
    done
    for r in "${CREATED_SNAPSHOTS[@]:-}"; do
        [ -n "$r" ] && "${AWS[@]}" ec2 delete-snapshot --snapshot-id "$r" >/dev/null 2>&1
    done
    for r in "${CREATED_SGS[@]:-}"; do
        [ -n "$r" ] && "${AWS[@]}" ec2 delete-security-group --group-id "$r" >/dev/null 2>&1
    done
    exit "$rc"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Result bookkeeping
# ---------------------------------------------------------------------------
RESULTS=()
FAILED=0
pass() { echo "PASS $1"; RESULTS+=("PASS $1"); }
fail() { echo "FAIL $1: ${2:-}"; RESULTS+=("FAIL $1: ${2:-}"); FAILED=1; }
skip() { echo "SKIP $1: ${2:-}"; RESULTS+=("SKIP $1: ${2:-}"); }

# Errors that mean the TESTER was refused or misused the CLI. They say nothing
# about the box, so a check that sees one is SKIP, never PASS.
TESTER_ERR_RE='AccessDenied|UnauthorizedOperation|Unauthorized|Forbidden|NotAuthorized|InsufficientPermissions|is not authorized|not authorized to|AuthFailure|ExpiredToken|InvalidClientTokenId|RequestExpired|\b40[13]\b|Unable to locate credentials|Invalid choice|unknown options|Unknown options|argument .* invalid|usage: aws|command not found|ValidationException'
first_line() { printf '%s' "$1" | grep -v '^[[:space:]]*$' | head -n1 | head -c 200; }
# classify <name> <output> <expected-refusal-regex>
# PASS when the output shows the refusal the design predicts, SKIP when it
# shows the tester being refused, FAIL otherwise (the attack did not fail for
# the designed reason, so the control is unproven).
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
# Minimal SG allowing only egress (so the throwaway box can try to announce but
# nothing can reach it). Returns the group id.
make_sg() {
    local vpc gid
    vpc="$("${AWS[@]}" ec2 describe-subnets --subnet-ids "$SUBNET_ID" \
        --query 'Subnets[0].VpcId' --output text)"
    gid="$("${AWS[@]}" ec2 create-security-group \
        --group-name "${PREFIX}-sg-$RANDOM" \
        --description "safebox redteam throwaway" \
        --vpc-id "$vpc" --query 'GroupId' --output text)" || die "create-security-group failed"
    CREATED_SGS+=("$gid")
    echo "$gid"
}

# A throwaway owner key and a launch authorization signed with it: well
# formed, so the first-boot unit accepts it and the box boots and announces,
# but no relying party knows the key (run the relay with --owners), so no
# announce is accepted anywhere. Without node on the tester, fall back to
# junk base64 (the box then never starts dnsclient).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BOGUS_OWNER="$(printf 'a%.0s' {1..64})"
make_bogus_auth() {
    # make_bogus_auth <safebox-id>: prints a base64 authorization for the id.
    local key
    if command -v node >/dev/null 2>&1; then
        key="$(mktemp)"
        BOGUS_OWNER="$(node "$REPO/tools/dns-relay/authorize.js" keygen "$key")"
        node "$REPO/tools/dns-relay/authorize.js" sign "$key" "$1" 4
        rm -f "$key"
    else
        printf 'x%.0s' {1..60} | base64 -w0
    fi
}

# launch_instance <safebox-id> <launch-authorization> [extra user-data script]
# Builds the metadata JSON object the firstboot unit expects (safebox-id,
# owner-pubkey, launch-authorization) and (optionally) appends a shell
# script, launches, records the id, and echoes it.
launch_instance() {
    local sid="$1" auth="$2" extra="${3:-}" sg ud iid
    sg="$(make_sg)"
    ud="$(jq -cn --arg s "$sid" --arg o "$BOGUS_OWNER" --arg a "$auth" \
        '{"safebox-id":$s,"owner-pubkey":$o,"launch-authorization":$a}')"
    # Optionally smuggle a shell script alongside the JSON: a real attacker
    # would try a cloud-init-style script. The box must ignore it.
    if [ -n "$extra" ]; then
        ud="$ud"$'\n'"$extra"
    fi
    iid="$("${AWS[@]}" ec2 run-instances \
        --image-id "$IMAGE_ID" \
        --instance-type "$INSTANCE_TYPE" \
        --subnet-id "$SUBNET_ID" \
        --security-group-ids "$sg" \
        --metadata-options 'HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled' \
        --user-data "$ud" \
        --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${PREFIX}-${sid}}]" \
        --query 'Instances[0].InstanceId' --output text)" || die "run-instances failed"
    CREATED_INSTANCES+=("$iid")
    echo "$iid"
}

# Poll the relay for an accepted announce. Returns 0 if one appears within
# <seconds>, 1 if none does. The relay answers 200 at /announces/<id> only
# after verifyAnnounce accepted a launch announce for that id, so a box that
# never announces, or whose announce fails verification, stays 404.
# SKIP-caller checks for RELAY_URL.
poll_announced() {
    local sid="$1" seconds="$2" deadline code
    deadline=$(( $(date +%s) + seconds ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
            "${RELAY_URL%/}/announces/$sid" 2>/dev/null || echo 000)"
        [ "$code" = "200" ] && return 0
        sleep 20
    done
    return 1
}

# ---------------------------------------------------------------------------
# Check 1: serial console login
# ---------------------------------------------------------------------------
check_serial_console() {
    local name="serial-console-login" iid out
    iid="$(launch_instance "rt-serial-$RANDOM" "$(printf 'x%.0s' {1..40})")"
    "${AWS[@]}" ec2 wait instance-running --instance-ids "$iid" >/dev/null 2>&1 || true
    # A real throwaway key: an empty key file makes the API answer
    # ValidationException about OUR argument, which is not a refusal of the
    # attack and must not count as one.
    ssh-keygen -q -t ed25519 -N '' -f "$WORK/serial_key" >/dev/null
    # Pushing a serial-console SSH key must be refused because the console is
    # disabled account-wide (SerialConsoleAccessDisabled). AccessDenied and
    # the like are the tester's problem, not evidence.
    if out="$("${AWS[@]}" ec2-instance-connect send-serial-console-ssh-public-key \
            --instance-id "$iid" --serial-port 0 \
            --ssh-public-key "file://$WORK/serial_key.pub" 2>&1)"; then
        # The account-level disable is missing. The on-image control (every
        # getty masked) must still hold: open the console for 20 s and look
        # for a login prompt.
        out="$(timeout 20 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
            -o BatchMode=yes -o ConnectTimeout=15 -i "$WORK/serial_key" \
            "${iid}.port0@serial-console.ec2-instance-connect.${REGION}.aws" </dev/null 2>&1 || true)"
        if printf '%s' "$out" | grep -qiE 'login:|Password:'; then
            fail "$name" "serial console is enabled for the account AND the box shows a login prompt"
        elif printf '%s' "$out" | grep -qiE 'Permission denied|Connection closed|Connection refused|Could not resolve'; then
            fail "$name" "key push succeeded but the console session could not be opened: $(first_line "$out")"
        else
            pass "$name"
            echo "redteam: WARN $name: account-level serial console access is ENABLED (INSTRUCTIONS.md says to disable it); no login prompt appeared in 20 s" >&2
        fi
    else
        classify "$name" "$out" 'SerialConsoleAccessDisabled'
    fi
}

# ---------------------------------------------------------------------------
# Check 2: GRUB interrupt over the console (manual)
# ---------------------------------------------------------------------------
check_grub_interrupt() {
    # Editing the GRUB command line requires a console session and interactive
    # keystrokes over the serial websocket, which cannot be driven
    # non-interactively here. The observable proxy is check_serial_console
    # (the console is disabled, so there is nothing to interrupt). Manual
    # procedure if the console were ever enabled:
    #   1. aws ec2-instance-connect send-serial-console-ssh-public-key ...
    #   2. ssh to serial-console.ec2-instance-connect.<region>.aws.amazonaws.com
    #   3. reboot the instance, press a key at GRUB -> expect the superuser
    #      password prompt (GRUB_TIMEOUT=0, password_pbkdf2). Adding
    #      init=/bin/bash to the cmdline changes PCR 8, so even a successful
    #      edit yields a box whose pool key will not unseal.
    skip "grub-interrupt" "manual: console is disabled (see check 1); PCR 8 covers the cmdline"
}

# ---------------------------------------------------------------------------
# Check 3: SSM command execution
# ---------------------------------------------------------------------------
check_ssm() {
    local name="ssm-send-command" iid out
    iid="$(launch_instance "rt-ssm-$RANDOM" "$(printf 'x%.0s' {1..40})")"
    "${AWS[@]}" ec2 wait instance-running --instance-ids "$iid" >/dev/null 2>&1 || true
    sleep 20
    # With no SSM agent the instance is not a managed instance, so send-command
    # must fail with InvalidInstanceId.
    if out="$("${AWS[@]}" ssm send-command \
            --instance-ids "$iid" \
            --document-name "AWS-RunShellScript" \
            --parameters 'commands=["id > /tmp/pwned"]' 2>&1)"; then
        fail "$name" "ssm send-command accepted (SSM agent present?)"
    else
        # InvalidInstanceId is the only refusal that means "not a managed
        # instance". Everything else is the tester or an unknown failure.
        classify "$name" "$out" 'InvalidInstanceId'
    fi
}

# ---------------------------------------------------------------------------
# Check 4: hostile user-data on a fresh launch
# ---------------------------------------------------------------------------
check_hostile_userdata() {
    local name="hostile-user-data" sid iid bogus
    sid="rt-hostile-$RANDOM"
    bogus="$(make_bogus_auth "$sid")"
    # A shell script smuggled next to the JSON; the box must not execute it.
    iid="$(launch_instance "$sid" "$bogus" '#!/bin/bash
touch /tmp/pwned; curl -s http://canary.invalid/redteam || true')"
    "${AWS[@]}" ec2 wait instance-running --instance-ids "$iid" >/dev/null 2>&1 || true

    if [ -z "$RELAY_URL" ]; then
        skip "$name-announce" "needs --relay-url to confirm no announce appears for the bogus authorization"
    elif poll_announced "$sid" 180; then
        fail "$name-announce" "an announce for the bogus authorization was accepted by the relay"
    else
        pass "$name-announce"
    fi
    # The canary listener that would prove no outbound script ran is out of
    # scope here (no controlled HTTP sink). Manual: run a listener on a public
    # IP, pass its URL in the script above, and confirm zero hits.
    skip "$name-canary" "manual: stand up a canary HTTP sink and confirm no request from the box"
}

# ---------------------------------------------------------------------------
# Check 5: boot disk clone-edit-swap
# ---------------------------------------------------------------------------
check_disk_swap() {
    local name="disk-clone-edit-swap" sid iid root_vol snap new_vol az
    # Modifying a verity block requires a shell-capable helper (a plain AL2023
    # box) to dd into the clone's raw p3; a safebox helper has no shell. Without
    # one we cannot flip a byte, and an unflipped clone swapped back onto the
    # same TPM would legitimately boot, so the check would prove nothing.
    if [ -z "$HELPER_AMI" ] || [ -z "$HELPER_KEY" ]; then
        skip "$name" "needs --helper-ami (a shell-capable AL2023 AMI) and --helper-key to dd a byte into the clone's p3; manual: stop box, snapshot root, create volume from snap, attach to helper, 'dd if=/dev/zero of=<dev>p3 bs=512 count=1 seek=4096 conv=notrunc', detach, swap onto the original as /dev/xvda, start, and confirm no announce for it appears at the relay within 10 minutes"
        return
    fi
    if [ -z "$RELAY_URL" ]; then
        skip "$name" "needs --relay-url to observe that no announce appears for the swapped box"
        return
    fi

    sid="rt-swap-$RANDOM"
    iid="$(launch_instance "$sid" "$(make_bogus_auth "$sid")")"
    "${AWS[@]}" ec2 wait instance-running --instance-ids "$iid" >/dev/null 2>&1 || true
    az="$("${AWS[@]}" ec2 describe-instances --instance-ids "$iid" \
        --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text)"

    # Stop, find the root volume, snapshot and clone it.
    "${AWS[@]}" ec2 stop-instances --instance-ids "$iid" >/dev/null
    "${AWS[@]}" ec2 wait instance-stopped --instance-ids "$iid" >/dev/null 2>&1 || true
    # shellcheck disable=SC2016  # JMESPath backticks, not shell
    root_vol="$("${AWS[@]}" ec2 describe-instances --instance-ids "$iid" \
        --query 'Reservations[0].Instances[0].BlockDeviceMappings[?DeviceName==`/dev/xvda`].Ebs.VolumeId' \
        --output text)"
    [ -n "$root_vol" ] || { skip "$name" "could not find root volume"; return; }
    snap="$("${AWS[@]}" ec2 create-snapshot --volume-id "$root_vol" \
        --description "${PREFIX} swap test" --query 'SnapshotId' --output text)"
    CREATED_SNAPSHOTS+=("$snap")
    "${AWS[@]}" ec2 wait snapshot-completed --snapshot-ids "$snap" >/dev/null 2>&1 || true
    new_vol="$("${AWS[@]}" ec2 create-volume --availability-zone "$az" \
        --snapshot-id "$snap" --volume-type gp3 --query 'VolumeId' --output text)"
    CREATED_VOLUMES+=("$new_vol")
    "${AWS[@]}" ec2 wait volume-available --volume-ids "$new_vol" >/dev/null 2>&1 || true

    # Helper from a shell-capable AMI; attach the clone and flip one byte of p3
    # (the verity data partition). p3 cannot be mounted rw (verity), so we write
    # a raw byte well inside it; verity rejects that block at read time.
    local helper helper_ip
    helper="$("${AWS[@]}" ec2 run-instances --image-id "$HELPER_AMI" \
        --instance-type "$INSTANCE_TYPE" --subnet-id "$SUBNET_ID" \
        --security-group-ids "$(make_sg)" \
        --key-name "$(basename "${HELPER_KEY%.pem}")" \
        --metadata-options 'HttpTokens=required,HttpPutResponseHopLimit=1' \
        --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${PREFIX}-helper}]" \
        --query 'Instances[0].InstanceId' --output text)"
    CREATED_INSTANCES+=("$helper")
    "${AWS[@]}" ec2 wait instance-running --instance-ids "$helper" >/dev/null 2>&1 || true
    "${AWS[@]}" ec2 attach-volume --volume-id "$new_vol" --instance-id "$helper" \
        --device /dev/sdh >/dev/null 2>&1 || true
    sleep 20
    helper_ip="$("${AWS[@]}" ec2 describe-instances --instance-ids "$helper" \
        --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
    # The clone appears as a secondary NVMe device on the helper; p3 is its
    # third partition. Flip one byte deep inside it.
    if ! ssh -o StrictHostKeyChecking=no -o ConnectTimeout=20 -i "$HELPER_KEY" \
        "ec2-user@$helper_ip" \
        'd=$(lsblk -dpno NAME | grep -v nvme0 | head -n1); sudo dd if=/dev/zero of=${d}p3 bs=512 count=1 seek=4096 conv=notrunc' \
        >/dev/null 2>&1; then
        # Without the edit, swapping the clone back would boot legitimately and
        # a PASS would mean nothing; stop here.
        skip "$name" "could not dd into the clone on the helper (ssh/dd failed)"
        return
    fi
    "${AWS[@]}" ec2 detach-volume --volume-id "$new_vol" >/dev/null 2>&1 || true
    "${AWS[@]}" ec2 wait volume-available --volume-ids "$new_vol" >/dev/null 2>&1 || true

    # Swap the edited clone in as the original instance's root and boot it.
    "${AWS[@]}" ec2 detach-volume --volume-id "$root_vol" >/dev/null 2>&1 || true
    "${AWS[@]}" ec2 wait volume-available --volume-ids "$root_vol" >/dev/null 2>&1 || true
    "${AWS[@]}" ec2 attach-volume --volume-id "$new_vol" --instance-id "$iid" \
        --device /dev/xvda >/dev/null 2>&1 || true
    "${AWS[@]}" ec2 start-instances --instance-ids "$iid" >/dev/null 2>&1 || true

    if poll_announced "$sid" 600; then
        fail "$name" "an announce from the box with a cloned/edited root was accepted within 10 minutes"
    else
        pass "$name"
    fi
}

# ---------------------------------------------------------------------------
# Checks 6 & 7: container -> IMDS and container -> docker socket
# ---------------------------------------------------------------------------
# Not automatable from outside the box, and the earlier implementation was
# misleading: the system component's /test endpoint starts a container with
# --network none and no socket bind, so "could not reach IMDS/docker.sock"
# from there is true of the test-run flags, not of the DOCKER-USER rule or of
# the safebox-app network the managed containers actually use. The honest
# probe runs inside a managed container on the safebox-app network with an
# image that includes curl; the procedure is in docs/HARDENING-PLAN.md
# ("10. Verification"). Until that probe can be driven through the control
# plane, these are SKIP.
check_container_imds() {
    skip "container-to-imds" "requires in-host probe (managed container on the safebox-app network); see docs/HARDENING-PLAN.md verification"
}

check_container_docker_socket() {
    skip "container-to-docker-socket" "requires in-host probe (managed container on the safebox-app network); see docs/HARDENING-PLAN.md verification"
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
echo "redteam: image $IMAGE_ID in $REGION (throwaway prefix $PREFIX)" >&2
check_serial_console
check_grub_interrupt
check_ssm
check_hostile_userdata
check_disk_swap
check_container_imds
check_container_docker_socket

echo ""
echo "================ redteam summary ================"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "================================================="
[ "$FAILED" -eq 0 ] || { echo "redteam: one or more checks FAILED" >&2; exit 1; }
echo "redteam: all checks passed or skipped"
