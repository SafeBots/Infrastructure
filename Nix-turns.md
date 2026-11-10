# Making it happen in 4 turns

The plan to turn `Nix.md` from design into a shipping, reproducibly-built, attested, multi-cloud image. Each turn is a coherent chunk of work with a clear end state. Turns 1–2 are doable in-repo/CI; Turns 3–4 are gated on real confidential-compute hardware, one cloud at a time. Companion to `Nix.md` (the what/how); this is the do-it.

## Turn 1 — Pin, lock, and prove the flake builds a bootable image

The gate. Nothing downstream is real until the flake is pinned and proven to build.

- Replace the `PIN_ME_TO_A_COMMIT_SHA` placeholder in `nixos/flake.nix` with a real, audited nixpkgs commit SHA (target NixOS 26.05 (current stable) or later, which also positions the `nixos-generators` → in-nixpkgs `system.build.images` migration).
- Run `nix flake lock` to write and commit `flake.lock` — this is the reproducibility guarantee; without a committed lock, nothing reproduces.
- `nix flake check` and `nixos-rebuild build --flake .#safebox` to confirm the config evaluates and yields a bootable closure. Resolve eval errors — chiefly the container image digests currently stubbed in `nixos/hosts/safebox.nix`.
- `nix build .#ami-builder` (and `.#gce-builder`, `.#azure-builder`, `.#oci-builder`, `.#ibm-builder`, `.#alibaba-builder`) to confirm each cloud's builder image actually generates.

**End state:** a locked flake that reproducibly builds a bootable builder image for all six clouds. **Runbook:** the exact copy-pasteable steps (with every eval/build blocker pre-triaged) are in [`nixos/TURN1-RUNBOOK.md`](nixos/TURN1-RUNBOOK.md).

**Blocker:** needs a real Nix evaluator with `cache.nixos.org` reachable — not available in the current test container, so this is a real-machine/CI step, not an in-repo edit.

## Turn 2 — Reach strict parity with the dnf base, then delete it — DONE (parity established)

Prove the NixOS host does everything the Amazon-Linux/dnf base did, so `install-base.sh` can be removed and there is one base, not two.

Status: the full diff of `install-base.sh` against `base.nix` + `hardening.nix` + `containers.nix` is complete and documented in **`nixos/PARITY.md`**. The port was already faithful for packages, docker daemon.json, nginx, php-fpm (with a *stronger* systemd seccomp sandbox than the shell version), mariadb tuning, and shell-channel elimination. The diff found and closed four real gaps:

- **fail2ban was package-only** — now enabled as a running service (`services.fail2ban.enable`), matching install-base.sh's fail2ban-1.0.2 service.
- **auditd rules were incomplete** — added the npm/composer exec watches and the nginx config watch; mapped the dnf/rpm watches onto `/nix/store` exec provenance (no dnf/rpm on NixOS).
- **SSM/getty absence was a comment, not enforced** — added build-time assertions that `amazon-ssm-agent` and getty-autologin stay off, so the build fails rather than a runtime check catching it late.
- **directory/permission structure was partial** — added tmpfiles rules for `/opt/safebox{,/manifests,/lib,/bin}`, `/srv/safebox/runtimes/system`, `/safebox/nginx/ssl` (0710), `/safebox/mariadb/data` (0700) with the exact owners/modes install-base.sh set.

The four Node components (system, dnsclient, autohost, model supply chain) install unchanged — they only need systemd + node ≥20 + the safebox paths, all provided.

**End state reached:** `nixos/PARITY.md` proves the NixOS host is a strict superset of the dnf base. Deleting `install-base.sh` is authorized by this parity but is done in Turn 4 alongside the build-pipeline rewrite (so nothing is removed before Turn 1 confirms the closure builds). This turn was doable in-repo now (analysis + Nix module edits, no hardware boot).

## Turn 3 — Verify attestation on real confidential hardware, per cloud, staggered

