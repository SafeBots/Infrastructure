"""
In-process tests for the LTX-Video runner wrapper.

The lazy-import design lets us exercise protocol logic without needing torch
or LTX-Video installed.

Run:
    cd model-runners/ltx-video
    MODEL_NAME=ltx-2-3-distilled \
        LTX_MODEL_PATH=Lightricks/LTX-Video \
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

os.environ.setdefault("MODEL_NAME",            "ltx-2-3-distilled")
os.environ.setdefault("LTX_MODEL_PATH",        "Lightricks/LTX-Video")
os.environ.setdefault("LTX_VARIANT",           "distilled")
os.environ.setdefault("SAFEBOX_REQUIRE_HMAC",  "false")
os.environ.setdefault("ENABLE_UNIX_SOCKET",    "false")
os.environ.setdefault("CAP_AUDIO",             "true")

import runner

fails = []
def expect(cond, label):
    if cond: print(f"  ✓ {label}")
    else:    print(f"  ✗ {label}"); fails.append(label)


# ── model_matches() ──────────────────────────────────────────────────────
print("\n── model_matches() ──")
expect(runner.model_matches("ltx-2-3-distilled"),     "canonical name accepted")
expect(runner.model_matches("Lightricks/LTX-Video"),  "HF path accepted")
expect(runner.model_matches("LTX-Video"),             "basename accepted")
expect(not runner.model_matches("hunyuan-video"),     "different model rejected")
expect(not runner.model_matches(""),                  "empty rejected")


# ── resolve_input_image() ────────────────────────────────────────────────
print("\n── resolve_input_image() ──")
expect(runner.resolve_input_image(None) is None,        "None returns None")
expect(runner.resolve_input_image("") is None,          "empty string returns None")

# data: URL
sample_bytes = b"\x89PNG\r\n\x1a\n"
data_url = "data:image/png;base64," + base64.b64encode(sample_bytes).decode("ascii")
expect(runner.resolve_input_image(data_url) == sample_bytes,  "data: URL decoded correctly")

# File path
with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as tf:
    tf.write(b"fake-png-content")
    tmp_path = tf.name
try:
    expect(runner.resolve_input_image(tmp_path) == b"fake-png-content", "file path read correctly")
finally:
    os.unlink(tmp_path)

# Missing file
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

# ── Capacity hint (MAX_QUEUE_DEPTH=1 special case) ──────────────────────
print("\n── get_capacity_hint() — MAX_QUEUE_DEPTH=1 ──")
# With MAX_QUEUE_DEPTH=1 (video gen is slow), there's no "near-saturated" zone
runner.in_flight = 0
expect(runner.get_capacity_hint() == "available", "0 in_flight → available")
runner.in_flight = 1
expect(runner.get_capacity_hint() == "saturated", "1 in_flight → saturated")
runner.in_flight = 0


# ── Safebox headers ───────────────────────────────────────────────────
print("\n── safebox_headers() ──")
h = runner.safebox_headers("req-video-9", "ltx-2-3-distilled", 28400)
expect(h["X-Safebox-Request-Id"] == "req-video-9",         "request id echoed")
expect(h["X-Safebox-Model-Id"]   == "ltx-2-3-distilled",   "model id present")
expect(h["X-Safebox-Compute-Ms"] == "28400",               "compute_ms stringified")
expect(h["X-Safebox-Runner-Id"]  == runner.RUNNER_ID,      "runner id present")
expect("X-Safebox-Capacity-Hint" in h,                     "capacity hint included")


# ── Pydantic request validation ────────────────────────────────────────
print("\n── VideoGenerateRequest defaults ──")
r = runner.VideoGenerateRequest(model="ltx-2-3-distilled", prompt="aerial shot of mountains")
expect(r.outputMode == "path",              "default outputMode is 'path'")
expect(r.inputImage is None,                "default inputImage is None (text-to-video)")
expect(r.width is None,                     "default width is None (runner fills)")
expect(r.numFrames is None,                 "default numFrames is None")
expect(r.filenamePrefix == "safebox-video", "default filenamePrefix set")
expect(r.negativePrompt == "",              "default negativePrompt is empty")


# ── Configuration plumbing ─────────────────────────────────────────────
print("\n── configuration ──")
expect(runner.MODEL_NAME       == "ltx-2-3-distilled",      "MODEL_NAME from env")
expect(runner.LTX_MODEL_PATH   == "Lightricks/LTX-Video",   "LTX_MODEL_PATH from env")
expect(runner.LTX_VARIANT      == "distilled",              "LTX_VARIANT from env")
expect(runner.DEFAULT_WIDTH    == 768,                      "default width is 768")
expect(runner.DEFAULT_HEIGHT   == 512,                      "default height is 512")
expect(runner.DEFAULT_NUM_FRAMES == 121,                    "default num_frames is 121 (~5s at 24fps)")
expect(runner.DEFAULT_FPS      == 24,                       "default fps is 24")
expect(runner.MAX_NUM_FRAMES   == 481,                      "max num_frames is 481 (~20s at 24fps)")
expect(runner.CAP_TEXT2VIDEO   is True,                     "CAP_TEXT2VIDEO enabled")
expect(runner.CAP_IMAGE2VIDEO  is True,                     "CAP_IMAGE2VIDEO enabled")
expect(runner.CAP_VIDEO2VIDEO  is False,                    "CAP_VIDEO2VIDEO gated off (v1.0)")
expect(runner.CAP_AUDIO        is True,                     "CAP_AUDIO enabled (LTX-2.3 supports synced audio)")
expect(runner.CAP_STREAMING    is False,                    "CAP_STREAMING off (diffusion one-shot)")
expect(runner.MAX_QUEUE_DEPTH  == 1,                        "MAX_QUEUE_DEPTH=1 (video gen is slow)")
expect(runner.DEFAULT_MODALITY_SCALE == 3.0,                "default modality_scale is 3.0 (LTX-recommended)")
expect(runner.AUDIO_SAMPLE_RATE == 44100,                   "audio sample rate is 44.1kHz")


# ── audio_to_wav_bytes() — WAV correctness ─────────────────────────────
print("\n── audio_to_wav_bytes() ──")
import wave, io as _io
# Mono float32 input
import array as _array
mono_f = [0.0] * 4410  # 0.1s silence at 44.1kHz
try:
    import numpy as _np
    arr_mono = _np.zeros(4410, dtype="float32")
    wav_bytes = runner.audio_to_wav_bytes(arr_mono, 44100)
    expect(wav_bytes[:4] == b"RIFF",                     "WAV magic")
    with wave.open(_io.BytesIO(wav_bytes), "rb") as wf:
        expect(wf.getframerate() == 44100,               "44.1 kHz")
        expect(wf.getnchannels() == 1,                   "1D input → mono")
        expect(wf.getsampwidth() == 2,                   "16-bit")

    # Stereo [channels=2, samples] input — the LTX-2.3 shape
    arr_stereo = _np.zeros((2, 4410), dtype="float32")
    wav_stereo = runner.audio_to_wav_bytes(arr_stereo, 44100)
    with wave.open(_io.BytesIO(wav_stereo), "rb") as wf:
        expect(wf.getnchannels() == 2,                   "2D [channels, samples] → stereo")
        expect(wf.getnframes() == 4410,                  "4410 frames preserved")

    # Float clipping
    arr_clip = _np.full(100, 2.0, dtype="float32")        # out of [-1,1] range
    wav_clip = runner.audio_to_wav_bytes(arr_clip, 44100)
    expect(len(wav_clip) > 44,                            "clipped float values still encode (no overflow)")
except ImportError:
    # numpy not available — skip the WAV tests but don't fail
    print("  (numpy not installed; skipping WAV encoding tests)")


# ── VideoGenerateRequest with audio fields ─────────────────────────────
print("\n── VideoGenerateRequest with audio fields ──")
r = runner.VideoGenerateRequest(
    model="ltx-2-3-distilled",
    prompt="cinematic close-up of rain on a window",
    enableAudio=True,
    audioPrompt="soft rain pattering, gentle thunder in the distance",
    modalityScale=3.5,
)
expect(r.enableAudio is True,                                 "enableAudio set")
expect(r.audioPrompt == "soft rain pattering, gentle thunder in the distance",
                                                              "audioPrompt set")
expect(r.modalityScale == 3.5,                                "modalityScale set")

r2 = runner.VideoGenerateRequest(model="ltx-2-3-distilled", prompt="silent demo, no audio",
                                  enableAudio=False)
expect(r2.enableAudio is False,                               "audio can be explicitly disabled per request")
expect(r2.audioPrompt is None,                                "audioPrompt defaults None")
expect(r2.modalityScale is None,                              "modalityScale defaults None")


# ── Summary ───────────────────────────────────────────────────────────
print()
if fails:
    print(f"✗ {len(fails)} test(s) failed:")
    for f in fails: print(f"    - {f}")
    sys.exit(1)
print("✓ All tests passed.")
