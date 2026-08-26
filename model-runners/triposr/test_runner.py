"""
In-process tests for the TripoSR runner wrapper.

Run:
    cd model-runners/triposr
    MODEL_NAME=triposr SAFEBOX_REQUIRE_HMAC=false ENABLE_UNIX_SOCKET=false \
        python3 test_runner.py
"""

import base64
import hashlib
import hmac
import os
import sys
import tempfile
import time

os.environ.setdefault("MODEL_NAME",            "triposr")
os.environ.setdefault("TRIPOSR_MODEL_PATH",    "stabilityai/TripoSR")
os.environ.setdefault("SAFEBOX_REQUIRE_HMAC",  "false")
os.environ.setdefault("ENABLE_UNIX_SOCKET",    "false")

import runner

fails = []
def expect(cond, label):
    if cond: print(f"  ✓ {label}")
    else:    print(f"  ✗ {label}"); fails.append(label)


# ── model_matches() ──────────────────────────────────────────────────────
print("\n── model_matches() ──")
expect(runner.model_matches("triposr"),                "canonical name accepted")
expect(runner.model_matches("stabilityai/TripoSR"),    "HF path accepted")
expect(runner.model_matches("TripoSR"),                "basename accepted")
expect(not runner.model_matches("hunyuan3d"),          "different model rejected")
expect(not runner.model_matches(""),                   "empty rejected")


# ── resolve_input_image() ────────────────────────────────────────────────
print("\n── resolve_input_image() ──")
# data: URL decode
sample_bytes = b"\x89PNG\r\n\x1a\nfake-image"
data_url = "data:image/png;base64," + base64.b64encode(sample_bytes).decode("ascii")
expect(runner.resolve_input_image(data_url) == sample_bytes, "data: URL decoded correctly")

# File path
with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as tf:
    tf.write(b"fake-png-content")
    tmp_path = tf.name
try:
    expect(runner.resolve_input_image(tmp_path) == b"fake-png-content", "file path read correctly")
finally:
    os.unlink(tmp_path)

# Missing path
threw = False
try: runner.resolve_input_image("/nonexistent/path.png")
except ValueError: threw = True
expect(threw, "missing path raises ValueError")

# Empty string
threw = False
try: runner.resolve_input_image("")
except ValueError: threw = True
expect(threw, "empty string raises ValueError")


# ── HMAC verification (delegates to shared safebox_auth) ──────────────
print("\n── verify_hmac() ──")
import safebox_auth as _sba

class FakeRequest:
    def __init__(self, headers, method="POST", path="/v1/test"):
        self.headers = headers
        self.method = method
        self.url = type("U", (), {"path": path})()

# REQUIRE_HMAC=false → anything passes
_sba.REQUIRE_HMAC = False
expect(runner.verify_hmac(FakeRequest({}), b"body"),
       "passes when REQUIRE_HMAC=false")

# REQUIRE_HMAC=true → strong canonical form enforced (matches auth.js / LocalRunner)
_sba.REQUIRE_HMAC = True
_sba._cached_key = "test-key-12345"
_sba._seen_nonces.clear()
_ts = str(int(time.time()))
_nonce = "test-nonce-1"
_body = b'{"hello":"world"}'
_method, _path = "POST", "/v1/test"
def _strong(ts, nonce, method, path, body, key="test-key-12345"):
    bh = hashlib.sha256(body).hexdigest()
    canon = f"{ts}\n{nonce}\n{method}\n{path}\n{bh}"
    return hmac.new(key.encode(), canon.encode(), hashlib.sha256).hexdigest()
_sig = _strong(_ts, _nonce, _method, _path, _body)

expect(runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": _ts, "X-Safebox-Nonce": _nonce, "X-Safebox-Signature": _sig},
    _method, _path), _body), "valid strong-form signature passes")

_sba._seen_nonces.clear()
expect(not runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": _ts, "X-Safebox-Nonce": "n-bad", "X-Safebox-Signature": "bogus"},
    _method, _path), _body), "bad signature rejected")

_sba._seen_nonces.clear()
expect(not runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": "1000000000", "X-Safebox-Nonce": "n-stale", "X-Safebox-Signature": _sig},
    _method, _path), _body), "stale timestamp rejected")

# endpoint binding: same sig replayed on a different path is rejected
_sba._seen_nonces.clear()
expect(not runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": _ts, "X-Safebox-Nonce": "n-ep", "X-Safebox-Signature": _sig},
    _method, "/v1/other"), _body), "endpoint-swap rejected")

# nonce replay protection
_sba._seen_nonces.clear()
runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": _ts, "X-Safebox-Nonce": _nonce, "X-Safebox-Signature": _sig},
    _method, _path), _body)
