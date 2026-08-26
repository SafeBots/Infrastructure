# Per-mapping M-of-N approval for object storage

The object-storage backend (`storage/object-backend.sh`) relaxes egress. So each
destination mapping is auditor-blessed, exactly like a measurement — same
Ed25519 / canonical-JSON / M-of-N machinery as `attestation/bless/`.

## Flow

1. **Sign** (each auditor, off-box):
   `bless-mapping.py sign --mapping m.json --signing-key auditor.seed --signer id > sig.json`
   where `m.json` is `{"kind","bucket","endpoint"?,"prefix"?}`.
2. **Combine** M signatures into a blessed-set entry:
   `bless-mapping.py combine --signatures sig1.json sig2.json --threshold 2 > entry.json`
3. **Ship** the array of entries as `/etc/safebox/blessed-storage-mappings.json`
   in the measured base (so tampering changes M0 and fails attestation), alongside
   `/etc/safebox/trusted-auditor-keys.json` (the pubkeys the box trusts).
4. At runtime `object-backend.sh` calls `verify-mapping.py` before any read/write.
   Not blessed, under threshold, or signed only by untrusted keys => refused,
   fail-closed.

## What the blessing binds

Exactly the egress destination: `kind + bucket + endpoint + prefix`. Change any of
them (a different bucket, a different endpoint) and the `mapping_id` changes, so it
needs re-blessing. You cannot bless "S3 in general" — only specific buckets.

## Tested

`test-mapping-approval.sh` (in the CI aggregator) proves: a 2-of-3 blessed mapping
is accepted; a different bucket is refused; an under-threshold set is refused; and
a signature from an untrusted auditor does not count toward M.
