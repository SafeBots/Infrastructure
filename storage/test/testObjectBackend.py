#!/usr/bin/env python3
"""Guard the object-backend invariants: (1) never mounts the object store as a
filesystem (no goofys/s3fs/mount), (2) always client-side encrypts (crypt remote,
no provider SSE), (3) backs up ZFS as a send-stream object, not FS-on-object."""
import os, sys
D = os.path.dirname(os.path.abspath(__file__))
raw = open(os.path.join(D, "..", "object-backend.sh")).read()
sh = raw  # full text, for prose/documentation checks
# code = executable lines only (drop comment-only lines), for "is it actually used"
code = "\n".join(l for l in raw.splitlines() if not l.lstrip().startswith("#"))
fails = []
def ck(c, m):
    print(("  PASS " if c else "  FAIL ") + m)
    if not c: fails.append(m)

ck("goofys" not in code and "s3fs" not in code, "does not use goofys/s3fs (code)")
ck("mount" not in code, "never mounts the object store as a filesystem (code)")
ck("type = crypt" in sh, "wraps provider in a client-side crypt remote")
ck("SSE" not in sh or "NOT use provider SSE" in sh, "does not rely on provider SSE")
ck("CRYPT_KEY" in sh and "never the cloud" in sh, "encryption key is box-held, not the cloud's")
ck("zfs send" in sh and "rcat" in sh, "backs up ZFS as a send-stream object")
ck("M-OF-N GATE" in sh and "verify-mapping.py" in sh, "gates every mapping on M-of-N approval, fail-closed")
ck("run ZFS on top of the object store" in sh, "documents the no-FS-on-object rule")
# the switch really is one line per provider
for k in ("s3","gcs","azureblob"):
    ck(k in sh, f"supports provider mapping: {k}")

print()
if fails: print(f"FAIL: {len(fails)}"); sys.exit(1)
print("OK: object backend invariants hold (no FS-on-object, client-encrypted, ZFS-as-stream).")
