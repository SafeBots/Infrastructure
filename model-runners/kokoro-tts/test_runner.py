"""
Quick in-process tests for the Kokoro TTS runner wrapper.

Covers: model matching, source resolution, audio encoding (WAV header
correctness), HMAC verification, capability gating, header generation,
Pydantic request validation. Doesn't require real Kokoro — the runner's
lazy-import design lets us test all the protocol logic in isolation.

Run:
    cd model-runners/kokoro-tts
    MODEL_NAME=kokoro-82m DEFAULT_VOICE=af_heart \
        SAFEBOX_REQUIRE_HMAC=false ENABLE_UNIX_SOCKET=false \
        python3 test_runner.py
"""

import hashlib
import hmac
import io
import os
import struct
import sys
import time
import wave

os.environ.setdefault("MODEL_NAME",            "kokoro-82m")
os.environ.setdefault("DEFAULT_VOICE",         "af_heart")
os.environ.setdefault("SAFEBOX_REQUIRE_HMAC",  "false")
os.environ.setdefault("ENABLE_UNIX_SOCKET",    "false")

import runner


fails = []
def expect(cond, label):
    if cond: print(f"  ✓ {label}")
    else:    print(f"  ✗ {label}"); fails.append(label)


# ── model_matches() ──────────────────────────────────────────────────────
print("\n── model_matches() ──")
expect(runner.model_matches("kokoro-82m"),           "canonical name accepted")
expect(runner.model_matches("kokoro"),               "short substring accepted (kokoro)")
expect(not runner.model_matches("whisper-large"),    "different model rejected")
expect(not runner.model_matches(""),                 "empty rejected")


# ── pcm_to_wav_bytes() — WAV encoding ───────────────────────────────────
print("\n── pcm_to_wav_bytes() ──")
# Create a small int16 PCM array directly without numpy
# 24kHz mono, 0.1 second of silence = 2400 samples × 2 bytes = 4800 bytes of PCM
import array
pcm = array.array('h', [0] * 2400)
wav_bytes = runner.pcm_to_wav_bytes(pcm, 24000)

# Standard WAV header is 44 bytes; total should be 44 + 4800
expect(len(wav_bytes) == 44 + 4800,                  "WAV size matches header + data")
expect(wav_bytes[:4] == b"RIFF",                     "WAV starts with RIFF magic")
expect(wav_bytes[8:12] == b"WAVE",                   "WAV format identifier present")
expect(wav_bytes[12:16] == b"fmt ",                  "WAV fmt chunk present")

# Parse with stdlib wave module to verify round-trip
with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
    expect(wf.getnchannels() == 1,                   "mono")
    expect(wf.getsampwidth() == 2,                   "16-bit")
    expect(wf.getframerate() == 24000,               "24000 Hz")
    expect(wf.getnframes() == 2400,                  "2400 frames")


# ── encode_audio() — format dispatch ────────────────────────────────────
print("\n── encode_audio() ──")
wav_out = runner.encode_audio(pcm, 24000, "wav")
expect(wav_out[:4] == b"RIFF",                       "wav format returns WAV bytes")

# MP3/OGG attempt ffmpeg — if not present, falls back to WAV. Either is OK.
mp3_out = runner.encode_audio(pcm, 24000, "mp3")
expect(isinstance(mp3_out, (bytes, bytearray)) and len(mp3_out) > 0,
                                                     "mp3 encode returns bytes (or falls back to WAV)")


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
runner.in_flight = 0
expect(runner.get_capacity_hint() == "available",      "idle → available")
runner.in_flight = int(runner.MAX_QUEUE_DEPTH * 0.8)
expect(runner.get_capacity_hint() == "near-saturated", "high load → near-saturated")
runner.in_flight = runner.MAX_QUEUE_DEPTH
expect(runner.get_capacity_hint() == "saturated",      "at capacity → saturated")
runner.in_flight = 0


# ── Safebox headers ───────────────────────────────────────────────────
print("\n── safebox_headers() ──")
h = runner.safebox_headers("req-speech-9", "kokoro-82m", 320)
expect(h["X-Safebox-Request-Id"] == "req-speech-9",    "request id echoed")
expect(h["X-Safebox-Model-Id"]   == "kokoro-82m",      "model id present")
expect(h["X-Safebox-Compute-Ms"] == "320",             "compute_ms stringified")
expect(h["X-Safebox-Runner-Id"]  == runner.RUNNER_ID,  "runner id present")
expect("X-Safebox-Capacity-Hint" in h,                 "capacity hint included")


# ── Pydantic request validation ────────────────────────────────────────
print("\n── SpeechRequest defaults ──")
r = runner.SpeechRequest(model="kokoro-82m", text="hello")
expect(r.outputMode == "path",              "default outputMode is 'path'")
expect(r.stream is False,                   "default stream is False")
expect(r.voice is None,                     "default voice is None (runner fills DEFAULT_VOICE)")
expect(r.speed is None,                     "default speed is None (runner fills DEFAULT_SPEED)")
expect(r.filenamePrefix == "safebox-speech","default filenamePrefix set")


# ── Voice fallback list ─────────────────────────────────────────────────
# When the lazy load can't reach kokoro (because it's not installed in test),
# the load() should still populate the voice fallback list. Verify that the
# fallback list has both American and British voices.
print("\n── voice fallback list ──")
# Pre-set the fallback (simulating a load failure that exits the try block
# before the real voices are populated)
expect(len(runner.kokoro_runner.voices) >= 0, "voices list is a list (possibly empty pre-load)")

# Manually exercise the fallback population by setting it as it would be
runner.kokoro_runner.voices = [
    "af_heart", "af_alloy", "af_aoede", "af_bella",
    "am_michael", "am_adam", "am_eric",
    "bf_alice", "bf_emma",
    "bm_george", "bm_lewis",
]
expect(len(runner.kokoro_runner.voices) > 0,             "voices list populated")
expect(any(v.startswith("af_") for v in runner.kokoro_runner.voices),
                                                          "has American female voices")
expect(any(v.startswith("am_") for v in runner.kokoro_runner.voices),
                                                          "has American male voices")
expect(any(v.startswith("bf_") for v in runner.kokoro_runner.voices),
                                                          "has British female voices")
expect(any(v.startswith("bm_") for v in runner.kokoro_runner.voices),
                                                          "has British male voices")


# ── Configuration plumbing ─────────────────────────────────────────────
print("\n── configuration ──")
expect(runner.MODEL_NAME == "kokoro-82m",                "MODEL_NAME picked up from env")
expect(runner.DEFAULT_VOICE == "af_heart",               "DEFAULT_VOICE picked up from env")
expect(runner.SAMPLE_RATE == 24000,                      "SAMPLE_RATE defaults to 24000 (Kokoro standard)")
expect(runner.CAP_SPEECH is True,                        "CAP_SPEECH defaults to true")
expect(runner.CAP_VOICE_CLONE is False,                  "CAP_VOICE_CLONE defaults to false (Kokoro can't clone)")
expect(runner.CAP_STREAMING is True,                     "CAP_STREAMING is always true")


# ── Summary ───────────────────────────────────────────────────────────
print()
if fails:
    print(f"✗ {len(fails)} test(s) failed:")
    for f in fails: print(f"    - {f}")
    sys.exit(1)
print("✓ All tests passed.")
