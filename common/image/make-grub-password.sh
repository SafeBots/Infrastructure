#!/bin/bash
# make-grub-password.sh - print a GRUB PBKDF2 password hash for the image.
#
# Reads the passphrase from $GRUB_PASSPHRASE if set, otherwise generates 32
# random bytes (base64) and uses those. Prints only the
# "grub.pbkdf2.sha512...." hash on stdout, suitable as the third argument of
# build-verity-root.sh.
#
# The passphrase is deliberately NOT printed or stored. On a production
# safebox nobody should ever need to get past GRUB: the root is a verity
# volume, /etc is volatile, and the pool key is sealed to the measured
# command line, so there is nothing an operator could usefully do from the
# GRUB prompt. A random passphrase that no one knows is the recommended
# choice; the hash still satisfies the "GRUB has a superuser password"
# check in verify-image.sh and stops casual `init=/bin/bash` edits.

set -euo pipefail

die() {
    echo "make-grub-password: FATAL: $*" >&2
    exit 1
}

TOOL=""
for t in grub2-mkpasswd-pbkdf2 grub-mkpasswd-pbkdf2; do
    if command -v "$t" >/dev/null 2>&1; then
        TOOL="$t"
        break
    fi
done
[ -n "$TOOL" ] || die "neither grub2-mkpasswd-pbkdf2 nor grub-mkpasswd-pbkdf2 is installed"

if [ -n "${GRUB_PASSPHRASE:-}" ]; then
    PASS="$GRUB_PASSPHRASE"
    SOURCE="GRUB_PASSPHRASE from the environment"
else
    PASS="$(head -c 32 /dev/urandom | base64 -w0)"
    SOURCE="32 random bytes"
fi

# The tool prompts twice on stdin ("Enter password:" / "Reenter password:")
# and prints "PBKDF2 hash of your password is grub.pbkdf2.sha512...." on
# stdout. Feed both lines and keep only the hash token.
HASH="$(printf '%s\n%s\n' "$PASS" "$PASS" | "$TOOL" 2>/dev/null \
    | sed -n 's/.*\(grub\.pbkdf2\.sha512\.[^[:space:]]*\).*/\1/p' | head -n1)"
unset PASS
[ -n "$HASH" ] || die "$TOOL did not produce a grub.pbkdf2.sha512 hash"

cat >&2 <<EOF
make-grub-password: WARNING: the GRUB passphrase (${SOURCE}) is intentionally not stored or printed anywhere.
make-grub-password: Nobody should ever need to unlock GRUB on a production image; a random passphrase is the recommended choice.
make-grub-password: If you set GRUB_PASSPHRASE yourself, you are responsible for not writing it down.
EOF

printf '%s\n' "$HASH"
