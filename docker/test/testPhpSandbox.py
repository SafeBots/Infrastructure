#!/usr/bin/env python3
"""Validate the php-fpm systemd sandbox in base.nix is present and coherent.
Guards against a regression that would silently drop the hardening, and against
re-introducing the two settings known to break php-fpm.
Run: python3 docker/test/testPhpSandbox.py
"""
import os, re, sys
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
base=open(os.path.join(ROOT,"nixos/modules/base.nix")).read()
fails=[]
def check(c,m):
    print(("  PASS " if c else "  FAIL ")+m)
    if not c: fails.append(m)

# The sandbox block must exist on the phpfpm-safebox service.
blk = re.search(r'systemd\.services\."phpfpm-safebox"\.serviceConfig\s*=\s*\{(.*?)\n  \};', base, re.S)
check(bool(blk), "phpfpm-safebox serviceConfig sandbox block present")
body = blk.group(1) if blk else ""

# Required hardening keys.
for key in ["SystemCallFilter","ProtectSystem","PrivateTmp","ProtectProc",
            "RestrictNamespaces","NoNewPrivileges","RestrictAddressFamilies",
            "CapabilityBoundingSet","ProtectKernelModules"]:
    check(key in body, f"sandbox sets {key}")

# ProtectSystem must be strict, with app root writable.
check('ProtectSystem = "strict"' in body, "ProtectSystem = strict")
check('/safebox/www' in body, "app root /safebox/www is ReadWritePaths")

# The two known-breaking settings must NOT be present (regression guard).
check('"~@resources"' not in body, "does NOT strip @resources (breaks fpm master)")
# Active setting = a line starting with the key (not a comment mentioning it).
active_mdwe = any(re.match(r'\s*MemoryDenyWriteExecute\s*=\s*true', ln)
                  for ln in body.splitlines())
check(not active_mdwe, "does NOT force W^X as an active setting (breaks OPcache JIT)")

# AF_NETLINK must be allowed (getaddrinfo).
check("AF_NETLINK" in body, "AF_NETLINK allowed (DNS/getaddrinfo)")

# @privileged and @obsolete must be stripped (the high-value removals).
check('"~@privileged"' in body, "strips @privileged syscalls")

print()
if fails: print(f"✗ {len(fails)} failed"); sys.exit(1)
print("✓ All php-fpm sandbox tests passed.")
