"""
safebox_auth.py — the ONE canonical HMAC verifier for every model runner.

This module is the single source of truth for the runner side of the Safebox
model-API HMAC. Its canonical string is byte-for-byte identical to the system
component (aws/scripts/components/system/auth.js) and to the Safebox plugin's
LocalRunner:

    canonical = "<timestamp>\\n<nonce>\\n<method>\\n<path>\\n<sha256(body)-hex>"
    signature = HMAC-SHA256(secret, canonical) -> hex

Why one module: v1.2 inlined a separate verifier into every runner.py and they
drifted into three different shapes (dotted-weak, single-quoted-weak, and an
onnx variant that signed only the body with no replay protection). Eleven inline
copies means eleven chances to diverge from each other, from auth.js, and from
Safebox. Every runner now imports verify_hmac from here so the canonical form is
defined exactly once.

Contract preserved from the previous runners (all intentional, all kept):
  - three X-Safebox-* headers: Signature, Timestamp, Nonce
  - 300-second timestamp window
  - verify signature BEFORE recording the nonce (so bad-sig floods can't evict
    the nonce set and open a replay window)
  - timing-safe comparison
  - half-eviction nonce cache (drop oldest half, never clear() — clearing would
    briefly make every prior nonce replayable)

Path binding note: `path` MUST be the exact path the client signed —
request.url.path, no query string, no proxy prefix rewriting. If nginx or a
wrapper strips a prefix before FastAPI sees it, the signed and verified paths
differ and every request 401s. Keep the runner location a straight pass-through.
"""
from __future__ import annotations

import collections
import hashlib
import hmac
import os
import time
from pathlib import Path
from typing import Optional

# ── Configuration (identical across runners) ────────────────────────────
HMAC_KEY_PATH = os.getenv("HMAC_KEY_PATH", "/etc/safebox/model-api.key")
REQUIRE_HMAC = os.getenv("SAFEBOX_REQUIRE_HMAC", "false").lower() == "true"
TIMESTAMP_WINDOW_SEC = 300
NONCE_CACHE_MAX = 50_000
NONCE_CACHE_EVICT = 25_000

# Insertion-ordered nonce cache, shared process-wide for the runner.
_seen_nonces: "collections.OrderedDict[str, int]" = collections.OrderedDict()


def load_hmac_key() -> Optional[str]:
    """Read the HMAC key the system component mounts at HMAC_KEY_PATH.

    Returns the key string, or None if not provisioned. Runners should treat
    None as 'closed when REQUIRE_HMAC' (see verify_hmac)."""
    try:
        return Path(HMAC_KEY_PATH).read_text().strip()
    except OSError:
        return None


def canonical_string(timestamp: str, nonce: str, method: str,
                     path: str, body: bytes) -> str:
    """The canonical envelope — must match auth.js byte-for-byte.

    body is hashed to a fixed-width hex digest first, which keeps the canonical
    string bounded and composes cleanly with streaming/binary bodies."""
    body_hash = hashlib.sha256(body).hexdigest()
    return f"{timestamp}\n{nonce}\n{method}\n{path}\n{body_hash}"


# Key is read once and cached; the system component mounts it at startup and it
# does not rotate within a process lifetime. Re-read on demand if absent (e.g.
# the mount landed just after boot).
_cached_key: Optional[str] = None


def _key() -> Optional[str]:
    global _cached_key
    if _cached_key is None:
        _cached_key = load_hmac_key()
    return _cached_key


def verify_hmac(request, body: bytes, hmac_key: Optional[str] = None) -> bool:
    """Verify a Safebox model-API request.

    request: a Starlette/FastAPI Request (uses .headers, .method, .url.path)
    body:    the raw request body bytes (already read by the caller)
    hmac_key: optional explicit key; if omitted, the module reads and caches it
              from HMAC_KEY_PATH. Runners call this as verify_hmac(request, body)
              with no key argument, so every call site stays unchanged.

    Returns True iff the request is authentic and non-replayed, or iff HMAC is
    not required. Fail-closed when REQUIRE_HMAC and no key is present.
    """
    if not REQUIRE_HMAC:
        return True
    if hmac_key is None:
        hmac_key = _key()
    if not hmac_key:
        return False

    sig = request.headers.get("X-Safebox-Signature", "")
    ts = request.headers.get("X-Safebox-Timestamp", "")
    nonce = request.headers.get("X-Safebox-Nonce", "")
    if not (sig and ts and nonce):
        return False

    try:
        if abs(time.time() - int(ts)) > TIMESTAMP_WINDOW_SEC:
            return False
    except ValueError:
        return False

    if nonce in _seen_nonces:
        return False

    # Verify BEFORE recording the nonce. Recording first would let an attacker
    # exhaust the nonce set with bad-signature requests, trigger eviction, and
    # open a brief replay window.
    method = request.method
    path = request.url.path  # path ONLY — no query string, no proxy rewrite
    canonical = canonical_string(ts, nonce, method, path, body)
    expected = hmac.new(hmac_key.encode(), canonical.encode(),
                        hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        return False

    # Signature valid: record the nonce now. Half-eviction (discard oldest half)
    # instead of clear() so we never open a window where ALL prior nonces become
    # replayable at once.
    _seen_nonces[nonce] = int(time.time())
    if len(_seen_nonces) > NONCE_CACHE_MAX:
        for _ in range(NONCE_CACHE_EVICT):
            _seen_nonces.popitem(last=False)
    return True
