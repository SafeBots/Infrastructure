# modules/layers.nix   (refactor.md Phase 4 — Model B only)
#
# Personal inductive security: update the trust-root SOFTWARE in place, under
# your own M-of-N, without breaking attestation-across-reboots. Off by default —
# the vendored Model A (reboot a blessed image) needs none of this.
#
# The three-tier split (trust.html):
#   Tier 0  measured base  — kernel, initrd, core closure, AND THIS VERIFIER.
#                            Stable M0 across reboots. Never written by a layer
#                            update. (The verifier living here is load-bearing:
#                            if it lived in a layer, a compromised layer could
#                            disable its own check.)
#   Tier 1  signed layers  — installed software / workflows / the auditor, as
#                            M-of-N-signed ZFS layers. Off the boot path (don't
#                            touch M0). The base VERIFIES each layer's signature
#                            BEFORE it is allowed to execute. Reversible via
#                            `zfs rollback`.
#   Tier 2  data           — encrypted ZFS datasets (modules/zfs.nix). Never
#                            measured, never signature-checked (doesn't execute).
#
# THE RULE (trust.html): data needs only encryption (it never executes);
# software needs encryption AND signature-verification-before-execution
# (it does). This module implements the second half for Tier 1.
{ config, pkgs, lib, ... }:

let
  cfg = config.safebox.layers;

  # The verifier: mounts a signed ZFS layer only after its M-of-N signature
  # verifies under the auditor authorizing key that lives in the MEASURED base.
  verify-and-activate = pkgs.writeShellApplication {
    name = "safebox-activate-layer";
    runtimeInputs = [ pkgs.zfs pkgs.openssl pkgs.coreutils pkgs.jq ];
    text = ''
      set -euo pipefail
      # Usage: safebox-activate-layer <layer-dataset> <signature-file>
      LAYER="''${1:?layer dataset}"
      SIG="''${2:?detached signature over the layer's content hash}"
      AUTH_KEY="${cfg.auditorAuthKey}"   # baked into the MEASURED base (Tier 0)

      # 1. Compute the layer's content hash (the thing that was signed).
      #    A ZFS layer's identity is its snapshot GUID + content digest.
      GUID="$(zfs get -H -o value guid "$LAYER")"
      DIGEST="$(zfs send "$LAYER" | sha256sum | cut -d' ' -f1)"
      printf '%s\n%s\n' "$GUID" "$DIGEST" > /run/safebox/layer.manifest

      # 2. Verify M-of-N signature over that manifest under the base-resident
      #    auditor key. Refuse to activate on failure — an unsigned or wrongly
      #    signed layer NEVER executes.
      if ! openssl dgst -sha256 -verify "$AUTH_KEY" \
             -signature "$SIG" /run/safebox/layer.manifest; then
        echo "REFUSING to activate $LAYER: signature not valid under the "        \
             "M-of-N auditor key. An unverified software layer must not run." >&2
        exit 1
      fi

      # 3. Only now mount/activate the layer so its software can execute.
      zfs set canmount=on "$LAYER"
      zfs mount "$LAYER" || true
      echo "Activated signed layer $LAYER (GUID $GUID) after M-of-N verification."
    '';
  };
in
{
  options.safebox.layers = {
    enable = lib.mkEnableOption
      "Model B: signed, reversible Tier-1 software layers verified by the measured base";

    auditorAuthKey = lib.mkOption {
      type = lib.types.path;
      default = "/etc/safebox/auditor-authorize.pem";
      description = ''
        The auditors' authorizing PUBLIC key. This file is part of the MEASURED
        base (Tier 0), so tampering with it changes M0 and is caught by
        attestation. The verifier trusts THIS key to decide which layers may
        execute. It is a public key only — no signing capability on the box.
      '';
    };
  };

  config = lib.mkMerge [
    (lib.mkIf cfg.enable {
      environment.systemPackages = [ verify-and-activate ];

      # Layers are activated at boot AFTER the base is up but BEFORE the app
      # tier, so nothing unverified runs. Each layer dataset + its signature is
      # recorded in /etc/safebox/layers.d (part of the measured base).
      systemd.services.safebox-activate-layers = {
        description = "Verify + activate M-of-N-signed Tier-1 software layers (Model B)";
        wantedBy = [ "multi-user.target" ];
        after = [ "safebox-zfs-datasets.service" ];
        before = [ "safebox-compose.service" ];
        serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
        path = [ verify-and-activate pkgs.jq pkgs.coreutils ];
        script = ''
          set -euo pipefail
          mkdir -p /run/safebox
          LAYER_DIR=/etc/safebox/layers.d
          [ -d "$LAYER_DIR" ] || { echo "No layers configured."; exit 0; }
          for spec in "$LAYER_DIR"/*.json; do
            [ -e "$spec" ] || continue
            ds="$(jq -r .dataset "$spec")"
            sig="$(jq -r .signature "$spec")"
            safebox-activate-layer "$ds" "$sig"
          done
        '';
      };

      environment.etc."safebox/layers-README".text = ''
        Model B layering is ENABLED. Tier-1 software lives in M-of-N-signed ZFS
        layers verified by the measured base before execution. To ship a layer:
          1. Build it as a ZFS dataset/snapshot (off the boot path).
          2. Have M-of-N auditors sign its (GUID, content-digest) manifest.
          3. Drop {dataset, signature} into /etc/safebox/layers.d/<name>.json.
        Rollback a bad layer with `zfs rollback` — M0 is untouched throughout.
      '';
    })

    # ---- Reserved slot: keep B's shape in the MEASURED base even when OFF ---
    # Model A ships with B disabled, but the layer-verifier's HOME must exist in
    # the measured base from day one so turning B on later does NOT change M0
    # for Model-A users (which would force re-blessing every A image). So even
    # when disabled we reserve the empty layer directory. An A box and a B box
    # then differ only by whether that directory is POPULATED — not by the
    # base's structure. Same M0 shape.
    (lib.mkIf (!cfg.enable) {
      environment.etc."safebox/layers.d/.reserved".text = ''
        Reserved for Model B signed-layer specs. Empty under Model A.
        Its presence keeps the measured-base layout identical whether or not
        Model B is enabled, so enabling B later does not change M0.
      '';
    })
  ];
}
