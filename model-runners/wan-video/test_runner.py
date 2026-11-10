"""
In-process tests for the Wan 2.2 runner wrapper.

Run:
    cd model-runners/wan-video
    MODEL_NAME=wan-2-2-ti2v-5b \
        WAN_MODEL_PATH=Wan-AI/Wan2.2-TI2V-5B-Diffusers \
        WAN_VARIANT=ti2v-5b \
        SAFEBOX_REQUIRE_HMAC=false ENABLE_UNIX_SOCKET=false \
        python3 test_runner.py
"""

import base64
import hashlib
import hmac
import os
import sys
import tempfile
import time

os.environ.setdefault("MODEL_NAME",            "wan-2-2-ti2v-5b")
os.environ.setdefault("WAN_MODEL_PATH",        "Wan-AI/Wan2.2-TI2V-5B-Diffusers")
os.environ.setdefault("WAN_VARIANT",           "ti2v-5b")
os.environ.setdefault("SAFEBOX_REQUIRE_HMAC",  "false")
os.environ.setdefault("ENABLE_UNIX_SOCKET",    "false")

import runner

fails = []
def expect(cond, label):
    if cond: print(f"  ✓ {label}")
    else:    print(f"  ✗ {label}"); fails.append(label)


# ── model_matches() ──────────────────────────────────────────────────────
print("\n── model_matches() ──")
expect(runner.model_matches("wan-2-2-ti2v-5b"),                     "canonical name accepted")
expect(runner.model_matches("Wan-AI/Wan2.2-TI2V-5B-Diffusers"),     "HF path accepted")
expect(runner.model_matches("Wan2.2-TI2V-5B-Diffusers"),            "basename accepted")
expect(not runner.model_matches("ltx-2-3-distilled"),               "different runner's model rejected")
expect(not runner.model_matches(""),                                "empty rejected")


# ── resolve_input_image() ────────────────────────────────────────────────
print("\n── resolve_input_image() ──")
expect(runner.resolve_input_image(None) is None,                    "None returns None")
expect(runner.resolve_input_image("") is None,                      "empty returns None")

sample_bytes = b"\x89PNG\r\n\x1a\n"
data_url = "data:image/png;base64," + base64.b64encode(sample_bytes).decode("ascii")
expect(runner.resolve_input_image(data_url) == sample_bytes,        "data: URL decoded correctly")

with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as tf:
    tf.write(b"fake-png-content")
    tmp_path = tf.name
try:
    expect(runner.resolve_input_image(tmp_path) == b"fake-png-content", "file path read correctly")
finally:
    os.unlink(tmp_path)

threw = False
try: runner.resolve_input_image("/nonexistent/path.png")
except ValueError: threw = True
expect(threw, "missing path raises ValueError")


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
print("\n── get_capacity_hint() — MAX_QUEUE_DEPTH=1 ──")
runner.in_flight = 0
expect(runner.get_capacity_hint() == "available", "0 in_flight → available")
runner.in_flight = 1
expect(runner.get_capacity_hint() == "saturated", "1 in_flight → saturated")
runner.in_flight = 0


# ── Safebox headers ───────────────────────────────────────────────────
print("\n── safebox_headers() ──")
h = runner.safebox_headers("req-wan-9", "wan-2-2-ti2v-5b", 82400)
expect(h["X-Safebox-Request-Id"] == "req-wan-9",                "request id echoed")
expect(h["X-Safebox-Model-Id"]   == "wan-2-2-ti2v-5b",          "model id present")
expect(h["X-Safebox-Compute-Ms"] == "82400",                    "compute_ms stringified")
expect(h["X-Safebox-Runner-Id"]  == runner.RUNNER_ID,           "runner id present")
expect("X-Safebox-Capacity-Hint" in h,                          "capacity hint included")


# ── VideoGenerateRequest defaults ────────────────────────────────────────
print("\n── VideoGenerateRequest defaults ──")
r = runner.VideoGenerateRequest(model="wan-2-2-ti2v-5b", prompt="cinematic shot of a city skyline")
expect(r.outputMode == "path",                                  "default outputMode is 'path'")
expect(r.inputImage is None,                                    "default inputImage is None")
expect(r.width is None,                                         "default width is None (runner fills)")
expect(r.numFrames is None,                                     "default numFrames is None")
expect(r.filenamePrefix == "safebox-wan-video",                 "default filenamePrefix set")
expect(r.negativePrompt == "",                                  "default negativePrompt is empty")

# MoE guidance fields
r2 = runner.VideoGenerateRequest(model="wan-2-2-t2v-a14b", prompt="test",
                                  guidance=4.5, guidanceLowNoise=3.5, flowShift=5.0)
expect(r2.guidance == 4.5,                                      "guidance set (high-noise expert)")
expect(r2.guidanceLowNoise == 3.5,                              "guidanceLowNoise set (low-noise expert)")
expect(r2.flowShift == 5.0,                                     "flowShift set")


# ── Configuration plumbing ─────────────────────────────────────────────
print("\n── configuration ──")
expect(runner.MODEL_NAME      == "wan-2-2-ti2v-5b",                       "MODEL_NAME from env")
expect(runner.WAN_MODEL_PATH  == "Wan-AI/Wan2.2-TI2V-5B-Diffusers",       "WAN_MODEL_PATH from env")
expect(runner.WAN_VARIANT     == "ti2v-5b",                               "WAN_VARIANT from env")
expect(runner.DEFAULT_WIDTH       == 1280,                                "default width 1280 (Wan native)")
expect(runner.DEFAULT_HEIGHT      == 720,                                 "default height 720 (Wan native)")
expect(runner.DEFAULT_NUM_FRAMES  == 81,                                  "default num_frames 81 (~5s at 16fps)")
expect(runner.DEFAULT_FPS         == 16,                                  "default fps 16 (Wan native)")
expect(runner.DEFAULT_STEPS       == 40,                                  "default steps 40 (Wan A14B)")
expect(runner.DEFAULT_GUIDANCE          == 4.0,                           "default guidance 4.0 (high-noise expert)")
expect(runner.DEFAULT_GUIDANCE_LOW_NOISE == 3.0,                          "default guidanceLowNoise 3.0 (low-noise expert)")
expect(runner.DEFAULT_FLOW_SHIFT  == 5.0,                                 "default flowShift 5.0 (720p)")
expect(runner.MAX_NUM_FRAMES      == 121,                                 "max num_frames 121")
expect(runner.CAP_TEXT2VIDEO   is True,                                   "CAP_TEXT2VIDEO enabled")
expect(runner.CAP_IMAGE2VIDEO  is True,                                   "CAP_IMAGE2VIDEO enabled")
expect(runner.CAP_VIDEO2VIDEO  is False,                                  "CAP_VIDEO2VIDEO off (v1.0)")
expect(runner.CAP_AUDIO        is False,                                  "CAP_AUDIO off (Wan base is video-only)")
expect(runner.CAP_STREAMING    is False,                                  "CAP_STREAMING off (one-shot)")
expect(runner.MAX_QUEUE_DEPTH  == 1,                                      "MAX_QUEUE_DEPTH=1 (slow)")


# ── Summary ───────────────────────────────────────────────────────────
print()
if fails:
    print(f"✗ {len(fails)} test(s) failed:")
    for f in fails: print(f"    - {f}")
    sys.exit(1)
print("✓ All tests passed.")
