# Two-AMI seal: deterministic attested image from a non-deterministic builder

## Why this exists

Attestation measures a hash (a PCR). A hash needs **100%** bit-for-bit
reproducibility or it mismatches and the box attests as "not the blessed image."
Nix is only **~91%** bit-reproducible in practice — the gap is dominated by
embedded timestamps and inode mtimes (about 15% of Nix unreproducibility is
embedded build dates alone). **91%, even 99%, is useless for a PCR.**

So we do not rely on the whole Nix closure being bit-identical. We use two images:

- **AMI-1 (builder)** — `nix build .#<cloud>-builder` (ami/gce/azure/oci/ibm/alibaba).
  Same closure as production, plus exactly **one** ingress channel: **SSH, and
  nothing else** — no telnet, no AWS SSM, no Azure/GCP console agents, no serial
  getty (all asserted absent at build time in `hosts/ami1-builder.nix`). AMI-1
  does the heavy lifting; it does **not** need to be bit-reproducible, because it
  is the builder, not the thing attested.
- **The seal** — `seal-ami2.sh`, a short, fully-auditable script you run once on
  a booted AMI-1. It (1) tears down SSH and every login path, (2) removes key
  material and machine identity, and (3) normalizes the enumerated set of
  nondeterminism sources (mtimes, host keys, machine-id, logs, seeds, leases,
  cloud-init state, caches, tmp).
- **AMI-2 (attested)** — the image produced from the sealed AMI-1. Its
  measurement is deterministic **because the seal explicitly constant-ises every
  variable field**, not because 40,000 nixpkgs derivations all happened to be
  deterministic. The determinism guarantee lives in a script a human can read in
  full (`wc -l seal-ami2.sh` ≈ 90 lines), not in a build graph no one can audit.

This is the construction the verification patent describes: a simple script on a
Nix-built machine produces the attested image, and that image is reproducible by
re-invoking the script — because the script's whole job is to remove the things
that vary.

## The critical exclusion: /nix/store

`seal-ami2.sh` normalizes mtimes **everywhere except `/nix/store`**. Store paths
are content-addressed and their internal mtimes are already canonical (epoch 1);
touching them would **change their hashes and break the closure**. Normalize
outside the store only. `test-seal-coverage.py` asserts this exclusion is present.

## Proven in CI (not just claimed)

`test-determinism.sh` runs in the aggregator every time. It builds two rootfs
fixtures that differ in every nondeterminism class (mtimes, host keys,
machine-id, logs, seeds, cloud-init, caches, tmp), seals both, and asserts the
sealed trees are **byte-identical**, that `/nix/store` mtimes are **preserved**
(closure intact), that blessed content survives, and — critically — that the
check **has teeth** (an uncovered nondeterminism source is caught, not missed).
On real images, `verify-ami2-reproduces.sh` does the same with two actual builds
and diffoscope.

## Proving it (don't assume — test)

"AMI-2 is deterministic" is a claim to be tested the way the reproducible-builds
community tests anything: build twice, `diffoscope`, expect zero diff.
`verify-ami2-reproduces.sh` seals two independent AMI-1 builds and diffs them. A
diff names the nondeterminism source that escaped the scrub — add a line to
`seal-ami2.sh`, add it to `nondeterminism-checklist.json`, re-run. Zero diff means
the enumerated checklist is complete.

## Files

- `seal-ami2.sh` — the teardown + normalization pass (run on booted AMI-1).
- `verify-ami2-reproduces.sh` — build-twice + diffoscope determinism check.
- `nondeterminism-checklist.json` — the human-auditable taxonomy of what the seal
  neutralizes, plus the `/nix/store` exclusion rationale.
- `test-seal-coverage.py` — asserts the seal addresses every checklist source and
  keeps the store exclusion (in the CI aggregator).

## Same Nix for every cloud

``.#<cloud>-builder` are the **same NixOS config** in six-cloud image
formats — only the cloud image wrapper differs. The seal is cloud-agnostic. So
AWS, GCP, Azure, Oracle, IBM, and Alibaba all run the identical builder→seal→attest flow, and
the only per-cloud variable is the attestation root (NitroTPM vs SEV-SNP/TDX
vTPM), handled in the attestation-consumption layer, not here.
