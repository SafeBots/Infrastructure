# shellcheck shell=bash
# /opt/safebox/bin/safebox-caller.sh — sourced (never executed) by the root
# wrappers. Not a wrapper: not in sudoers, mode 0644.
#
# Who is calling? sudo sets SUDO_UID to the invoking user's real uid after
# env_reset has thrown the caller's environment away, so the value cannot
# come from the caller. The wrappers map it to a passwd name and from there
# to a tenant:
#
#   safebox-sys-<name>  (uid 20000..29999)  the tenant instance for <name>
#   safebox-infra       (uid 990)           the operator instance / autovhost
#
# A tenant-side wrapper calls caller_tenant and then REQUIRES every argument
# that names a tenant, test, clone or dataset to belong to that tenant. An
# operator-side subcommand calls require_operator. Neither trusts the
# arguments to say who is asking. See docs/HARDENING-PLAN.md,
# "Per-tenant isolation". The sourcing script must define die().

readonly SAFEBOX_OPERATOR_UID=990
readonly SAFEBOX_TENANT_USER_PREFIX=safebox-sys-
readonly SAFEBOX_RE_TENANT='^[a-z0-9-]{1,40}$'

caller_uid() {
    [[ ${SUDO_UID:-} =~ ^[0-9]+$ ]] || die "must be invoked through sudo (SUDO_UID is not set)"
    printf '%s' "$SUDO_UID"
}

caller_user() {
    local uid entry
    uid=$(caller_uid)
    entry=$(getent passwd "$uid") || die "uid $uid has no passwd entry"
    printf '%s' "${entry%%:*}"
}

# Prints the tenant name of the calling instance; dies for any other caller.
caller_tenant() {
    local user tenant
    user=$(caller_user)
    [[ $user == "$SAFEBOX_TENANT_USER_PREFIX"* ]] || die "caller '$user' is not a tenant instance"
    tenant=${user#"$SAFEBOX_TENANT_USER_PREFIX"}
    [[ $tenant =~ $SAFEBOX_RE_TENANT ]] || die "caller tenant name '$tenant' is invalid"
    printf '%s' "$tenant"
}

require_operator() {
    [[ $(caller_uid) == "$SAFEBOX_OPERATOR_UID" ]] || die "only the operator instance (uid $SAFEBOX_OPERATOR_UID) may do this"
}

# Does dataset $1 belong to tenant $2? A tenant dataset belongs to the
# tenant it is named after. A clone belongs to the tenant recorded in the
# ZFS user property safebox:tenant, which safebox-zfs clone sets and nothing
# else can set (zfs is reachable only through that wrapper). Missing
# property or missing dataset: not owned.
dataset_owned_by() {
    local ds=$1 tenant=$2 owner
    ds=${ds%%@*}
    case $ds in
        safebox-pool/tenants/*)
            [[ ${ds#safebox-pool/tenants/} == "$tenant" ]]
            ;;
        safebox-pool/clones/*)
            owner=$(zfs get -H -o value safebox:tenant -- "$ds" 2>/dev/null) || return 1
            [[ -n $owner && $owner != "-" && $owner == "$tenant" ]]
            ;;
        *)
            return 1
            ;;
    esac
}

# Does test container safebox-test-$1 belong to tenant $2? safebox-test-run
# labels every test container with safebox.tenant=<tenant>.
test_owned_by() {
    local test_id=$1 tenant=$2 owner
    owner=$(docker inspect -f '{{ index .Config.Labels "safebox.tenant" }}' "safebox-test-$test_id" 2>/dev/null) || return 1
    [[ -n $owner && $owner == "$tenant" ]]
}
