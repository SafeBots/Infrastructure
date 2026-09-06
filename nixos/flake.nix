{
  # Safebox NixOS base — Phase 1-2 of refactor.md.
  #
  # This flake IS the "distro": the pinned nixpkgs revision below plus the
  # configuration in ./modules deterministically defines the whole system.
  # Replaces the imperative aws/scripts/components/base/install-base.sh.
  #
  # The pin is the reproducibility guarantee. `dnf install <pkg>-<ver>` pinning
  # (install-base.sh Bug-3 fix) is now this single nixpkgs commit: it fixes the
  # version of EVERY package at once, by hash, not just the ten named ones.
  #
  # To update the base: bump the nixpkgs `rev` + `sha256`, `nix flake lock`,
  # rebuild, re-measure (Phase 3), M-of-N sign the new measurement.
  description = "Safebox attested NixOS base";

  inputs = {
    # PIN BY COMMIT. Do not use a channel/branch name — that would reintroduce
    # the non-reproducibility install-base.sh's Bug-3 fix eliminated.
    #
    # ACTION REQUIRED before this flake builds: replace the ref below with a real
    # audited nixpkgs commit SHA, then run `nix flake lock` to write flake.lock.
    # The placeholder is intentionally invalid so a build fails loudly rather than
    # silently resolving to something unpinned.
    #
    # Get the current stable channel's exact commit (do this on a networked box):
    #   curl -I https://channels.nixos.org/nixos-26.05   # -> X-Nixpkgs-... commit
    # or just pin the channel branch head and let `nix flake lock` record the rev:
    #   nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";   then `nix flake lock`
    # 26.05 "Yarara" is current stable (25.05 is EOL as of 2026). 26.05 also has
    # the nixos-generators functionality upstreamed (system.build.images), which
    # is the migration path noted in Nix.md.
    nixpkgs.url = "github:NixOS/nixpkgs/PIN_ME_TO_A_COMMIT_SHA";

    # One config -> four cloud image formats (refactor.md Phase 2.1).
    nixos-generators = {
      url = "github:nix-community/nixos-generators";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Signed measured-boot UKIs (refactor.md Phase 3.1). Wired here so the
    # module tree can reference it, but only ENABLED in Phase 3.
    lanzaboote = {
      url = "github:nix-community/lanzaboote";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nixos-generators, lanzaboote, ... }:
    let
      system = "x86_64-linux";
      # The single system definition, shared by every cloud image.
      commonModules = [
        ./modules/base.nix
        ./modules/hardening.nix
            ./modules/privileged-process.nix
        ./modules/zfs.nix
        ./modules/storage-mappings.nix
        ./modules/egress-defaults.nix
        ./modules/containers.nix
        ./modules/measured-boot.nix        # Phase 3.1 (enabled via host file)
        ./modules/app-verify.nix           # Model A category-2 guarantee (ON)
        ./modules/layers.nix               # Phase 4 (Model B; off by default)
        lanzaboote.nixosModules.lanzaboote  # provides boot.lanzaboote.*
      ];
    in {
      # ---- Bootable NixOS system (for nixos-rebuild / testing) -------------
      nixosConfigurations.safebox = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = commonModules ++ [ ./hosts/safebox.nix ];
      };

      # ---- Cloud images: one config -> six clouds -------------------------
      # Build the SEALED (production) image:   nix build .#<cloud>
      # Build the BUILDER (SSH-ingress) image: nix build .#<cloud>-builder
      #
      # The builder is booted, sealed by attestation/image-seal/seal-image.sh
      # (which removes SSH + normalizes nondeterminism), and the sealed result
      # is registered as the bootable cloud image. Same NixOS closure for every
      # cloud; only the disk format + registration API differ. AWS/GCP/Azure
      # have native formats; Oracle/IBM/Alibaba import the portable qcow image.
      #
      # Attestation anchor is AMD SEV-SNP (encrypted RAM + per-instance key +
      # AMD-signed report) on ALL clouds -- NOT Nitro Enclaves. AWS additionally
      # offers NitroTPM measured-boot (PCRs over the UKI); OCI has no Secure Boot
      # for custom images so it uses the SEV-SNP launch measurement only. See
      # README "Where it runs" and Nix.md for the per-cloud modes.
      # (nixos-generators is being retired into nixpkgs as of 25.05 — see NIX.md;
      # migrate these to config.system.build.images.<fmt> as a fast-follow.)
      packages.${system} =
        let
          mkImage = fmt: host: nixos-generators.nixosGenerate {
            inherit system;
            format = fmt;
            modules = commonModules ++ [ host ];
          };
          prod    = ./hosts/safebox.nix;
          builder = ./hosts/ami1-builder.nix;
        in {
          # Sealed / production images (boot these after the seal step)
          ami    = mkImage "amazon" prod;   # AWS    -> AMI          (NitroTPM + NSM)
          gce    = mkImage "gce"    prod;   # GCP    -> GCE image    (vTPM + SEV-SNP)
          azure  = mkImage "azure"  prod;   # Azure  -> VHD          (vTPM + SEV-SNP/TDX)
          oci    = mkImage "qcow"   prod;   # Oracle -> QCOW2 import  (SEV)
          ibm    = mkImage "qcow"   prod;   # IBM    -> QCOW2 import  (SEV-SNP, select)
          alibaba = mkImage "qcow"  prod;   # Alibaba-> QCOW2 import  (confidential region-gated)

          # SSH-ingress builder images (boot -> seal -> register the sealed output).
          # Same closure as the sealed image above; only ingress differs, and the
          # seal removes it, so the sealed measurement is deterministic BY
          # CONSTRUCTION (not by hoping the whole Nix closure is bit-reproducible;
          # ~91% is not enough for a PCR).
          ami-builder     = mkImage "amazon" builder;
          gce-builder     = mkImage "gce"    builder;
          azure-builder   = mkImage "azure"  builder;
          oci-builder     = mkImage "qcow"   builder;
          ibm-builder     = mkImage "qcow"   builder;
          alibaba-builder = mkImage "qcow"   builder;

          # ---- OPTIONAL inspection sandbox (Variant 2) --------------------
          # sandbox-outer = the base safebox + the sandbox wrapper (composes
          # hosts/safebox.nix, adds interceptor + inner-VM launcher). The base
          # ships by itself via .#ami etc.; this is strictly additive on top.
          sandbox-outer = nixos-generators.nixosGenerate {
            inherit system; format = "amazon";
            modules = commonModules ++ [ ./hosts/sandbox-outer.nix ];
          };
          # sandbox-inner = the minimal untrusted-code microVM (single tap,
          # CA in measured trust store, job runner). Booted by the outer host.
          sandbox-inner = nixos-generators.nixosGenerate {
            inherit system; format = "raw";
            modules = [ ./modules/sandbox-inner.nix {
              safebox.sandboxInner.enable = true;
              safebox.sandboxInner.interceptorCaCert = ./hosts/sandbox-ca/interceptor-ca.crt;
            } ];
          };
        };
    };
}
