"""
Quick in-process tests for the Stable Audio runner wrapper.

Covers everything except actual stable-audio-tools inference. The lazy-import
design lets us exercise model matching, audio encoding (WAV correctness),
HMAC, capability gating, header generation, request validation.

Run:
    cd model-runners/stable-audio-3
    MODEL_NAME=stable-audio-open-small \
        STABLE_AUDIO_MODEL=stabilityai/stable-audio-open-small \
        SAFEBOX_REQUIRE_HMAC=false ENABLE_UNIX_SOCKET=false \
        python3 test_runner.py
"""

import array
import hashlib
import hmac
import io
import os
import sys
import time
import wave

os.environ.setdefault("MODEL_NAME",            "stable-audio-open-small")
os.environ.setdefault("STABLE_AUDIO_MODEL",    "stabilityai/stable-audio-open-small")
os.environ.setdefault("SAFEBOX_REQUIRE_HMAC",  "false")
os.environ.setdefault("ENABLE_UNIX_SOCKET",    "false")

import runner


fails = []
def expect(cond, label):
    if cond: print(f"  ✓ {label}")
    else:    print(f"  ✗ {label}"); fails.append(label)


# ── model_matches() ──────────────────────────────────────────────────────
print("\n── model_matches() ──")
expect(runner.model_matches("stable-audio-open-small"),                 "canonical name accepted")
expect(runner.model_matches("stabilityai/stable-audio-open-small"),     "HF id accepted")
expect(runner.model_matches("stable-audio-open-small"),                 "basename match (already canonical)")
expect(not runner.model_matches("stable-audio-open-1.0"),               "different variant rejected")
expect(not runner.model_matches("kokoro-82m"),                          "wrong model rejected")
expect(not runner.model_matches(""),                                    "empty rejected")


# ── stereo_to_wav_bytes() — WAV header correctness ──────────────────────
print("\n── stereo_to_wav_bytes() (mono fallback path) ──")
# Stable Audio outputs stereo, but the function handles 1D arrays too.
# Use a stdlib array since we don't depend on numpy in this test.
mono_pcm = array.array('h', [0] * 4410)  # 0.1s of silence at 44.1kHz
wav_bytes = runner.stereo_to_wav_bytes(mono_pcm, 44100)
expect(wav_bytes[:4] == b"RIFF",                     "WAV magic")
expect(wav_bytes[8:12] == b"WAVE",                   "WAVE format ID")
with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
    expect(wf.getframerate() == 44100,               "44.1 kHz sample rate")
    expect(wf.getnchannels() == 1,                   "1D input → mono")
    expect(wf.getsampwidth() == 2,                   "16-bit")

print("\n── stereo_to_wav_bytes() (stereo path) ──")
# Simulate a numpy-shaped [channels=2, samples] array using ducktype objects
# that have .ndim, .shape, .T, .dtype, .tobytes()
import struct
class FakeNdArray:
    """Minimal numpy-shaped object for testing the stereo branch."""
    def __init__(self, channels, samples):
        self.ndim = 2
        self.shape = (channels, samples)
        # Generate distinct samples to verify channel ordering
        self._data = []
        for s in range(samples):
            for c in range(channels):
                # c=0: positive, c=1: negative — easy to inspect
                self._data.append(100 if c == 0 else -100)
        # Build a flat array — when .T (transpose) is called, we just return
        # ourselves and treat it as [samples, channels] interleaved
        class T:
            def __init__(self, data):
                self.dtype = type("D", (), {"kind": "i"})()  # already int
                self._data = data
            def tobytes(self):
                return struct.pack("<%dh" % len(self._data), *self._data)
        self._T = T(self._data)
        self.dtype = type("D", (), {"kind": "i"})()
    @property
    def T(self):
        return self._T

stereo = FakeNdArray(2, 4410)
wav_bytes = runner.stereo_to_wav_bytes(stereo, 44100)
expect(wav_bytes[:4] == b"RIFF",                     "stereo WAV magic")
with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
    expect(wf.getnchannels() == 2,                   "2D input → stereo")
    expect(wf.getframerate() == 44100,               "44.1 kHz")
    expect(wf.getnframes() == 4410,                  "4410 frames per channel")


