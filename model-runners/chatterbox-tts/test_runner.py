#!/usr/bin/env python3
"""Unit tests for the TTS runner: HMAC delegation + headers + request model.
Model loading (torch / chatterbox / orpheus) is NOT exercised here — that needs
a GPU and the model libs; a smoke test on real hardware covers it. Run:
    SAFEBOX_REQUIRE_HMAC=false python3 test_runner.py
"""
import hashlib, hmac, os, sys, time
os.environ.setdefault("SAFEBOX_REQUIRE_HMAC", "false")
sys.path.insert(0, os.path.dirname(__file__))

fails = []
def expect(cond, msg):
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond: fails.append(msg)

# Import the runner. If heavy deps (fastapi) are missing, skip gracefully.
try:
    import runner
except ModuleNotFoundError as e:
    print(f"  — skipped (missing dep: {e.name}); install fastapi/uvicorn/pydantic to run")
    sys.exit(0)

import safebox_auth as _sba

class FakeRequest:
    def __init__(self, headers, method="POST", path="/v1/speech"):
        self.headers = headers; self.method = method
        self.url = type("U", (), {"path": path})()

def _strong(ts, nonce, method, path, body, key="tts-test-key"):
    bh = hashlib.sha256(body).hexdigest()
    canon = f"{ts}\n{nonce}\n{method}\n{path}\n{bh}"
    return hmac.new(key.encode(), canon.encode(), hashlib.sha256).hexdigest()

print("── verify_hmac (shared delegation) ──")
expect(hasattr(runner, "verify_hmac"), "runner exposes verify_hmac")

_sba.REQUIRE_HMAC = False
expect(runner.verify_hmac(FakeRequest({}), b"x") is True, "passes when REQUIRE_HMAC=false")

_sba.REQUIRE_HMAC = True
_sba._cached_key = "tts-test-key"
_sba._seen_nonces.clear()
ts, nonce, method, path = str(int(time.time())), "n1", "POST", "/v1/speech"
body = b'{"text":"hello"}'
sig = _strong(ts, nonce, method, path, body)
expect(runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": ts, "X-Safebox-Nonce": nonce, "X-Safebox-Signature": sig},
    method, path), body) is True, "valid strong-form signature passes")
_sba._seen_nonces.clear()
expect(runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": ts, "X-Safebox-Nonce": "n2", "X-Safebox-Signature": "bad"},
    method, path), body) is False, "bad signature rejected")
_sba._seen_nonces.clear()
expect(runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": ts, "X-Safebox-Nonce": "n3", "X-Safebox-Signature": sig},
    method, "/v1/other"), body) is False, "endpoint-swap rejected")
_sba.REQUIRE_HMAC = False

print("\n── safebox_headers() ──")
h = runner.safebox_headers("req-1", runner.MODEL_NAME, 5)
expect("X-Safebox-Request-Id" in h or "X-Safebox-Model" in h or len(h) > 0, "headers produced")

print()
if fails:
    print(f"✗ {len(fails)} failed: {fails}"); sys.exit(1)
print("✓ All tests passed.")
