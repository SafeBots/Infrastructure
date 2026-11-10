#!/usr/bin/env bash
# safebox-firstboot.sh - replacement for cloud-init (HARDENING-PLAN.md, fix 2,
# first-boot sequence step 4).
#
# Runs once as root from safebox-firstboot.service. Detects the cloud from DMI,
# reads exactly three named values from the metadata service (safebox-id,
# owner-pubkey and launch-authorization), validates their shape, writes
# /var/lib/safebox/dns/dnsclient.json owned by safebox-dns (uid 992), and
# exits. Where the box announces itself (dnsRelays, safenetLogs) comes only
# from the image's /etc/safebox/defaults.json; there is no metadata override,
# so nobody who can set instance metadata can point a box at a relay of
# their choosing. It never executes anything it reads, never creates users,
# never installs keys. Hostile user-data is inert.
#
# The launch authorization is an OCP claim signed by the owner's Safenet
# key, base64 in metadata. This script checks its shape with jq (type,
# safeboxId and ownerPubkey agree with the other two keys, window at most
# 24 h); the signature is verified by dnsclient before the first announce
# and again by every relying party. Nothing in the metadata is a secret:
# anyone who reads it later gets a public key and a signed statement that
# expires within a day.
#
# Failure mode: if any required value is missing or invalid, this script logs
# the reason to the journal and exits 1. The unit fails, the box stays up, and
# it never announces: safebox-dnsclient refuses to start without a valid
# config. Fix the launch metadata and reboot, or re-run the unit. Nothing is
# left half-written because the config file is written atomically (temp + mv).
#
# Idempotent: re-running overwrites dnsclient.json with the same content. It
# does NOT create /var/lib/safebox/dns/announced; that marker is written by
# dnsclient after its first announce has been delivered, and its presence is
# what stops this unit from running again (ConditionPathExists=!... in the
# unit).
#
# /var/lib/safebox/dns is normally created by the initramfs unseal script on
# the dataset at first boot (0750 safebox-dns:safebox-dns). It is created
# here too if missing, with the same owner and mode, so a pool initialised
# by an older image still works.

set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 027

readonly POOL_DIR=/var/lib/safebox
readonly STATE_DIR="$POOL_DIR/dns"
readonly OUT_FILE="$STATE_DIR/dnsclient.json"
# Copy of the identifying fields for other services (autovhost, uid 990,
# needs the cloud name for public-IP discovery and cannot read dnsclient.json,
# which is owned by safebox-dns).
readonly INSTANCE_FILE="$POOL_DIR/instance.json"
readonly DEFAULTS_FILE=/etc/safebox/defaults.json
readonly IMDS=169.254.169.254
readonly DNS_USER=safebox-dns
readonly DNS_UID=992
readonly DNS_GID=992

# Validation patterns from the implementation contract.
readonly RE_ID='^[a-z0-9-]{3,64}$'
readonly RE_PUBKEY='^[0-9a-f]{64}$'
readonly RE_B64='^[A-Za-z0-9+/=_-]{64,8192}$'
readonly MAX_AUTH_SECONDS=86400

