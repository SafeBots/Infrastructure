# Turn 1 runbook — pin, lock, and prove the flake builds

Run this on a machine with Nix installed and network access to `cache.nixos.org` and `github.com`. It cannot run in the Safebox CI container (no nix binary; cache.nixos.org and github are blocked there). Every step below is copy-pasteable; the "why" notes flag the blockers already triaged in-repo so you hit none of them by surprise.

## 0. Prerequisites

```
nix --version            # need Nix 2.18+ with flakes enabled
# if flakes aren't on: add to ~/.config/nix/nix.conf:
#   experimental-features = nix-command flakes
```

## 1. Pick and pin the nixpkgs commit

26.05 "Yarara" is current stable (25.05 is EOL as of 2026). Two ways:

**Option A — pin the channel branch, let the lock record the exact rev (simplest):**
```
cd nixos
# edit flake.nix: replace the nixpkgs.url line with:
#   nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
nix flake lock            # writes flake.lock pinning the precise commit + hash
```

**Option B — pin an exact audited commit (most control):**
```
curl -I https://channels.nixos.org/nixos-26.05   # read the commit from the headers
# edit flake.nix: nixpkgs.url = "github:NixOS/nixpkgs/<that-40-char-sha>";
cd nixos && nix flake lock
```

Commit `flake.lock` to the repo. That file IS the reproducibility guarantee —
without it, nothing reproduces.

## 2. Evaluate and build the bootable system

```
nix flake check                              # evaluates all outputs, runs checks
nixos-rebuild build --flake .#safebox        # builds the system closure (no switch)
```

### Blockers already triaged (what to expect / fix)

- **measuredBoot is ENABLED** (`hosts/safebox.nix: safebox.measuredBoot.enable = true`).
  lanzaboote needs a signing-key directory (`signingKeyDir`) to build the signed
  UKI. For a first *eval/build smoke test*, either generate a throwaway key pair
  and point `signingKeyDir` at it, or temporarily set `safebox.measuredBoot.enable
  = false` to confirm the rest of the closure builds, then re-enable with real keys.
  Do NOT ship with throwaway keys — production keys are the auditor signing keys.

- **appVerify allowedDigests is empty** (`hosts/safebox.nix`). This EVALUATES
  fine (empty list); app-verify just fail-closes at runtime until you fill the
  digests. For a boot smoke test that starts app containers, populate it from the
  digest-pinned compose file first. For a pure "does it build" test, leave empty.

- **ami1-builder has REPLACE_WITH_BUILDER_PUBLIC_KEY** (`hosts/ami1-builder.nix`).
  This evaluates (it's a string) but is a broken SSH key. Before building a
  *builder image you'll actually SSH into*, replace it with a real ed25519 public
  key. Not needed for `.#safebox` (the sealed config, no SSH).

- **egress-defaults has placeholder IPs** (`10.0.0.0/32`, `10.0.0.1`) marked
  REPLACE. These evaluate fine; set them to the real backup-peer and proxy IPs
  before a deployment, not before a build test.

- **container image digests are comments** in `hosts/safebox.nix` — they do NOT
  block eval. Fill them when you wire app-verify for a real image.

## 3. Build each cloud's builder image

```
nix build .#ami-builder       # AWS
nix build .#gce-builder       # GCP
nix build .#azure-builder     # Azure
nix build .#oci-builder       # Oracle
nix build .#ibm-builder       # IBM
nix build .#alibaba-builder   # Alibaba
```

Each should produce a disk image in that cloud's format. If a format errors,
note it — the AWS/GCP/Azure formats are native and lowest-risk; OCI/IBM/Alibaba
use qcow and import per-cloud.

## 4. End state / done criteria

- `flake.lock` committed, pinning nixpkgs to a real 26.05 commit.
- `nix flake check` passes.
- `nixos-rebuild build --flake .#safebox` produces a bootable closure.
- `nix build .#ami-builder` (at minimum) produces an image.

When those four hold, Turn 1 is done and Turn 2 (parity with install-base.sh,
then delete it) can proceed. Turn 3 (real-hardware attestation) is gated on
cloud instances, per Nix-turns.md.

## Note on the nixos-generators retirement

The flake still uses the `nixos-generators` input. As of NixOS 25.05+ its
functionality is upstreamed into nixpkgs as `config.system.build.images.<fmt>`.
For the first shipping build, pinning nixos-generators is fine. As a fast-follow,
migrate the `packages.${system}` outputs from `nixos-generators.nixosGenerate`
to `self.nixosConfigurations.<host>.config.system.build.images.<fmt>` and drop
the input. Same images; one fewer dependency.
