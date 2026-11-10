#!/bin/bash
# compute-expected-pcrs.sh <boot-dir> <grub.cfg> <kernel> <initrd> [<stub-grub.cfg>]
#
# Computes the PCR 8 and PCR 9 values a box built from these inputs should
# show after GRUB has handed off to the kernel, and prints them as JSON:
#
#   {
#     "pcr8": "<64 hex>",          MODEL, see below
#     "pcr9": "<64 hex>",          exact
#     "inputs": {
#       "kernel": {"path": ..., "sha256": ...},
#       "initrd": {"path": ..., "sha256": ...},
#       "stubGrubCfg": {"path": ..., "sha256": ...},
#       "grubCfg": {"path": ..., "sha256": ...},
#       "cmdline": "<the kernel command line as the linux command carries it>",
#       "measuredCommands": ["<every command string folded into PCR 8>", ...]
#     }
#   }
#
# Called by build-verity-root.sh after grub.cfg is rendered; the result is
# recorded in manifests/verity.json as "expectedPcrs". Needs only sha256sum,
# xxd or od, and python3 (JSON output).
#
# HOW GRUB MEASURES (grub-core/kern/efi/tpm.c, commands/tpm.c, with the
# Ubuntu/Debian signed GRUB's "tpm" module loaded):
#
#   PCR 9: every file GRUB reads through its verifier framework while the
#          tpm module is active is measured as sha256(file contents) into
#          PCR 9. For this configuration those are exactly the kernel
#          (`linux` command) and the initramfs (`initrd` command), in that
#          order. So
#              PCR9 = extend(extend(0^32, sha256(kernel)), sha256(initrd))
#          with extend(a, b) = sha256(a || b). GRUB does not measure the
#          grub.cfg files into PCR 9 (configfile goes through the verifier
#          with GRUB_FILE_TYPE_CONFIG, which the tpm verifier skips), so the
#          value here is EXACT for any firmware and any shim, given the same
#          kernel and initrd bytes.
#
#   PCR 8: every command GRUB executes is measured as sha256 of the command
#          string ("grub_cmd: <text>") into PCR 8, in execution order, after
#          variable expansion. "Every command" includes the commands in the
#          config that is EMBEDDED in the signed grubx64.efi (the distro
#          builds one in that searches for the ESP's grub.cfg), the commands
#          in the ESP stub grub.cfg, and the commands in the measured
#          /boot/grub/grub.cfg, plus any that GRUB's own startup runs. The
#          embedded config differs per distro build of grubx64.efi and is
#          not an input to this script, and the exact prefix GRUB puts on
#          the measured string has changed across GRUB versions. The PCR 8
#          value printed here is therefore a MODEL of the straightforward
#          case (the two config files we control, each command taken as the
#          text of its line after our known variable substitutions), NOT a
#          promise. It exists so that an unexpected first-boot value can be
#          diffed against something, and so the build has a record of the
#          command set it intended. The authoritative PCR 8 (and 4, and 7)
#          are the ones the first hardware boot of the image records in
#          /boot/safebox/pcr-values.txt (copied to the pool as
#          /var/lib/safebox/boot/pcr-values-first-boot.txt); those confirmed
#          values are what the Safenet blessing pins for the image, after an
#          operator has checked that PCR 9 matches this script's exact value
#          and that the PCR 8 difference, if any, is explained by the
#          embedded config and the measurement prefix of the GRUB build.
#
# Model for PCR 8: for the stub grub.cfg (if given) and then the main
# grub.cfg, every non-empty, non-comment line in file order, trimmed, is
# one executed command, measured as its text with no prefix. The rendered
# grub.cfg already has the build's values for the root hash, kernel and
# initrd names and the password hash substituted, so the `linux` line is
# measured as the full command text the box will execute. Two places the
# model knowingly simplifies: "($root)" in the stub is left literal (GRUB
# expands it to the device name it found, which depends on the cloud's disk
# controller), and the menuentry block is listed once in file order rather
# than as GRUB's define-then-run sequence. Both are part of why the result
# is a model to be confirmed, not a value to be trusted.

set -euo pipefail

die() { echo "compute-expected-pcrs: FATAL: $*" >&2; exit 1; }

[ "$#" -ge 4 ] && [ "$#" -le 5 ] \
    || { echo "usage: $0 <boot-dir> <grub.cfg> <kernel> <initrd> [<stub-grub.cfg>]" >&2; exit 2; }
BOOT_DIR="$1"; GRUB_CFG="$2"; KERNEL="$3"; INITRD="$4"; STUB_CFG="${5:-}"

