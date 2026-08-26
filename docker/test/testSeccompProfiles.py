#!/usr/bin/env python3
"""Validate the seccomp profiles and their compose wiring.
Run: python3 docker/test/testSeccompProfiles.py
"""
import json, os, sys, re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SEC = os.path.join(ROOT, "docker/security/seccomp")
COMPOSE = os.path.join(ROOT, "docker/docker-compose.yml")
fails = []
def check(c, m):
    print(("  PASS " if c else "  FAIL ") + m)
    if not c: fails.append(m)

# 1. Profiles parse and are deny-by-default
for name in ("safebox-runner.json", "safebox-gpu.json"):
    p = os.path.join(SEC, name)
    d = json.load(open(p))
    check(d.get("defaultAction") == "SCMP_ACT_ERRNO", f"{name}: deny-by-default")
    allowed = set()
    for blk in d["syscalls"]:
        if blk["action"] == "SCMP_ACT_ALLOW":
            allowed.update(blk["names"])
    # escape-prone syscalls MUST NOT be allowed
    forbidden = {"ptrace","keyctl","bpf","init_module","finit_module",
                 "delete_module","kexec_load","mount","pivot_root","setns",
                 "add_key","request_key","perf_event_open"}
    leaked = forbidden & allowed
    check(not leaked, f"{name}: no escape-prone syscalls allowed"
          + (f" (LEAKED: {leaked})" if leaked else ""))
    # unshare: allowed only where userns is needed; our base denies it
    check("unshare" not in allowed, f"{name}: unshare denied")

# 2. GPU profile is a superset of the base
base = set()
for blk in json.load(open(os.path.join(SEC,"safebox-runner.json")))["syscalls"]:
    if blk["action"]=="SCMP_ACT_ALLOW": base.update(blk["names"])
gpu = set()
for blk in json.load(open(os.path.join(SEC,"safebox-gpu.json")))["syscalls"]:
    if blk["action"]=="SCMP_ACT_ALLOW": gpu.update(blk["names"])
check(base.issubset(gpu), "GPU profile is a superset of the base profile")

# 3. Every seccomp= path in compose points at a file that exists
compose = open(COMPOSE).read()
for m in re.findall(r'seccomp=(\S+\.json)', compose):
    # /etc/safebox/docker/security/seccomp/X.json -> docker/security/seccomp/X.json
    fn = os.path.basename(m)
    check(os.path.exists(os.path.join(SEC, fn)),
          f"compose seccomp ref resolves: {fn}")

print()
if fails:
    print(f"✗ {len(fails)} failed"); sys.exit(1)
print("✓ All seccomp profile tests passed.")