expect(not runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": _ts, "X-Safebox-Nonce": _nonce, "X-Safebox-Signature": _sig},
    _method, _path), _body), "nonce replay rejected")

# bad sig must NOT burn the nonce (verify-before-record)
_sba._seen_nonces.clear()
_bad = runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": _ts, "X-Safebox-Nonce": "n-keep", "X-Safebox-Signature": "b"*64},
    _method, _path), _body)
expect(_bad is False, "bad-sig request rejected")
expect("n-keep" not in _sba._seen_nonces, "bad-sig request did NOT burn the nonce")
_sig2 = _strong(_ts, "n-keep", _method, _path, _body)
expect(runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": _ts, "X-Safebox-Nonce": "n-keep", "X-Safebox-Signature": _sig2},
    _method, _path), _body) is True, "nonce still usable after bad-sig attempt")
_sba.REQUIRE_HMAC = False
_sba._seen_nonces.clear()

# ── Capacity hint ────────────────────────────────────────────────────────
print("\n── get_capacity_hint() ──")
runner.in_flight = 0
expect(runner.get_capacity_hint() == "available",      "idle → available")
runner.in_flight = int(runner.MAX_QUEUE_DEPTH * 0.8)
expect(runner.get_capacity_hint() == "near-saturated", "high → near-saturated")
runner.in_flight = runner.MAX_QUEUE_DEPTH
expect(runner.get_capacity_hint() == "saturated",      "at cap → saturated")
runner.in_flight = 0


# ── Safebox headers ───────────────────────────────────────────────────
print("\n── safebox_headers() ──")
h = runner.safebox_headers("req-3d-9", "triposr", 842)
expect(h["X-Safebox-Request-Id"] == "req-3d-9",            "request id echoed")
expect(h["X-Safebox-Model-Id"]   == "triposr",             "model id present")
expect(h["X-Safebox-Compute-Ms"] == "842",                 "compute_ms stringified")
expect(h["X-Safebox-Runner-Id"]  == runner.RUNNER_ID,      "runner id present")
expect("X-Safebox-Capacity-Hint" in h,                     "capacity hint included")


# ── Pydantic request validation ────────────────────────────────────────
print("\n── MeshGenerateRequest defaults ──")
r = runner.MeshGenerateRequest(model="triposr", inputImage="/tmp/foo.png")
expect(r.outputMode == "path",                  "default outputMode is 'path'")
expect(r.foregroundRatio is None,               "default foregroundRatio is None (runner fills)")
expect(r.meshResolution is None,                "default meshResolution is None")
expect(r.format is None,                        "default format is None")
expect(r.removeBackground is None,              "default removeBackground is None")
expect(r.filenamePrefix == "safebox-mesh",      "default filenamePrefix set")

# Required field validation
threw = False
try:
    runner.MeshGenerateRequest(model="triposr")  # missing inputImage
except Exception: threw = True
expect(threw, "missing inputImage raises validation error")


# ── Configuration plumbing ─────────────────────────────────────────────
print("\n── configuration ──")
expect(runner.MODEL_NAME            == "triposr",                  "MODEL_NAME from env")
expect(runner.TRIPOSR_MODEL_PATH    == "stabilityai/TripoSR",      "TRIPOSR_MODEL_PATH from env")
expect(runner.DEFAULT_FOREGROUND_RATIO == 0.85,                    "default foregroundRatio is 0.85")
expect(runner.DEFAULT_MESH_RESOLUTION  == 256,                     "default meshResolution is 256")
expect(runner.DEFAULT_FORMAT        == "glb",                      "default format is glb")
expect(runner.DEFAULT_REMOVE_BG     is True,                       "default removeBackground is True")
expect(runner.CAP_IMAGE2MESH        is True,                       "CAP_IMAGE2MESH enabled")
expect(runner.CAP_TEXT2MESH         is False,                      "CAP_TEXT2MESH off (TripoSR is image-only)")
expect(runner.CAP_PBR_TEXTURES      is False,                      "CAP_PBR_TEXTURES off (vertex colors only)")
expect(runner.CAP_STREAMING         is False,                      "CAP_STREAMING off (one-shot)")
expect(runner.MAX_QUEUE_DEPTH       == 4,                          "MAX_QUEUE_DEPTH=4 (fast inference)")


# ── Summary ───────────────────────────────────────────────────────────
print()
if fails:
    print(f"✗ {len(fails)} test(s) failed:")
    for f in fails: print(f"    - {f}")
    sys.exit(1)
print("✓ All tests passed.")
