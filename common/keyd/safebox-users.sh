#!/usr/bin/env bash
# /opt/safebox/keyd/safebox-users.sh
#
# Creates the per-tenant instance users. /etc is a tmpfs overlay on the
# read-only verity root, so every account that is not baked into the image
# vanishes at reboot and has to be recreated before the tenant instances
# start. This script reads /var/lib/safebox/managed-containers.json and, for
# every declared container with an instanceUid, runs
#
#   useradd -r -u <instanceUid> -g safebox-sys -s /usr/sbin/nologin \
#           -d /nonexistent safebox-sys-<name>
#
# idempotently: an existing user with the right uid is left alone, an
# existing user with a different uid is an error (the box is inconsistent and
# the instance must not start as the wrong uid). It also creates the
# instance's state directory /var/lib/safebox/tenants/<name> (0750
# <uid>:safebox-sys) when it is missing.
#
# Runs as root from safebox-users.service at boot (before safebox-keyd and
# the instances) and from the root wrapper safebox-instance after the
# operator declares a new container. Takes no arguments; nothing it does is
# caller-controlled beyond the JSON file the operator writes, and every
# value from that file is validated against a fixed pattern or range before
# it reaches useradd. See docs/HARDENING-PLAN.md, "Per-tenant isolation".

set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 022

readonly CONFIG=${SAFEBOX_USERS_CONFIG:-/var/lib/safebox/managed-containers.json}
readonly STATE_ROOT=${SAFEBOX_USERS_STATE_ROOT:-/var/lib/safebox/tenants}
readonly SYS_GROUP=safebox-sys
readonly SYS_GID=993
readonly UID_MIN=20000
readonly UID_MAX=29999
readonly RE_NAME='^[a-z0-9-]{1,40}$'
NOLOGIN=$(command -v nologin || echo /usr/sbin/nologin)

die() { printf 'safebox-users: %s\n' "$*" >&2; exit 1; }

[[ $# -eq 0 ]] || die "takes no arguments"
[[ $EUID -eq 0 ]] || die "must run as root"

getent group "$SYS_GROUP" >/dev/null || groupadd --system --gid "$SYS_GID" "$SYS_GROUP"
[[ "$(getent group "$SYS_GROUP" | cut -d: -f3)" == "$SYS_GID" ]] || die "$SYS_GROUP must be gid $SYS_GID"

install -d -m 0751 -o root -g root "$STATE_ROOT"

if [[ ! -f $CONFIG ]]; then
    printf 'safebox-users: %s absent; no tenants to create\n' "$CONFIG"
    exit 0
fi

# One "<name> <uid>" line per declared tenant. node is on the image (the
# system component needs it) and is the only JSON parser available there.
mapfile -t tenants < <(node -e '
    const fs = require("fs");
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
    catch (e) { process.stderr.write("safebox-users: cannot parse config: " + e.message + "\n"); process.exit(1); }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) process.exit(1);
    for (const [name, e] of Object.entries(cfg)) {
        if (name.startsWith("_") || !e || typeof e !== "object" || e.execContext === "host") continue;
        if (!Number.isInteger(e.instanceUid)) continue;
        process.stdout.write(name + " " + e.instanceUid + "\n");
    }
' "$CONFIG")

created=0
for line in "${tenants[@]}"; do
    name=${line%% *}
    uid=${line##* }
    [[ $name =~ $RE_NAME ]] || die "tenant name '$name' is not wrapper-valid"
    if ! [[ $uid =~ ^[0-9]+$ ]] || (( uid < UID_MIN || uid > UID_MAX )); then
        die "instanceUid '$uid' for '$name' is out of range"
    fi
    user="safebox-sys-$name"
    if existing=$(getent passwd "$user"); then
        have=$(printf '%s' "$existing" | cut -d: -f3)
        [[ $have == "$uid" ]] || die "$user exists with uid $have, config says $uid"
    else
        if taken=$(getent passwd "$uid"); then
            die "uid $uid is already taken by $(printf '%s' "$taken" | cut -d: -f1)"
        fi
        useradd --system --uid "$uid" --gid "$SYS_GROUP" --no-create-home \
            --home-dir /nonexistent --shell "$NOLOGIN" \
            --comment "Safebox tenant instance $name" "$user"
        created=$((created + 1))
    fi
    # The instance's own state directory on the pool. Never followed if
    # something else is there: install refuses to replace a non-directory.
    if [[ -L "$STATE_ROOT/$name" ]]; then
        die "$STATE_ROOT/$name is a symlink"
    fi
    install -d -m 0750 -o "$uid" -g "$SYS_GROUP" "$STATE_ROOT/$name"
done
printf 'safebox-users: %d tenant(s) declared, %d user(s) created\n' "${#tenants[@]}" "$created"
