"""
Quick in-process tests for the MinerU runner wrapper.

Exercises everything except the actual MinerU document extraction (which needs
the model weights, a GPU, and real PDFs). Covers: source resolution, HMAC
verification (including the verify-before-record nonce ordering), the
dependency-free markdown→HTML converter, and request-model defaults.

Run:
    cd model-runners/mineru
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

os.environ.setdefault("SAFEBOX_REQUIRE_HMAC", "false")
os.environ.setdefault("ENABLE_UNIX_SOCKET", "false")

import runner


fails = []
def expect(cond, label):
    if cond:
        print(f"  ✓ {label}")
    else:
        print(f"  ✗ {label}")
        fails.append(label)


# ── _resolve_source() ────────────────────────────────────────────────────
print("\n── _resolve_source() ──")
with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
    f.write(b"%PDF-1.4 fake pdf bytes")
    tmp_path = f.name

r = runner.mineru_runner
p = r._resolve_source(tmp_path)
expect(p.is_absolute() and p.exists(), "absolute existing path resolves")

try:
    r._resolve_source("/nonexistent/does-not-exist.pdf")
    expect(False, "missing file should raise")
except Exception:
    expect(True, "missing file raises")

os.unlink(tmp_path)


# ── _markdown_to_html() ──────────────────────────────────────────────────
print("\n── _markdown_to_html() ──")
html = runner._markdown_to_html("# Title\n\nA paragraph.")
expect("<h1>Title</h1>" in html, "h1 rendered")
expect("<p>A paragraph.</p>" in html, "paragraph wrapped")

html2 = runner._markdown_to_html("## Sub\n### Deep")
expect("<h2>Sub</h2>" in html2 and "<h3>Deep</h3>" in html2, "h2/h3 rendered")

code_html = runner._markdown_to_html("```\ncode line\n```")
expect("<pre>" in code_html and "</pre>" in code_html, "fenced code → <pre>")
expect("code line" in code_html, "code content preserved")
# content inside a code fence must NOT be turned into a heading
code_hash = runner._markdown_to_html("```\n# not a heading\n```")
expect("<h1>" not in code_hash, "hash inside code fence is not a heading")


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

# ── request model defaults ───────────────────────────────────────────────
print("\n── request model defaults ──")
req = runner.ExtractRequest(source="/tmp/x.pdf")
expect(req.model == runner.MODEL_NAME, "ExtractRequest defaults model to MODEL_NAME")


print(f"\n{'all passed' if not fails else str(len(fails)) + ' FAILED'}")
sys.exit(1 if fails else 0)