# Accept either absolute paths or names relative to <boot-dir>.
resolve() {
    local p="$1"
    if [ -f "$p" ]; then printf '%s\n' "$p"; return 0; fi
    if [ -f "$BOOT_DIR/$p" ]; then printf '%s\n' "$BOOT_DIR/$p"; return 0; fi
    die "file not found: $p (also tried under $BOOT_DIR)"
}
GRUB_CFG="$(resolve "$GRUB_CFG")"
KERNEL="$(resolve "$KERNEL")"
INITRD="$(resolve "$INITRD")"
[ -n "$STUB_CFG" ] && STUB_CFG="$(resolve "$STUB_CFG")"

for c in sha256sum python3; do
    command -v "$c" >/dev/null 2>&1 || die "host tool '$c' not found"
done

sha_file() { sha256sum "$1" | cut -d' ' -f1; }
sha_str()  { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

# extend(prev_hex, digest_hex) = sha256(prev || digest), both raw bytes.
extend() {
    local prev="$1" digest="$2"
    printf '%s%s' "$prev" "$digest" | python3 -c '
import sys, hashlib
print(hashlib.sha256(bytes.fromhex(sys.stdin.read().strip())).hexdigest())'
}

ZERO="0000000000000000000000000000000000000000000000000000000000000000"

# ---------------------------------------------------------------------------
# PCR 9 (exact)
# ---------------------------------------------------------------------------
KERNEL_SHA="$(sha_file "$KERNEL")"
INITRD_SHA="$(sha_file "$INITRD")"
PCR9="$(extend "$ZERO" "$KERNEL_SHA")"
PCR9="$(extend "$PCR9" "$INITRD_SHA")"

# ---------------------------------------------------------------------------
# PCR 8 (model)
# ---------------------------------------------------------------------------
# Commands in execution order, one per line, from the stub then the main
# config. Blank lines and comment lines are dropped; leading and trailing
# whitespace is trimmed.
commands_of() {
    local f="$1" line
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line#"${line%%[![:space:]]*}"}"
        line="${line%"${line##*[![:space:]]}"}"
        [ -z "$line" ] && continue
        case "$line" in \#*) continue ;; esac
        printf '%s\n' "$line"
    done < "$f"
}

CMDS_FILE="$(mktemp)"
trap 'rm -f "$CMDS_FILE"' EXIT
[ -n "$STUB_CFG" ] && commands_of "$STUB_CFG" >> "$CMDS_FILE"
commands_of "$GRUB_CFG" >> "$CMDS_FILE"

PCR8="$ZERO"
CMDLINE=""
while IFS= read -r cmd; do
    PCR8="$(extend "$PCR8" "$(sha_str "$cmd")")"
    case "$cmd" in
        linux\ *) CMDLINE="${cmd#linux }"; CMDLINE="${CMDLINE#* }" ;;
    esac
done < "$CMDS_FILE"
[ -n "$CMDLINE" ] || die "no 'linux' command found in $GRUB_CFG"

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
python3 - "$PCR8" "$PCR9" "$KERNEL" "$KERNEL_SHA" "$INITRD" "$INITRD_SHA" \
          "$GRUB_CFG" "$(sha_file "$GRUB_CFG")" \
          "$STUB_CFG" "$([ -n "$STUB_CFG" ] && sha_file "$STUB_CFG" || true)" \
          "$CMDLINE" "$CMDS_FILE" <<'EOF'
import json, sys, os
(pcr8, pcr9, kernel, ksha, initrd, isha, cfg, csha, stub, ssha, cmdline, cmds_file) = sys.argv[1:13]
with open(cmds_file) as fh:
    cmds = [l.rstrip("\n") for l in fh if l.strip()]
doc = {
    "schema": "safebox-expected-pcrs/1",
    "pcr8": pcr8,
    "pcr9": pcr9,
    "pcr8IsModel": True,
    "note": ("pcr9 is exact for these kernel and initrd bytes. pcr8 is a model of the "
             "commands in the two grub.cfg files we control and omits the embedded config "
             "of the signed grubx64.efi and GRUB's measurement prefix; confirm against the "
             "first hardware boot's pcr-values.txt before pinning."),
    "inputs": {
        "kernel": {"path": os.path.basename(kernel), "sha256": ksha},
        "initrd": {"path": os.path.basename(initrd), "sha256": isha},
        "grubCfg": {"path": cfg, "sha256": csha},
        "stubGrubCfg": ({"path": stub, "sha256": ssha} if stub else None),
        "cmdline": cmdline,
        "measuredCommands": cmds,
    },
}
json.dump(doc, sys.stdout, indent=2, sort_keys=True)
sys.stdout.write("\n")
EOF
