# Turn 4 — one build+seal+publish pipeline, guarded deletion, doc reconciliation

Turn 4 collapses the two build paths into one and makes every claim in the repo
true. Like Turns 1 and 3, its build/hardware parts cannot run in CI — they need a
Nix machine and cloud accounts. This spec makes the executable steps concrete and
ordered, and does the doc reconciliation that CAN be done in-repo now.

## Hard ordering constraint (why deletion is last, not first)

`install-base.sh` is the ONLY path that builds a bootable base today, because the
NixOS build (Turn 1) has not yet been proven on a real Nix machine. Deleting it
before Turn 1 passes would leave the repo with NO working build path. Therefore:

  Turn 1 (build proven) -> Turn 4 pipeline rewrite -> THEN delete install-base.sh.

Deletion is guarded on `nixos-rebuild build .#safebox` succeeding and at least one
`.#<cloud>-builder` producing an image. Until then, install-base.sh stays, and the
many NixOS modules/docs that reference it ("faithful port of install-base.sh's
daemon.json", "Tier 3", etc.) keep their provenance links — those references are
documentation value, not dead code, and should be preserved when the file goes by
converting them to reference PARITY.md instead.

## Step 1 — Rewrite build-ami.sh into build.sh (build + seal + publish)

Today `build-ami.sh <components>` runs shell installers on Amazon Linux. Replace
it with a per-cloud pipeline over the flake:

```
build.sh <cloud>          # cloud in: aws gcp azure oci ibm alibaba
  1. nix build .#<cloud>-builder        # reproducible SSH-ingress builder image
  2. launch builder, get address
  3. ssh in, run attestation/image-seal/seal-image.sh   # remove SSH, normalize
  4. image the sealed rootfs -> the cloud's format
  5. register the sealed image (custom image / marketplace)
  6. record the image id + its precomputed reference measurement
```

Keep it thin and auditable (the current build-ami.sh is ~40 lines; this is similar
plus the seal + register calls). The component model (`base,system`) is obsolete —
the base is the whole NixOS closure now, and system/dnsclient/autohost install onto
it as Node services (PARITY.md "four Node components").

## Step 2 — Wire per-instance identity into first boot

Generalize what dnsclient does on AWS today to every cloud's vTPM:

```
on first boot (systemd oneshot, before app tier):
  1. read the instance's vTPM Endorsement Key (per-instance unique)
     - aws: /dev/nsm attestation doc PCRs
     - gcp: get-shielded-identity EKPub / go-tpm-tools
     - azure: guest-attestation vTPM AKPub
     - oci/ibm: SEV-SNP report
  2. derive an Attestation Key (AK) from the EK
  3. seal the box signing key to the blessed boot measurement
     (released by the TPM only when PCRs match the blessed image)
  4. register the instance's attestation with the control plane
```

This is the "each instance has its own unique thing, from which private signing
keys can be derived/delegated" property from Nix.md, made operational. The sealing
means a signing key minted on a blessed box cannot be extracted to another box.

## Step 3 — Prove reproducibility on real images

```
verify-ami2-reproduces.sh   # already in attestation/image-seal/
  build .#<cloud>-builder twice independently
  seal both
  diffoscope the sealed rootfs trees -> expect ZERO diff
```

The determinism test already passes on fixtures; this is the real-image
confirmation. Hardware/Nix-gated.

## Step 4 — Guarded deletion + doc reconciliation (the in-repo-now part)

Once Steps 1–3 pass on a real machine:

- Delete `aws/scripts/components/base/install-base.sh` and the dnf branch of the
  build script. Convert the ~8 NixOS-module/doc references to it into references
  to `nixos/PARITY.md` (which preserves the provenance without the dead file).
- README: change the tagline and the "1.0 base" framing from Amazon-Linux/dnf to
  reproducible NixOS across six clouds; drop the "detect distro and dnf/apt
  install" bootstrap step.
- LICENSE: the "recompile it and verify that it is correct" promise now points at
  a genuinely reproducible artifact — no text change needed, but it becomes TRUE.
- Tagline: "based on NixOS" becomes accurate (it currently overstates — see the
  README-tagline note).

## Status

Steps 1–3 are specified and mapped to real repo tooling but are Nix/hardware-gated
(same gate as Turns 1 and 3). Step 4's deletion is guarded on Steps 1–3 passing, so
it is NOT done here — doing it now would delete the only working build path. What IS
done now: this spec, and the honest-tagline reconciliation in the README (below),
which does not depend on the build.
