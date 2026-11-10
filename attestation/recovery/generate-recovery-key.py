#!/usr/bin/env python3
"""generate-recovery-key.py — HKDF break-glass recovery key (operator-requested).

This script runs INSIDE a live Safebox when the operator voluntarily requests a
recovery key. It:
  1. Derives a recovery key from the master secret via HKDF-SHA256.
  2. Wraps the data-encryption key under KDF(recovery_key, attestation_context).
  3. Stores the wrapped blob (with expiry) in the key dataset.
  4. Outputs the recovery key ONCE (the operator saves it), then discards it.

The recovery key is useless without a blessed Safebox (attestation is the second
factor). An operator with the key but no blessed instance gets nothing. See
KEY-CONTINUITY.md for the full design.

Quantum-resistant: HKDF-SHA256 is symmetric (no RSA/EC). 256-bit key gives
128-bit post-quantum security (standard target under Grover's).
"""
from __future__ import annotations
import hashlib, hmac, json, os, sys, time
from base64 import b64encode, b64decode
from pathlib import Path


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int = 32) -> bytes:
    """HKDF-SHA256 extract-then-expand (RFC 5869)."""
    # extract
    prk = hmac.new(salt or b'\x00' * 32, ikm, hashlib.sha256).digest()
    # expand
    t, okm = b'', b''
    for i in range(1, (length + 31) // 32 + 1):
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest()
        okm += t
    return okm[:length]


def generate_recovery_key(
    master_secret: bytes,
    instance_id: str,
    attestation_context: bytes,
    data_key: bytes,
    expiry_days: int = 30,
    output_dir: str = "/safebox/keys/recovery"
) -> str:
    """Generate the recovery key and wrapped blob. Returns the recovery key
    as a hex string (display to operator once, then discard)."""

    timestamp = int(time.time())
    expiry = timestamp + (expiry_days * 86400)

    # 1. Derive the recovery key from the master secret
    info = f"recovery|{instance_id}|{timestamp}".encode()
    recovery_key = hkdf_sha256(master_secret, b'safebox-recovery-salt', info, 32)

    # 2. Derive the unwrapping key from recovery_key + attestation_context
    unwrap_key = hkdf_sha256(
        recovery_key,
        attestation_context,
        b'safebox-recovery-unwrap', 32
    )

    # 3. Wrap the data key (XOR for simplicity in the reference; production
    #    would use AES-256-GCM keywrap or similar authenticated encryption)
    if len(data_key) != 32:
        raise ValueError("data_key must be 32 bytes")
    # AES-256 key wrap would go here in production; for the reference
    # implementation, use a simple authenticated construction:
    nonce = os.urandom(12)
    # HMAC-based authenticated wrap: ciphertext = XOR(data_key, expand(unwrap_key))
    # + HMAC tag for integrity
    stream = hkdf_sha256(unwrap_key, nonce, b'wrap-stream', 32)
    wrapped_key = bytes(a ^ b for a, b in zip(data_key, stream))
    tag = hmac.new(unwrap_key, nonce + wrapped_key, hashlib.sha256).digest()

    # 4. Build the recovery blob
    blob = {
        "version": 1,
        "instance_id": instance_id,
        "created": timestamp,
        "expiry": expiry,
        "expiry_days": expiry_days,
        "nonce": b64encode(nonce).decode(),
        "wrapped_key": b64encode(wrapped_key).decode(),
        "tag": b64encode(tag).decode(),
        "attestation_context_hash": hashlib.sha256(attestation_context).hexdigest()[:16],
        "note": "Recovery key required + blessed Safebox attestation. Neither alone suffices."
    }

    # 5. Store the blob in the key dataset
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    blob_path = out / "recovery-blob.json"
    blob_path.write_text(json.dumps(blob, indent=2))

    # 6. Log the request (auditable — survives replication)
    log_path = out / "recovery-requests.log"
    with open(log_path, 'a') as f:
        f.write(json.dumps({
            "event": "recovery_key_generated",
            "instance_id": instance_id,
            "timestamp": timestamp,
            "expiry": expiry,
            "operator_requested": True
        }) + '\n')

    return recovery_key.hex()


def recover_data_key(
    recovery_key_hex: str,
    attestation_context: bytes,
    blob_path: str = "/safebox/keys/recovery/recovery-blob.json"
) -> bytes:
    """Use the recovery key + attestation to unwrap the data key.
    Returns the data key, or raises on failure."""

    recovery_key = bytes.fromhex(recovery_key_hex)
    blob = json.loads(Path(blob_path).read_text())

    # Check version
    if blob.get("version") != 1:
        raise ValueError(f"Unknown recovery blob version: {blob.get('version')}")

    # Check expiry
    if int(time.time()) > blob["expiry"]:
        raise ValueError(f"Recovery key expired (expired {blob['expiry']}, now {int(time.time())})")

    # Derive the unwrapping key (same as generation)
    unwrap_key = hkdf_sha256(
        recovery_key,
        attestation_context,
        b'safebox-recovery-unwrap', 32
    )

    # Verify tag (integrity)
    nonce = b64decode(blob["nonce"])
    wrapped_key = b64decode(blob["wrapped_key"])
    expected_tag = hmac.new(unwrap_key, nonce + wrapped_key, hashlib.sha256).digest()
    actual_tag = b64decode(blob["tag"])
    if not hmac.compare_digest(expected_tag, actual_tag):
        raise ValueError("Recovery failed: wrong recovery key, wrong attestation, or tampered blob")

    # Unwrap
    stream = hkdf_sha256(unwrap_key, nonce, b'wrap-stream', 32)
    data_key = bytes(a ^ b for a, b in zip(wrapped_key, stream))
    return data_key


if __name__ == "__main__":
    # Demo / self-test
    master = os.urandom(32)
    data_key = os.urandom(32)
    attest = os.urandom(32)  # in production: hash of the blessed measurement + auditor sig

    rk = generate_recovery_key(master, "test-instance-001", attest, data_key,
                               expiry_days=1, output_dir="/tmp/safebox-recovery-test")
    print(f"Recovery key (display once to operator): {rk}")

    recovered = recover_data_key(rk, attest, "/tmp/safebox-recovery-test/recovery-blob.json")
    assert recovered == data_key, "ROUND-TRIP FAILED"
    print("✓ round-trip: recovery key + attestation → data key recovered")

    # wrong recovery key fails
    try:
        recover_data_key("00" * 32, attest, "/tmp/safebox-recovery-test/recovery-blob.json")
        assert False, "should have failed"
    except ValueError as e:
        print(f"✓ wrong recovery key rejected: {e}")

    # wrong attestation fails
    try:
        recover_data_key(rk, os.urandom(32), "/tmp/safebox-recovery-test/recovery-blob.json")
        assert False, "should have failed"
    except ValueError as e:
        print(f"✓ wrong attestation rejected: {e}")

    print("\n✓ all safety properties hold: two-factor (recovery key + attestation), expiry, integrity")