# ── encode_audio() — format dispatch ────────────────────────────────────
print("\n── encode_audio() ──")
wav_out = runner.encode_audio(mono_pcm, 44100, "wav")
expect(wav_out[:4] == b"RIFF",                       "wav format returns WAV")
mp3_out = runner.encode_audio(mono_pcm, 44100, "mp3")
expect(isinstance(mp3_out, (bytes, bytearray)) and len(mp3_out) > 0,
                                                     "mp3 returns bytes (with WAV fallback if ffmpeg absent)")


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

# ── Capacity hint ─────────────────────────────────────────────────────
print("\n── get_capacity_hint() ──")
# This runner sets MAX_QUEUE_DEPTH=2 by default (audio gen is slow).
# Temporarily lift it to a value that gives meaningful integer thresholds.
_saved_depth = runner.MAX_QUEUE_DEPTH
runner.MAX_QUEUE_DEPTH = 10
runner.in_flight = 0
expect(runner.get_capacity_hint() == "available",      "idle → available")
runner.in_flight = 8   # 80% of 10
expect(runner.get_capacity_hint() == "near-saturated", "high → near-saturated")
runner.in_flight = 10
expect(runner.get_capacity_hint() == "saturated",      "at cap → saturated")
runner.in_flight = 0
runner.MAX_QUEUE_DEPTH = _saved_depth


# ── Safebox headers ───────────────────────────────────────────────────
print("\n── safebox_headers() ──")
h = runner.safebox_headers("req-audio-9", "stable-audio-open-small", 4200)
expect(h["X-Safebox-Request-Id"] == "req-audio-9",                  "request id echoed")
expect(h["X-Safebox-Model-Id"]   == "stable-audio-open-small",      "model id present")
expect(h["X-Safebox-Compute-Ms"] == "4200",                         "compute_ms stringified")
expect(h["X-Safebox-Runner-Id"]  == runner.RUNNER_ID,               "runner id present")
expect("X-Safebox-Capacity-Hint" in h,                              "capacity hint included")


# ── Pydantic request validation ────────────────────────────────────────
print("\n── AudioGenerateRequest defaults ──")
r = runner.AudioGenerateRequest(model="stable-audio-open-small", prompt="warm synth pad")
expect(r.outputMode == "path",              "default outputMode is 'path'")
expect(r.durationSec is None,               "default durationSec is None (runner fills)")
expect(r.steps is None,                     "default steps is None (runner fills)")
expect(r.cfgScale is None,                  "default cfgScale is None")
expect(r.filenamePrefix == "safebox-audio", "default filenamePrefix set")
expect(r.negativePrompt == "",              "default negativePrompt is empty")


# ── Configuration plumbing ─────────────────────────────────────────────
print("\n── configuration ──")
expect(runner.MODEL_NAME == "stable-audio-open-small",      "MODEL_NAME from env")
expect(runner.STABLE_AUDIO_MODEL == "stabilityai/stable-audio-open-small",
                                                            "STABLE_AUDIO_MODEL from env")
expect(runner.SAMPLE_RATE == 44100,                         "SAMPLE_RATE defaults to 44.1kHz")
expect(runner.CAP_TEXT2AUDIO is True,                       "CAP_TEXT2AUDIO enabled")
expect(runner.CAP_AUDIO2AUDIO is False,                     "CAP_AUDIO2AUDIO gated off (v1.0)")
expect(runner.CAP_INPAINT is False,                         "CAP_INPAINT gated off (v1.0)")
expect(runner.CAP_STREAMING is False,                       "CAP_STREAMING off (diffusion is one-shot)")


# ── Summary ───────────────────────────────────────────────────────────
print()
if fails:
    print(f"✗ {len(fails)} test(s) failed:")
    for f in fails: print(f"    - {f}")
    sys.exit(1)
print("✓ All tests passed.")
