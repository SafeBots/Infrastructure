# modules/app-verify.nix   (Model A — the category-2 guarantee)
#
# Model A's honest promise about the app tier (README "category 2"): app
# containers ride BESIDE the measured base on ZFS and are NOT themselves
# measured. So their integrity rests on two things this module enforces:
#
#   1. DIGEST PINNING  — every app container is referenced by immutable digest,
#      not a floating tag. (Fixes inconsistencies.md F4 for the app tier.)
#   2. STARTUP VERIFICATION — before the app tier runs, verify the container
#      digests present match the allow-list the BLESSED BASE ships. The
#      allow-list is part of the measured base (Tier 0), so tampering changes
#      M0 and fails attestation. Mismatch => app tier does NOT start
#      (fail-closed): a blessed base never silently runs unrecognized app code.
#
# Model-A analogue of Model-B's signed-layer check: there the base verifies a
# SIGNATURE before executing a layer; here the base verifies a DIGEST before
# starting the app tier. Same principle at the granularity Model A needs.
{ config, pkgs, lib, ... }:

let
  cfg = config.safebox.appVerify;

  verify-app-digests = pkgs.writeShellApplication {
    name = "safebox-verify-app-digests";
    runtimeInputs = [ pkgs.docker pkgs.jq pkgs.coreutils pkgs.yq-go ];
    text = ''
      set -euo pipefail
      ALLOW="${cfg.digestAllowList}"
      COMPOSE="${cfg.composeFile}"

      [ -f "$ALLOW" ] || { echo "FATAL: digest allow-list $ALLOW missing from the base." >&2; exit 1; }

      fail=0
      while IFS= read -r image; do
        [ -n "$image" ] || continue
        case "$image" in
          *@sha256:*) : ;;
          *) echo "REFUSING: app image '$image' is not digest-pinned (floating tag)." >&2
             fail=1; continue ;;
        esac
        digest="''${image##*@}"
        if ! jq -e --arg d "$digest" '.allowed | index($d)' "$ALLOW" >/dev/null; then
          echo "REFUSING: app image digest $digest is not in the blessed allow-list." >&2
          fail=1
        fi
      done < <(yq -o=json "$COMPOSE" | jq -r '.services[].image // empty')

      if [ "$fail" -ne 0 ]; then
        echo "App tier NOT started: container(s) failed digest verification against" >&2
        echo "the blessed base's allow-list (Model A category-2 guarantee)." >&2
        exit 1
      fi
      echo "All app containers match the blessed base's digest allow-list."
    '';
  };
in
{
  options.safebox.appVerify = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;   # ON by default — this IS the Model-A guarantee
      description = "Model A: verify app-container digests against the blessed base before start.";
    };
    digestAllowList = lib.mkOption {
      type = lib.types.str;
      default = "/etc/safebox/app-digests.json";
      description = "JSON {allowed:[sha256:...]} of blessed app digests; part of the measured base (M0).";
    };
    composeFile = lib.mkOption {
      type = lib.types.str;
      default = "/opt/safebox/docker/docker-compose.yml";
      description = "App-tier compose file whose image digests are checked.";
    };
    allowedDigests = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      description = "Pinned app-container digests this base blesses (goes into M0).";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ verify-app-digests ];

    environment.etc."safebox/app-digests.json".text = builtins.toJSON {
      allowed = cfg.allowedDigests;
      note = "App-container digests blessed by this base (Model A). Part of M0.";
    };

    systemd.services.safebox-verify-apps = {
      description = "Model A: verify app-container digests against the blessed base";
      wantedBy = [ "multi-user.target" ];
      after = [ "docker.service" "safebox-zfs-datasets.service" ];
      before = [ "safebox-compose.service" ];
      requiredBy = [ "safebox-compose.service" ];
      serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
      path = [ verify-app-digests ];
      script = "safebox-verify-app-digests";
    };
  };
}