log() { printf 'safebox-firstboot: %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Fetch a URL with retries. Metadata services can be slow or unreachable in
# the first seconds after boot, so retry 10 times with a 3s sleep. Output goes
# to stdout; returns non-zero after the last failed attempt. Arguments after
# the URL are extra curl options (headers, method).
fetch() {
    local url=$1; shift
    local out
    for _ in $(seq 1 10); do
        if out=$(curl --silent --show-error --fail --max-time 5 "$@" "$url" 2>/dev/null); then
            printf '%s' "$out"
            return 0
        fi
        sleep 3
    done
    log "metadata fetch failed after 10 attempts: $url"
    return 1
}

dmi() {
    # DMI files may be absent on some hypervisors; treat absence as empty.
    local f="/sys/class/dmi/id/$1"
    if [[ -r $f ]]; then tr -d '\n' <"$f"; fi
}

detect_cloud() {
    local vendor product asset board
    vendor=$(dmi sys_vendor)
    product=$(dmi product_name)
    asset=$(dmi chassis_asset_tag)
    board=$(dmi board_vendor)

    if [[ $vendor == "Amazon EC2" ]]; then
        echo aws; return
    fi
    if [[ $vendor == "Google" || $product == "Google Compute Engine" ]]; then
        echo gcp; return
    fi
    # Azure: the asset tag is the stable signal; the vendor string alone is
    # shared with Hyper-V on-prem.
    if [[ $vendor == "Microsoft Corporation" && $asset == "7783-7084-3265-9085-8269-3286-77" ]]; then
        echo azure; return
    fi
    # OCI: vendor is QEMU on older shapes and OracleCloud on newer ones; the
    # product name follows the shape family. Confirm by asking the OCI IMDS,
    # which requires the Oracle bearer header and answers nothing otherwise.
    if [[ $board == "QEMU" || $board == "OracleCloud" || $vendor == "OracleCloud.com" \
          || $product == VM.Standard* || $product == BM.Standard* || $product == VM.Optimized* ]]; then
        if curl --silent --fail --max-time 5 -H 'Authorization: Bearer Oracle' \
                "http://$IMDS/opc/v2/instance/id" >/dev/null 2>&1; then
            echo oci; return
        fi
    fi
    echo unknown
}

# Each fetcher prints a JSON object with the three keys (missing keys
# allowed) to stdout. Everything is parsed with jq -r; nothing is eval'd.
fetch_aws() {
    local token
    token=$(fetch "http://$IMDS/latest/api/token" -X PUT \
                -H 'X-aws-ec2-metadata-token-ttl-seconds: 60') || return 1
    fetch "http://$IMDS/latest/user-data" -H "X-aws-ec2-metadata-token: $token"
}

fetch_gcp() {
    local base="http://$IMDS/computeMetadata/v1/instance/attributes"
    local k v json='{}'
    for k in safebox-id owner-pubkey launch-authorization; do
        # A missing attribute is a 404; all three keys are required, and the
        # caller validates. Try once per key: the root probe in main() has
        # already waited for the metadata service to come up.
        if v=$(curl --silent --fail --max-time 5 -H 'Metadata-Flavor: Google' "$base/$k" 2>/dev/null); then
            json=$(jq -cn --argjson j "$json" --arg k "$k" --arg v "$v" '$j + {($k): $v}')
        fi
    done
    printf '%s' "$json"
}

fetch_azure() {
    local b64
    b64=$(fetch "http://$IMDS/metadata/instance/compute/userData?api-version=2021-01-01&format=text" \
              -H 'Metadata: true') || return 1
    printf '%s' "$b64" | base64 -d
}

fetch_oci() {
    local base="http://$IMDS/opc/v2/instance/metadata"
    local k v json='{}'
    for k in safebox-id owner-pubkey launch-authorization; do
        if v=$(curl --silent --fail --max-time 5 -H 'Authorization: Bearer Oracle' "$base/$k" 2>/dev/null); then
            json=$(jq -cn --argjson j "$json" --arg k "$k" --arg v "$v" '$j + {($k): $v}')
        fi
    done
    printf '%s' "$json"
}

main() {
    [[ $EUID -eq 0 ]] || die "must run as root"
    command -v jq >/dev/null || die "jq not installed"
    command -v curl >/dev/null || die "curl not installed"
    [[ -d $POOL_DIR ]] || die "$POOL_DIR does not exist (pool not mounted?)"
    mountpoint -q "$POOL_DIR" || die "$POOL_DIR is not a mountpoint (pool not mounted?)"
    [[ "$(id -u "$DNS_USER")" == "$DNS_UID" ]] || die "$DNS_USER is not uid $DNS_UID"
    if [[ ! -d $STATE_DIR ]]; then
        install -d -m 0750 -o "$DNS_UID" -g "$DNS_GID" "$STATE_DIR" || die "could not create $STATE_DIR"
        log "created $STATE_DIR"
    fi

    local cloud
    cloud=$(detect_cloud)
    log "detected cloud: $cloud"
    [[ $cloud != unknown ]] || die "could not identify cloud from DMI"

    # Wait for the metadata service itself before asking for anything. For
    # AWS and Azure the per-key fetch already retries; for GCP and OCI the
    # per-key loop is single-shot, so probe the root once with retries.
    case $cloud in
        gcp) fetch "http://$IMDS/computeMetadata/v1/instance/id" -H 'Metadata-Flavor: Google' >/dev/null || die "GCP metadata unreachable" ;;
        oci) fetch "http://$IMDS/opc/v2/instance/id" -H 'Authorization: Bearer Oracle' >/dev/null || die "OCI metadata unreachable" ;;
    esac

    local raw
    raw=$("fetch_$cloud") || die "metadata fetch failed"
    # Validate that it is a JSON object before extracting; jq -e fails on
    # anything else, including a shell script someone passed as user-data.
    printf '%s' "$raw" | jq -e 'type == "object"' >/dev/null 2>&1 \
        || die "metadata is not a JSON object (user-data scripts are ignored by design)"

    local id owner authb64 authjson
    id=$(printf '%s' "$raw" | jq -r '."safebox-id" // empty')
    owner=$(printf '%s' "$raw" | jq -r '."owner-pubkey" // empty')
    authb64=$(printf '%s' "$raw" | jq -r '."launch-authorization" // empty')

    [[ -n $id ]] || die "safebox-id missing from metadata"
    [[ $id =~ $RE_ID ]] || die "safebox-id has invalid format"
    [[ -n $owner ]] || die "owner-pubkey missing from metadata"
    [[ $owner =~ $RE_PUBKEY ]] || die "owner-pubkey must be 64 lowercase hex characters (Ed25519 public key)"
    [[ -n $authb64 ]] || die "launch-authorization missing from metadata"
    [[ $authb64 =~ $RE_B64 ]] || die "launch-authorization is not base64 of a plausible length (${#authb64} chars)"

    # Decode and shape-check the authorization. base64 -d tolerates the
    # url-safe alphabet after translation; jq -e fails on anything that is
    # not the expected object, including a shell script someone encoded.
    authjson=$(printf '%s' "$authb64" | tr -- '-_' '+/' | base64 -d 2>/dev/null) \
        || die "launch-authorization does not decode"
    printf '%s' "$authjson" | jq -e --arg id "$id" --arg owner "$owner" --argjson max "$MAX_AUTH_SECONDS" '
        type == "object"
        and .ocp == 1
        and (.stm | type == "object")
        and .stm.type == "launch_authorization"
        and .stm.safeboxId == $id
        and .stm.ownerPubkey == $owner
        and (.stm.notBefore | type == "number")
        and (.stm.expiresAt | type == "number")
        and .stm.expiresAt > .stm.notBefore
        and (.stm.expiresAt - .stm.notBefore) <= $max
        and (.stm.nonce | type == "string" and length >= 8)
        and .nbf == .stm.notBefore and .exp == .stm.expiresAt
        and .iss == ("safenet:owner:" + $owner)
        and .sub == ("safebox:" + $id)
        and (.key | type == "array" and length >= 1 and any(. == $owner))
        and (.sig | type == "array")
        and (.key | length) == (.sig | length)
    ' >/dev/null 2>&1 || die "launch-authorization is not a well-formed launch_authorization claim for safebox-id=$id owner-pubkey=$owner"

    [[ -r $DEFAULTS_FILE ]] || die "$DEFAULTS_FILE missing"
    jq -e '.dnsRelays | type == "array"' "$DEFAULTS_FILE" >/dev/null 2>&1 \
        || die "$DEFAULTS_FILE has no dnsRelays array"

    log "safebox-id=$id owner-pubkey=$owner (authorization: ${#authb64} chars, expires $(printf '%s' "$authjson" | jq -r '.stm.expiresAt'))"

    # Atomic write: build in a temp file in the same directory, set ownership
    # and mode before it is visible, then rename over the destination.
    local tmp
    tmp=$(mktemp "$STATE_DIR/.dnsclient.json.XXXXXX")
    trap 'rm -f "$tmp"' EXIT
    jq -n --arg id "$id" --arg owner "$owner" --argjson auth "$authjson" --arg cloud "$cloud" \
        '{safeboxId: $id, ownerPubkey: $owner, launchAuthorization: $auth, cloud: $cloud}' >"$tmp"
    # Owned by the dnsclient uid, like everything else in its directory.
    # Nothing in it is secret; 0640 is the directory's convention.
    chown "$DNS_UID:$DNS_GID" "$tmp"
    chmod 0640 "$tmp"
    mv -f "$tmp" "$OUT_FILE"
    trap - EXIT
    log "wrote $OUT_FILE"

    # instance.json: world-readable, root-owned. /var/lib/safebox is not
    # listable by "other", but a known path inside it can be opened.
    tmp=$(mktemp "$POOL_DIR/.instance.json.XXXXXX")
    trap 'rm -f "$tmp"' EXIT
    jq -n --arg id "$id" --arg owner "$owner" --arg cloud "$cloud" \
        '{safeboxId: $id, ownerPubkey: $owner, cloud: $cloud}' >"$tmp"
    chown root:root "$tmp"
    chmod 0644 "$tmp"
    mv -f "$tmp" "$INSTANCE_FILE"
    trap - EXIT
    log "wrote $INSTANCE_FILE"
}

main "$@"
