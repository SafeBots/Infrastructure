# modules/measured-boot.nix  (refactor.md Phase 3.1)
#
# Signed measured boot. Packs kernel + initrd + cmdline into a Unified Kernel
# Image (UKI), signs it, and lets the boot chain be measured into PCRs. This is
# what makes the boot measurement REPRODUCIBLE and PREDICTABLE — the
# precondition for pre-computing the expected measurement (Phase 3.2) and
# sealing keys to it (Phase 3.3).
#
# CROSS-CLOUD (trust.html): the measurement ROOT differs per cloud, but the
# mechanism is the same TPM 2.0 measured boot:
#   AWS   : NitroTPM signs the PCRs; Attestable-AMI PCRs (PCR4/7/12) = the AMI.
#   GCP   : vTPM quote rooted in the AMD SEV-SNP launch measurement.
#   Azure : vTPM quote rooted in SEV-SNP / TDX report.
#   OCI   : SEV measured boot (thinner tooling; more verification is ours).
#
# This module enables the guest-side measured boot; the per-cloud VERIFICATION
# of the resulting quote lives in attestation/ (Phase 3.4).
#
# HARDWARE NOTE: none of this can be exercised in a plain container/CI — it
# needs a TPM (vTPM/NitroTPM) and, for the SEV path, SEV-SNP-capable silicon.
# The config is written to be correct-by-construction and validated on a real
# confidential instance (refactor.md Phase 3 exit criterion).
{ config, pkgs, lib, ... }:

let
  cfg = config.safebox.measuredBoot;
in
{
  options.safebox.measuredBoot = {
    enable = lib.mkEnableOption "Safebox measured boot (lanzaboote UKI + TPM PCRs)";

    signingKeyDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/safebox/secureboot";
      description = ''
        Directory holding the Secure Boot signing keys used to sign the UKI.
        In production these are generated OFFLINE and enrolled; they are NOT
        auto-generated on the box (that would put the signing key on the very
        machine whose boot it authorizes). See attestation/README.md.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # Lanzaboote replaces systemd-boot with a UKI-signing boot path.
    # (Input wired in flake.nix; the module comes from the lanzaboote flake.)
    boot.loader.systemd-boot.enable = lib.mkForce false;
    boot.lanzaboote = {
      enable = true;
      pkiBundle = cfg.signingKeyDir;
    };

    # UEFI + Secure Boot are prerequisites for a meaningful measured boot.
    boot.loader.efi.canTouchEfiVariables = false;  # immutable base: don't write vars

    # Ensure a TPM2 userspace exists for measurement + later sealing.
    security.tpm2 = {
      enable = true;
      pkcs11.enable = true;
      tctiEnvironment.enable = true;
    };

    # The measured base must stay off the "mutable" list — anything that writes
    # into the measured boot path on a normal update would change M0 and break
    # attestation-across-reboots (trust.html). Base updates are a DISTINCT,
    # governed operation (re-measure + M-of-N re-sign), not an in-place write.
    environment.etc."safebox/measured-boot.marker".text = ''
      This system uses signed measured boot. The boot-path closure is Tier 0.
      Updating Tier 0 changes the measurement and requires M-of-N re-blessing.
      Do not write into the boot path as part of a layer update (Phase 4).
    '';
  };
}
