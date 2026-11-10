#!/usr/bin/env python3
"""Assert the AMI-2 seal script covers every enumerated nondeterminism source
and preserves the /nix/store exclusion. Guards the checklist against drift."""
import json, os, sys, re
D = os.path.dirname(os.path.abspath(__file__))
seal = open(os.path.join(D, "seal-image.sh")).read()
chk  = json.load(open(os.path.join(D, "nondeterminism-checklist.json")))
fails = []
def check(c, m):
    print(("  PASS " if c else "  FAIL ") + m)
    if not c: fails.append(m)

# Each checklist source must have a recognizable action in the seal script.
markers = {
    "ssh-host-keys":    "ssh_host_",
    "machine-id":       "/etc/machine-id",
    "inode-mtimes":     "touch --no-dereference --date",
    "logs":             "/var/log)",
    "shell-history":    "bash_history",
    "random-seed":      "random-seed",
    "dhcp-leases":      "dhcp",
    "cloud-init-state": "/var/lib/cloud",
    "caches":           "/var/cache)",
    "tmp":              "/tmp)",
}
for src in chk["sources"]:
    cls = src["class"]
    marker = markers.get(cls)
    check(marker is not None and marker in seal,
          f"seal addresses '{cls}'")

# The /nix/store exclusion MUST be present (touching it would break the closure).
check("/nix/store)/*" in seal,
      "seal excludes /nix/store from mtime normalization (critical)")

# SSH teardown + assertion present.
check("systemctl mask sshd" in seal or "systemctl disable" in seal, "seal tears down sshd")
check("FATAL" in seal, "seal has fail-loud assertions")

# The forbidden second-channel agents your instruction named are checked.
for agent in ("amazon-ssm-agent", "waagent", "telnetd"):
    check(agent in seal, f"seal asserts '{agent}' absent")

print()
if fails: print(f"✗ {len(fails)} failed"); sys.exit(1)
print("✓ seal coverage complete — every enumerated source is addressed.")
