#!/usr/bin/env python3
"""Validate the Qbix webserver systemd sandbox in qbix-webserver.nix.
Guards against a regression that would silently drop the hardening.
(Previously checked php-fpm; updated after the Qbix webserver replaced it.)
Run: python3 docker/test/testPhpSandbox.py
"""
import os, re, sys
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
mod=open(os.path.join(ROOT,"nixos/modules/qbix-webserver.nix")).read()
fails=[]
def check(c,m):
    print(("  PASS " if c else "  FAIL ")+m)
    if not c: fails.append(m)

# The service must exist.
check("qbix-webserver" in mod, "qbix-webserver service defined")

# Required hardening keys (ported from the old php-fpm sandbox).
for key in ["SystemCallFilter","ProtectSystem","PrivateTmp","ProtectProc",
            "RestrictNamespaces","NoNewPrivileges","RestrictAddressFamilies",
            "CapabilityBoundingSet","ProtectKernelModules"]:
    check(key in mod, f"sandbox sets {key}")

# ProtectSystem must be strict.
check('ProtectSystem = "strict"' in mod, "ProtectSystem = strict")

# App root must be writable.
check('ReadWritePaths' in mod, "ReadWritePaths present (app root writable)")

# Fork-after-preload documented.
check('fork-after-preload' in mod.lower() or 'Fork-after-preload' in mod, "fork-after-preload documented")

# Pinned to v1.0.0.
check('v1.0.0' in mod, "pinned to v1.0.0 tag")

# fetchFromGitHub with Qbix/webserver.
check('owner = "Qbix"' in mod and 'repo = "webserver"' in mod, "fetches from github.com/Qbix/webserver")

if fails:
    print(f"\n✗ {len(fails)} failed"); sys.exit(1)
else:
    print("\n✓ Qbix webserver hardening: all checks pass")
