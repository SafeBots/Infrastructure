#!/usr/bin/env python3
"""
attestation/bless/transparency-log.py   (refactor.md Phase 5.3)

An append-only transparency log for auditor blessings — the accountability
mechanism from trust.html. Certificate Transparency was web PKI's answer to CA
mis-issuance; this is ours. Every blessing (an auditor signing a measurement)
is published here so:
  - anyone can audit which auditor blessed which measurement, when;
  - a bad/careless auditor is DISCOVERABLE (paired with the injected-vuln
    benchmark that measures auditor competence, Phase 5);
  - sybil auditors can't hide — their blessings are on the record and their
    (in)competence is measurable.

The log is a hash-chain (each entry commits to the previous head), so entries
cannot be silently removed or reordered without detection. This is a reference
implementation of the DATA STRUCTURE and its invariants; a production deployment
would back it with a witnessed, replicated log (e.g. a Merkle-tree transparency
service) — but the append-only hash-chain contract is the stable core.
"""
import argparse
import datetime as dt
import hashlib
import json
import sys
from pathlib import Path


def entry_hash(prev_head: str, payload: dict) -> str:
    body = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256((prev_head + body).encode()).hexdigest()


def load_log(path: Path) -> list:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def cmd_append(args) -> None:
    log = load_log(args.log)
    prev_head = log[-1]["entry_hash"] if log else ("00" * 32)
    blessing = json.loads(args.blessing.read_text())
    payload = {
        "seq": len(log),
        "logged_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "measurement_id": blessing["blessing"]["measurement_id"],
        "auditor": blessing["blessing"]["auditor"],
        "expires_at": blessing["blessing"]["expires_at"],
        "auditor_pubkey_b64": blessing["auditor_pubkey_b64"],
        "signature_b64": blessing["signature_b64"],
    }
    payload["prev_head"] = prev_head
    h = entry_hash(prev_head, payload)
    payload["entry_hash"] = h
    with args.log.open("a") as f:
        f.write(json.dumps(payload) + "\n")
    print(f"Appended seq={payload['seq']} "
          f"(measurement {payload['measurement_id']}, auditor {payload['auditor']}).")
    print(f"  new head: {h}")


def cmd_verify(args) -> None:
    """Re-derive the whole chain; detect any tamper/removal/reorder."""
    log = load_log(args.log)
    prev = "00" * 32
    for i, e in enumerate(log):
        if e["seq"] != i:
            sys.exit(f"BROKEN: seq gap at index {i} (got {e['seq']}).")
        if e["prev_head"] != prev:
            sys.exit(f"BROKEN: prev_head mismatch at seq {i}.")
        body = {k: e[k] for k in e if k != "entry_hash"}
        if entry_hash(e["prev_head"], body) != e["entry_hash"]:
            sys.exit(f"BROKEN: entry_hash mismatch at seq {i} — entry tampered.")
        prev = e["entry_hash"]
    print(f"OK: {len(log)} entries, chain intact. Head: {prev}")


def cmd_audit(args) -> None:
    """Everything a given auditor has ever blessed (accountability query)."""
    log = load_log(args.log)
    hits = [e for e in log if e["auditor"] == args.auditor]
    print(f"Auditor {args.auditor}: {len(hits)} blessings")
    for e in hits:
        print(f"  seq {e['seq']}: measurement {e['measurement_id']} "
              f"(expires {e['expires_at']})")


def main() -> None:
    ap = argparse.ArgumentParser(description="Auditor blessing transparency log")
    sub = ap.add_subparsers(required=True)
    a = sub.add_parser("append"); a.add_argument("--log", type=Path, required=True)
    a.add_argument("--blessing", type=Path, required=True); a.set_defaults(func=cmd_append)
    v = sub.add_parser("verify"); v.add_argument("--log", type=Path, required=True)
    v.set_defaults(func=cmd_verify)
    d = sub.add_parser("audit"); d.add_argument("--log", type=Path, required=True)
    d.add_argument("--auditor", required=True); d.set_defaults(func=cmd_audit)
    args = ap.parse_args(); args.func(args)


if __name__ == "__main__":
    main()
