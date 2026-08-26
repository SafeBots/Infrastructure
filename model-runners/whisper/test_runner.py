"""
Quick in-process tests for the Whisper runner wrapper.

Exercises everything except the actual Faster-Whisper inference (which needs
audio files and a GPU). Covers: source resolution, HMAC verification,
capability gating, model matching, header generation, capacity hints.

Run:
    cd model-runners/whisper
    MODEL_NAME=whisper-large-v3-turbo \
        FASTER_WHISPER_MODEL=large-v3-turbo \
        SAFEBOX_REQUIRE_HMAC=false ENABLE_UNIX_SOCKET=false \
        python3 test_runner.py
"""

import hashlib
import hmac
import os
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("MODEL_NAME", "whisper-large-v3-turbo")
os.environ.setdefault("FASTER_WHISPER_MODEL", "large-v3-turbo")
os.environ.setdefault("SAFEBOX_REQUIRE_HMAC", "false")
os.environ.setdefault("ENABLE_UNIX_SOCKET", "false")
os.environ.setdefault("CAP_TRANSLATE", "false")

import runner


fails = []
def expect(cond, label):
    if cond:
        print(f"  ✓ {label}")
    else:
        print(f"  ✗ {label}")
        fails.append(label)


# ── model_matches() ──────────────────────────────────────────────────────
print("\n── model_matches() ──")
expect(runner.model_matches("whisper-large-v3-turbo"), "canonical name accepted")
expect(runner.model_matches("large-v3-turbo"),         "faster-whisper id accepted")
expect(not runner.model_matches("whisper-large-v3"),   "different model rejected")
expect(not runner.model_matches("medium"),             "wrong size rejected")
expect(not runner.model_matches(""),                   "empty model rejected")


# ── resolve_source() ─────────────────────────────────────────────────────
print("\n── resolve_source() ──")
# Create a real file we can resolve
with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
    f.write(b"fake audio bytes")
    tmp_path = f.name

p = runner.resolve_source(tmp_path)
expect(p.is_absolute() and p.exists(), "absolute existing path resolves")

p2 = runner.resolve_source(f"file://{tmp_path}")
expect(p2 == p, "file:// URL resolves to same path")

try:
    runner.resolve_source("https://example.com/audio.mp3")
    expect(False, "rejects https://")
except ValueError:
    expect(True, "rejects https://")

try:
    runner.resolve_source("s3://bucket/key.mp3")
    expect(False, "rejects s3://")
except ValueError:
    expect(True, "rejects s3://")

try:
    runner.resolve_source("relative/path.mp3")
    expect(False, "rejects relative path")
except ValueError:
    expect(True, "rejects relative path")

try:
    runner.resolve_source("/tmp/this-definitely-doesnt-exist-XYZ123.mp3")
    expect(False, "rejects missing file")
except FileNotFoundError:
    expect(True, "rejects missing file")

# clean up
os.unlink(tmp_path)


# ── file_sha256() ────────────────────────────────────────────────────────
print("\n── file_sha256() ──")
with tempfile.NamedTemporaryFile(delete=False) as f:
    f.write(b"hello world")
    p3 = f.name
expected = hashlib.sha256(b"hello world").hexdigest()
got = runner.file_sha256(Path(p3))
expect(got == expected, "file SHA-256 matches expected")
os.unlink(p3)


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
expect(runner.get_capacity_hint() == "available", "idle → available")
runner.in_flight = int(runner.MAX_QUEUE_DEPTH * 0.8)
expect(runner.get_capacity_hint() == "near-saturated", "high load → near-saturated")
runner.in_flight = runner.MAX_QUEUE_DEPTH
expect(runner.get_capacity_hint() == "saturated", "at capacity → saturated")
runner.in_flight = 0


# ── Safebox headers ───────────────────────────────────────────────────
print("\n── safebox_headers() ──")
h = runner.safebox_headers("req-456", "whisper-large-v3-turbo", 750)
expect(h["X-Safebox-Request-Id"] == "req-456",                 "request id echoed")
expect(h["X-Safebox-Model-Id"] == "whisper-large-v3-turbo",    "model id present")
expect(h["X-Safebox-Compute-Ms"] == "750",                     "compute_ms stringified")
expect(h["X-Safebox-Runner-Id"] == runner.RUNNER_ID,           "runner id present")
expect("X-Safebox-Capacity-Hint" in h,                         "capacity hint included")


# ── Pydantic model validation ──────────────────────────────────────────
print("\n── TranscribeRequest validation ──")
r = runner.TranscribeRequest(model="whisper-large-v3-turbo", source="/tmp/x.mp3")
expect(r.task == "transcribe",        "default task is transcribe")
expect(r.wordTimestamps is True,      "default wordTimestamps is True")
expect(r.vadFilter is True,           "default vadFilter is True")
expect(r.beamSize == 5,               "default beamSize is 5")
expect(r.temperature == 0.0,          "default temperature is 0.0")
expect(r.stream is False,             "default stream is False")
expect(r.diarize is False,            "default diarize is False")

# Translation request
r2 = runner.TranscribeRequest(
    model="whisper-large-v3", source="/tmp/x.mp3", task="translate")
expect(r2.task == "translate",        "translate task accepted")

# Word timestamps off
r3 = runner.TranscribeRequest(
    model="whisper-large-v3-turbo", source="/tmp/x.mp3", wordTimestamps=False)
expect(r3.wordTimestamps is False,    "wordTimestamps can be disabled")


# ── Summary ───────────────────────────────────────────────────────────
print()
if fails:
    print(f"✗ {len(fails)} test(s) failed: {fails}")
    sys.exit(1)
print("✓ All tests passed.")
