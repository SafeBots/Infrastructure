#!/usr/bin/env python3
"""Guard the per-process egress policy: every service under safebox.egress must
carry IPAddressDeny=any and only its enumerated allows (plus loopback); a service
with no allowlist is deny-all (localhost only); the module never emits a blanket
allow. Static check of egress.nix + egress-defaults.nix (no Nix evaluator here)."""
import os, sys, re
D = os.path.dirname(os.path.abspath(__file__))
mod = open(os.path.join(D, "..", "modules", "egress.nix")).read()
dfl = open(os.path.join(D, "..", "modules", "egress-defaults.nix")).read()
fails = []
def ck(c, m):
    print(("  PASS " if c else "  FAIL ") + m); (fails.append(m) if not c else None)

# egress.nix core guarantees
ck('IPAddressDeny = "any"' in mod, "every policed service gets IPAddressDeny=any")
ck("IPAddressAllow = loopback ++ policy.allow" in mod, "allow = loopback + only the enumerated allows")
ck('loopback = [ "127.0.0.0/8" "::1/128" ]' in mod, "loopback is the ONLY implicit allow")
ck('IPAddressAllow = "any"' not in mod and "allow-any" not in mod, "never emits a blanket allow-any")
ck("IP PREFIXES, not" in mod and "forward proxy" in mod, "documents the hostname/CDN caveat honestly")

# defaults: the weakest link (php web tier) and the runners are deny-all
ck(re.search(r'"phpfpm-safebox"\.allow = \[\]', dfl), "php web tier is deny-all (DB is local socket)")
ck(re.search(r'"docker-safebox-llama-deepseek"\.allow = \[\]', dfl), "model runner is deny-all")
ck("safebox-zfs-backup" in dfl and "backup peer" in dfl.lower(), "backup service has a narrow peer allow")
ck("viaProxy" in dfl and "weights" in dfl, "weight-fetch documented via proxy, not a broad allow")

print()
if fails: print(f"FAIL: {len(fails)}"); sys.exit(1)
print("OK: per-process egress is default-deny, per-identity, no blanket allow.")