The one part that cannot be faked in CI: does *our* sealed image produce a valid attestation on *each* cloud's confidential silicon. Do it in maturity order.

For each cloud: `nix build .#<cloud>-builder` → register → boot a confidential instance → run `attestation/image-seal/seal-image.sh` → re-register the sealed image → boot it confidential → confirm three things: (1) it boots and networks; (2) the vTPM/NitroTPM (or SEV-SNP report) produces a valid attestation whose signature chains to the hardware root; (3) the PCRs (or launch measurement) equal the reference measurement independently computed from the pinned source.

- **AWS first** (lowest risk — we already attest via `/dev/nsm`; validate the Nix UKI + `nitro-tpm-pcr-compute` reference PCRs match live).
- **GCP, Azure next** (mature vTPM + SEV-SNP; go-tpm-tools / MAA).
- **Oracle, IBM** (SEV-SNP; on OCI use E5/E6 shapes and BYAS — and resolve the no-Secure-Boot-on-custom-images caveat by relying on SEV-SNP launch attestation).
- **Alibaba last** (region-gated confidential; attest where available).

Anything missing (a kernel module, an agent) is added to the flake declaratively and re-tested — leaving a better-documented base than any vendor distro, because every cloud dependency is explicit.

**Runbook:** per-cloud launch/fetch-quote/compare steps mapped to existing repo tooling are in [`attestation/TURN3-ATTESTATION-RUNBOOK.md`](attestation/TURN3-ATTESTATION-RUNBOOK.md).

**End state:** a per-cloud attestation report showing the sealed image attests correctly, with the two real caveats (OCI Secure Boot, Alibaba regions) documented as resolved-or-scoped. **Blocker:** real confidential instances per cloud; staggered over days/weeks, not one CI run.

## Turn 4 — Wire build+seal+publish into one pipeline and reconcile everything

Make it a single operable flow and align every claim in the repo with the now-true reality.

- Rewrite `aws/scripts/build-ami.sh` (rename — it is no longer AMI-only) into a per-cloud pipeline: `nix build .#<cloud>-builder` → boot → `seal-image.sh` → register sealed image → (optional) submit to that cloud's marketplace.
- Wire the per-instance identity step: on first boot, derive the AK from the instance EK, seal the box's signing key to the blessed measurement, and register the instance's attestation with the control plane (generalizing what dnsclient does on AWS today to every cloud's vTPM).
- Run `verify-ami2-reproduces.sh` with diffoscope on two independent builds per cloud to confirm byte-identical sealed output on real images.
- Delete `install-base.sh` and the dnf branch. Update `README.md` (base is NixOS, reproducible, six clouds, attested), fix the repo tagline so "based on NixOS" is finally true, drop the "detect distro and dnf/apt install" bootstrap step, and re-point the LICENSE's "recompile it and verify that it is correct" promise at the now-reproducible artifact.

**Runbook:** the pipeline rewrite, per-instance identity wiring, and guarded-deletion ordering are specified in [`aws/scripts/TURN4-PIPELINE.md`](aws/scripts/TURN4-PIPELINE.md).

**End state:** one base, one build, reproducible and attested across all six clouds, each instance holding a unique attestation-sealed identity, and every doc/claim matching reality.

## Sequencing and the honest risk line

Turns 1–2 produce "one reproducible NixOS image that boots and matches the old base" and are doable now on a Nix-capable machine. Turn 3 is hardware-gated and staggered — it is the difference between "we build one reproducible base" (soon) and "it is attested on all six clouds" (weeks, cloud-by-cloud, AWS first). The biggest real unknown is not packages (ported) or image formats (confirmed) but confidential-attestation of our image on each cloud's silicon — retired by one boot test per cloud. Two caveats are known in advance and scoped in `Nix.md`: OCI custom images lack Secure Boot (rely on SEV-SNP launch attestation), and Alibaba confidential availability is region-limited. Start with Turn 1 on a real Nix machine; everything else follows from the flake actually building.
