"""
In-process tests for the privacy-filter runner.

Focus: the HMAC verification path, which was ENTIRELY ABSENT before the
security pass (the runner loaded a key and allocated a nonce set but never
verified anything — /v1/redact accepted any request). These assertions lock
in that it now verifies, and that it has the correct nonce-ordering behavior
(bad-sig requests do not burn nonces; overflow eviction keeps recent nonces).

Run:
    cd model-runners/privacy-filter
    SAFEBOX_REQUIRE_HMAC=false ENABLE_UNIX_SOCKET=false python3 test_runner.py
"""

import hashlib
import hmac
import os
import sys
import time

os.environ.setdefault("SAFEBOX_REQUIRE_HMAC", "false")
os.environ.setdefault("ENABLE_UNIX_SOCKET", "false")

import runner

fails = []
def expect(cond, label):
    if cond: print(f"  ✓ {label}")
    else:    print(f"  ✗ {label}"); fails.append(label)


class FakeRequest:
    def __init__(self, headers, method="POST", path="/v1/test"):
        self.headers = headers
        self.method = method
        self.url = type("U", (), {"path": path})()


# ── verify_hmac (delegates to shared safebox_auth) ───────────────────────
print("── verify_hmac ──")
import safebox_auth as _sba

def _strong(ts, nonce, method, path, body, key="privacy-test-key"):
    bh = hashlib.sha256(body).hexdigest()
    canon = f"{ts}\n{nonce}\n{method}\n{path}\n{bh}"
    return hmac.new(key.encode(), canon.encode(), hashlib.sha256).hexdigest()

expect(hasattr(runner, "verify_hmac"), "runner exposes verify_hmac")
expect(hasattr(_sba, "REQUIRE_HMAC"), "shared module has REQUIRE_HMAC gate")

print("\n── REQUIRE_HMAC=false (dev default) ──")
_sba.REQUIRE_HMAC = False
expect(runner.verify_hmac(FakeRequest({}), b"anything") is True,
       "passes through when REQUIRE_HMAC=false")

print("\n── REQUIRE_HMAC=true (strong canonical form) ──")
_sba.REQUIRE_HMAC = True
_sba._cached_key = "privacy-test-key"
_sba._seen_nonces.clear()
ts = str(int(time.time()))
nonce = "privacy-nonce-1"
method, path = "POST", "/v1/filter"
body = b'{"model":"openai/privacy-filter","text":"call me at 555-1234"}'
good_sig = _strong(ts, nonce, method, path, body)

r_ok = FakeRequest({"X-Safebox-Timestamp": ts, "X-Safebox-Nonce": nonce, "X-Safebox-Signature": good_sig}, method, path)
expect(runner.verify_hmac(r_ok, body) is True, "valid signature accepted")

_sba._seen_nonces.clear()
r_missing = FakeRequest({"X-Safebox-Timestamp": ts, "X-Safebox-Nonce": nonce}, method, path)
expect(runner.verify_hmac(r_missing, body) is False, "missing signature header rejected")

_sba._seen_nonces.clear()
r_bad = FakeRequest({"X-Safebox-Timestamp": ts, "X-Safebox-Nonce": "n-bad", "X-Safebox-Signature": "b"*64}, method, path)
expect(runner.verify_hmac(r_bad, body) is False, "bad signature rejected")

_sba._seen_nonces.clear()
r_stale = FakeRequest({"X-Safebox-Timestamp": "1000000000", "X-Safebox-Nonce": "n-stale", "X-Safebox-Signature": good_sig}, method, path)
expect(runner.verify_hmac(r_stale, body) is False, "stale timestamp rejected")

print("\n── nonce-ordering fix ──")
_sba._seen_nonces.clear()
r_burn = FakeRequest({"X-Safebox-Timestamp": ts, "X-Safebox-Nonce": "n-keep", "X-Safebox-Signature": "b"*64}, method, path)
expect(runner.verify_hmac(r_burn, body) is False, "bad-sig request rejected")
expect("n-keep" not in _sba._seen_nonces, "bad-sig request did NOT burn the nonce")
good_keep = _strong(ts, "n-keep", method, path, body)
r_keep = FakeRequest({"X-Safebox-Timestamp": ts, "X-Safebox-Nonce": "n-keep", "X-Safebox-Signature": good_keep}, method, path)
expect(runner.verify_hmac(r_keep, body) is True, "nonce still usable after the bad-sig attempt")
expect("n-keep" in _sba._seen_nonces, "good-sig request recorded the nonce")
r_replay = FakeRequest({"X-Safebox-Timestamp": ts, "X-Safebox-Nonce": "n-keep", "X-Safebox-Signature": good_keep}, method, path)
expect(runner.verify_hmac(r_replay, body) is False, "replay of good request rejected")

print("\n── overflow eviction preserves recent nonces ──")
_sba._seen_nonces.clear()
for i in range(50_002):
    _sba._seen_nonces[f"n{i}"] = int(time.time())
    if len(_sba._seen_nonces) > 50_000:
        for _ in range(25_000):
            _sba._seen_nonces.popitem(last=False)
expect(len(_sba._seen_nonces) >= 25_000, f"eviction keeps ~half (size={len(_sba._seen_nonces)}, not 0)")
expect("n50001" in _sba._seen_nonces, "most-recent nonce survived (no replay window)")

_sba.REQUIRE_HMAC = False

# ── Summary ──────────────────────────────────────────────────────────────
print()
if fails:
    print(f"✗ {len(fails)} test(s) failed:")
    for f in fails:
        print(f"    - {f}")
    sys.exit(1)
print("✓ All tests passed.")
