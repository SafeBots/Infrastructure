# modules/storage-mappings.nix — ship the blessed object-storage mappings and the
# trusted auditor keys INTO the measured base, so the egress-relaxing decision is
# measured (tamper => M0 changes => attestation fails), mirroring app-verify.nix.
{ config, lib, ... }:
let cfg = config.safebox.storage;
in {
  options.safebox.storage.blessedMappings = lib.mkOption {
    type = lib.types.listOf lib.types.attrs;
    default = [];
    description = "M-of-N blessed object-storage mapping entries (from bless-mapping.py combine). Part of M0.";
  };
  options.safebox.storage.trustedAuditorKeys = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    default = [];
    description = "base64 Ed25519 auditor pubkeys the box trusts for mapping approval. Part of M0.";
  };
  config = {
    # Empty by default => no mapping can ever pass the gate => backend refuses all.
    environment.etc."safebox/blessed-storage-mappings.json".text =
      builtins.toJSON cfg.blessedMappings;
    environment.etc."safebox/trusted-auditor-keys.json".text =
      builtins.toJSON cfg.trustedAuditorKeys;
  };
}
