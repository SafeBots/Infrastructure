"""
Shared HMAC authentication for all Safebox model runners.

Strong canonical form — matches auth.js (system component) and the
Safebox LocalRunner.  Every runner imports this instead of inlining
its own verifier.

Canonical string:
    {timestamp}\n{nonce}\n{method}\n{path}\n{sha256(body).hex()}

Properties the weak form (v1.2 inline copies) dropped:
  1. Endpoint binding — method + path are signed, so a captured
     signature for POST /v1/embed cannot replay against POST /v1/chat.
  2. Separate body hash — fixed-width hex digest keeps the canonical
     string bounded and matches auth.js byte-for-byte.
"""

import hashlib
import hmac as _hmac
import os
import time
from collections import OrderedDict
from typing import Optional

from fastapi import Request


# ── Configuration ──────────────────────────────────────────────────

HMAC_KEY_PATH = os.getenv("HMAC_KEY_PATH", "/etc/safebox/model-api.key")
REQUIRE_HMAC = os.getenv("SAFEBOX_REQUIRE_HMAC", "false").lower() == "true"

_hmac_key: Optional[str] = None
_seen_nonces: OrderedDict = OrderedDict()
_MAX_NONCES = 50_000
_EVICT_COUNT = 25_000
_WINDOW_SECONDS = 300


def _load_key() -> Optional[str]:
    global _hmac_key
    if _hmac_key is not None:
        return _hmac_key
    try:
        with open(HMAC_KEY_PATH, "r") as f:
            _hmac_key = f.read().strip()
    except Exception:
        _hmac_key = None
    return _hmac_key


# ── Public API ─────────────────────────────────────────────────────

def verify_hmac(request: Request, body: bytes) -> bool:
    """Verify the HMAC signature on an incoming request.

    Returns True if the signature is valid (or HMAC is not required).
    Returns False if the signature is missing, expired, replayed, or wrong.
    """
    if not REQUIRE_HMAC:
        return True

    key = _load_key()
    if not key:
        return False

    sig = request.headers.get("X-Safebox-Signature", "")
    ts = request.headers.get("X-Safebox-Timestamp", "")
    nonce = request.headers.get("X-Safebox-Nonce", "")

    if not (sig and ts and nonce):
        return False

    # Timestamp window
    try:
        if abs(time.time() - int(ts)) > _WINDOW_SECONDS:
            return False
    except ValueError:
        return False

    # Nonce replay
    if nonce in _seen_nonces:
        return False

    # Strong canonical form — matches auth.js and Safebox LocalRunner
    method = request.method
    path = request.url.path  # path ONLY — no query string
    body_hash = hashlib.sha256(body).hexdigest()
    canonical = f"{ts}\n{nonce}\n{method}\n{path}\n{body_hash}"
    expected = _hmac.new(
        key.encode(), canonical.encode(), hashlib.sha256
    ).hexdigest()

    if not _hmac.compare_digest(expected, sig):
        return False

    # Record nonce (verify BEFORE recording — correct order)
    _seen_nonces[nonce] = int(time.time())
    if len(_seen_nonces) > _MAX_NONCES:
        for _ in range(_EVICT_COUNT):
            _seen_nonces.popitem(last=False)

    return True
