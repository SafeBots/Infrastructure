# Safebox attestation pipeline (refactor.md Phases 3–5)

This tree is the trust engineering that sits on top of the reproducible NixOS
base (Phases 0–2, in `../nixos/`). It implements attestation-that-survives-
updates and the auditor PKI from `trust.html`.

**Honesty about state.** This is the hard 20%. Some of it is complete,
runnable code; some is correct-by-construction config that can only be
*exercised* on real confidential-compute hardware; some is a reference
implementation of a data structure whose production form is heavier. Each file
says which it is. Nothing here emits a fake measurement or a fake signature —
where a real tool or a TPM is required and absent, the code fails loudly,
because a plausible-looking fake attestation is worse than an obvious gap.

## The flow (how the pieces compose)

```
   reproducible NixOS image (../nixos)
            │
            ▼
   measure/precompute-measurement.py     Phase 3.2
   → expected measurement M, computed BEFORE boot from the image
            │
            ▼
   bless/bless-measurement.py  (sign, then combine)   Phase 3.4
   → M-of-N auditors sign M into an approved-set entry (the "certificate")
            │
            ├──► bless/transparency-log.py            Phase 5.3
            │    → blessing published append-only for auditor accountability
            │
            ▼
   seal/seal-key-to-policy.sh            Phase 3.3   [needs a TPM]
   → ZFS keys sealed to the M-of-N POLICY, not to M — so approved updates
     (new M + new blessing) still unseal, tamper does not
            │
            ▼
   running instance presents its attestation doc + blessing
            │
            ▼
   verify/verify-attestation.py          Phase 3.4 / 5.3
   → relying party (browser) checks: attested M ∈ set signed by M-of-N of the
     auditors THIS USER trusts, and still fresh (not expired/revoked) → KOSHER
```

## Files

| File | Phase | State |
|---|---|---|
| `measure/precompute-measurement.py` | 3.2 | Runnable; SEV path needs `sev-snp-measure`, AWS path needs the AMI build's measured-component list. Fails loudly without them. |
| `bless/bless-measurement.py` | 3.4 | **Complete, runnable** (Ed25519 via PyNaCl). Sign + combine M-of-N. |
| `bless/transparency-log.py` | 5.3 | **Complete, runnable** reference (append-only hash-chain). Production = witnessed Merkle log. |
| `seal/seal-key-to-policy.sh` | 3.3 | Correct-by-construction; **requires a TPM**. The load-bearing PolicyAuthorize seal. |
| `../nixos/modules/scripts/unseal-zfs-key.sh` | 3.3 | Correct-by-construction; **requires a TPM**. Boot-time unseal; lives inside the flake root (see `seal/UNSEAL-MOVED.md`) and is shipped INTO the measured base via `zfs.nix` so the unseal logic is itself measured. Wired into the ZFS dataset service. |
| `verify/verify-attestation.py` | 3.4/5.3 | **Complete, runnable** auditor-PKI layer; consumes a hardware-verified record + a signed revocation feed. |
| `verify/hardware/validate-quote.py` | 3.4 | **Real chain-verification code** for SEV-SNP (AMD), NitroTPM (AWS), TDX (Intel); **needs a real quote + vendor roots** to run — fails loudly without them (never fakes a pass). |
| `revoke/revocation-feed.py` | 5.3 | **Complete, runnable** — the "OCSP for measurements": signed, freshness-stamped, monotonic (anti-rollback) revocation feed. publish + check. |

## What still needs real hardware (the irreducible remainder)

Everything the auditor-PKI *logic* covers is now built and tested end to end
(bless → combine → transparency-log → verify → revoke, all runnable). The
remainder is exactly what cannot be exercised without confidential-compute
silicon:

1. **Running the hardware-quote validators against a real quote.**
   `verify/hardware/validate-quote.py` implements the real AMD/AWS/Intel chain
   checks, but a real SEV-SNP report / NitroTPM doc / TDX quote only exists on a
   real confidential instance. On a dev box it fails loudly (by design).
2. **The seal/unseal round trip on a live (v)TPM.** `seal-key-to-policy.sh` +
   `unseal-zfs-key.sh`, exercised through `zfs.nix`. This is the Phase-3
   milestone that proves attestation-survives-updates on actual hardware.

That's it — the remaining gap is silicon, not design. Everything above the
hardware line is implemented and tested.

## Model A vs Model B

Everything here serves **Model A** (vendored blessed images) too: A still needs
measurement (3.2), blessing (3.4), sealing (3.3), and verification. The only
Model-B-specific piece is `../nixos/modules/layers.nix` (signed Tier-1 software
layers). A ships without it.
