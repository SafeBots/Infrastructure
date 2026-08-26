# Safebox NixOS base (refactor.md Phases 0–2)

This tree is the declarative replacement for
`aws/scripts/components/base/install-base.sh`. It is the **v2 base** built in
parallel with the shippable v1 Amazon-Linux tree under `aws/` (which is
untouched — Phase 0.1/0.2).

## What's here (Phases 1–2, done)

```
nixos/
  flake.nix              # THE distro: pins nixpkgs by commit; 1 config -> 4 images
  modules/
    base.nix             # packages + docker/php/mariadb services (former dnf array)
    hardening.nix        # the Bug-5 zero-shell invariant, declaratively (stronger)
    zfs.nix              # the F2 fix: explicit mountpoints + encryption + mariadb tuning
    containers.nix       # the compose tier, UNCHANGED (contained app layer)
    measured-boot.nix    # Phase 3.1 measured boot (lanzaboote UKI) — ON in Model A
    app-verify.nix       # Model A category-2 guarantee: app-digest verification (ON)
    layers.nix           # Model B signed layers (OFF; slot reserved in the base)
  hosts/safebox.nix      # MODEL A launch profile — the shipping product
terraform/
  main.tf                # pick one cloud module per deployment
  modules/{aws,gcp,azure,oci}/main.tf   # confidential-VM provisioning per cloud
```

## Models A and B — Model A is the launch product

**Every safebox is Model A. Model B is Model A plus one capability.** They are
not alternatives; B adds in-place trust-root updates on top of A.

### Model A (SHIPPING) — attested blessed images, apps on the side

- Measured base (`measuredBoot.enable = true`), M-of-N-blessed image.
- Apps + data ride beside it on ZFS (README "category 2").
- **Update = reboot into a new blessed AMI**; apps and data come along.
- App containers are **digest-pinned and verified against the blessed base's
  allow-list before the app tier starts** (`app-verify.nix`, ON) — fail-closed.
  This is Model A's category-2 guarantee: the measured base gates which app
  containers may run, at digest granularity.
- This is `hosts/safebox.nix`. It is the whole product for launch.

### Model B (DESIGNED-IN, OFF) — in-place trust-root updates

- Adds signed Tier-1 ZFS software layers the measured base verifies before
  execution (`layers.nix`), so the trust-root software can update in place,
  under your own M-of-N, between AMI swaps.
- This is the **sovereignty upsell**, not the base product. Disabled at launch.
- **Reserved slot:** even with B off, the layer-verifier's home is reserved in
  the measured base, so enabling B later does **not** change M0 for Model-A
  users (no forced re-bless of every image). An A box and a B box differ by
  whether the layer dir is populated — not by the measured base's structure.

**Recommendation:** ship A, keep B dormant, and only pull B forward if a
concrete customer needs to patch the trust-root software without rebooting.
Most "frequent updates" are category-2 app updates, which A already handles.

## Build

```
cd nixos
# 1. Pin nixpkgs to an audited commit (replace PIN_ME_TO_A_COMMIT_SHA), then:
nix flake lock
# 2. Build a cloud image (Model A profile):
nix build .#ami     # or .#gce / .#azure / .#oci
# 3. Provision:
cd ../terraform && terraform apply   # after wiring the chosen cloud module
```

## Phase 0 decisions — RESOLVED

1. **F1/F3 authority — RESOLVED: host-authoritative.** nginx, mariadb, and php
   run as HOST services in the measured base (base.nix); the container tier
   (containers.nix) runs ADDITIONAL services only (model runners, tools, extra
   webservers behind the host nginx), never duplicates of the core daemons. A
   boot-time guard refuses a compose file that reintroduces a core-daemon
   duplicate. F1 is closed: the host nginx owns 80/443 AND is the nginx Autohost
   configures (it includes `/etc/nginx/conf.d/auto/*.conf`), so custom domains
   actually serve.
2. **Model A only — RESOLVED.** Launch is Model A; Model B (layers.nix) stays
   dormant with its verifier slot reserved in the measured base.

Remaining (not blocking the build):

- **Which cloud ships first** — recommend a SEV-SNP cloud (GCP/Azure) for the
  Phase-3 measurement milestone, where `sev-snp-measure` is mature.

## What is NOT done here (Phases 3–5 — hardware-gated / next)

Model A is BUILT (measured boot on, app-digest verification on, blessing/verify
PKI runnable — see `../attestation`). What remains needs real hardware or is
Model B:

- Per-cloud hardware-quote validators + the TPM seal/unseal round trip
  (`../attestation`, `zfs.nix` TODO) — the Phase-3 milestone, needs a real
  (v)TPM / SEV-SNP instance.
- Revocation transport (the "OCSP for measurements") — open design.
- Model B in-place layering (`layers.nix`) — dormant, slot reserved.

These are the substantive trust engineering; Phases 0–2 were "swap the base,
keep the stack." See refactor.md and ../attestation/README.md.

## What is measured vs what rides beside it (the distinction the model turns on)

Two fundamentally different things get "installed," they live in different
places, and only one of them is measured. Keeping them straight is the whole
trick.

### Category 1 — baked into the AMI (the MEASURED base)

Everything in the published NixOS image: the kernel, initrd, the core closure,
the hardening (ssh/ssm/getty removed), the daemons, and any containers pulled
in AT BUILD TIME. This is what measured boot measures.

- **Same on every clone.** Two people who clone the same published AMI and
  reboot re-measure to the SAME `M0`, because it's the byte-identical image.
- **This is what M-of-N auditors bless** — a blessing is a signature over this
  measurement (`attestation/bless`).
- **Re-measured from scratch every reboot** — but it comes out identical
  because the image didn't change. Stable `M0`.
- This is Tier 0 in `trust.html`.

### Category 2 — beside the base on separate ZFS (apps + data + app containers)

The tenant apps, their databases, their runtime state, and the app containers
running npm / composer / etc. These live on separate ZFS datasets
(`modules/zfs.nix`), are **NOT in the boot measurement**, and **persist across
reboots and across base swaps**.

This is the key move: because category 2 is on the side, you can **switch to a
different AMI** (also NixOS, also M-of-N-blessed, a NEW `M0`) and **keep the
apps and data** — they ride through the swap untouched. That is the Model-A
update path: reboot into a blessed image, data on the side.

### The caveat that makes category 2 safe

An app container running beside the measured base is **not itself measured**.
It survives the reboot, which means its integrity is NOT covered by the base's
attestation. So "apps check installed software and versions when they run" is
doing real, load-bearing work — that check is the only thing between "a blessed
base" and "a blessed base running arbitrary un-attested app code." Two ways to
make category 2 trustworthy, differing by model:

- **Model A (vendored):** app containers are **digest-pinned and contained**.
  The containment boundary backstops them; `app-verify.nix` verifies the
  container digests against the blessed base's allow-list (shipped in the
  measured base, part of M0) and refuses to start the app tier on a mismatch —
  fail-closed. The honest guarantee is *"apps are walled and digest-verified,"*
  not *"apps are attested."* **This is built and ON in the launch profile.**
- **Model B (personal inductive security):** to make the apps **attested**
  rather than merely contained, they move into **signed ZFS layers** that the
  measured base verifies before execution (`modules/layers.nix`, Phase 4). This
  is the opt-in upgrade.

### The update flow, end to end

```
  old blessed AMI (M0_old)  ──reboot──►  new blessed AMI (M0_new)
        │                                      │
        │  category-2 ZFS datasets (apps, data, app containers)
        └──────────────  ride through the swap, untouched  ──────────────┘
                                               │
                                               ▼
                    apps start, check "what base am I on now?"
                    (digest-verify against M0_new — Model A)
                    (or the base verified their signed layer — Model B)
```

The AMI swap changes **category 1's `M0`** (a new measurement the auditors
blessed). **Category 2 is never in the base measurement** — it persists beside
the base and re-verifies itself against the new base when it starts. That is
why you can update the trust-root image under M-of-N while keeping every app
and every byte of data in place.

## Faithful-port checklist (install-base.sh -> here)

- [x] SYSTEM_PACKAGES array           -> nixpkgs pin + base.nix
- [x] Bug-5 no-shell (ssh/ssm/getty)  -> hardening.nix (never in closure)
- [x] F2 ZFS mountpoints + encryption -> zfs.nix
- [x] MariaDB InnoDB<->ZFS tuning      -> base.nix (my.cnf) + zfs.nix (dataset)
- [x] Docker daemon.json hardening    -> base.nix virtualisation.docker.daemon.settings
- [x] PHP-FPM hardening (Bug-8)       -> base.nix services.phpfpm
- [x] auditd rules                    -> hardening.nix security.audit.rules
- [x] Container tier (compose)        -> containers.nix (de-duplicated; core
      nginx/mariadb/php removed — now host-authoritative; F1/F3 resolved)
- [ ] npm ci from lockfile            -> deferred: app-tier concern, runs in containers
- [ ] TPM key sealing                 -> Phase 3 (zfs.nix has the TODO marker)
