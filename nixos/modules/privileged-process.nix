# privileged-process.nix — the orchestrator/privileged split.
#
# Two Node processes instead of one. The ORCHESTRATOR runs the sandbox, tool
# execution, and workflow compilation. The PRIVILEGED PROCESS holds the master
# secret, resolves credentials, and makes outbound Protocol calls. They
# communicate over a Unix domain socket at /run/safebox/privileged.sock.
#
# A sandbox escape in the orchestrator can no longer reach credential plaintext
# or Protocol.System — neither exists in that process. The audited surface for
# credential confidentiality shrinks from ~1,800 lines to ~248 lines.
#
# No new ports, no new network rules, no API surface changes.
{ config, lib, pkgs, ... }:
let cfg = config.safebox.privilegedProcess;
in {
  options.safebox.privilegedProcess = {
    enable = lib.mkEnableOption "the orchestrator/privileged process split";
    masterKeyPath = lib.mkOption {
      type = lib.types.str;
      default = "/srv/safebox/secrets/master.key";
      description = "Path to the TPM-unsealed master secret (32 bytes). Readable ONLY by safebox-privileged.";
    };
    socketPath = lib.mkOption {
      type = lib.types.str;
      default = "/run/safebox/privileged.sock";
      description = "Unix domain socket for orchestrator↔privileged IPC.";
    };
    appDir = lib.mkOption {
      type = lib.types.str;
      default = "/srv/safebox/apps/App";
      description = "APP_DIR — must match the orchestrator's value.";
    };
    scriptPath = lib.mkOption {
      type = lib.types.str;
      default = "/srv/safebox/plugins/Safebox/scripts/Safebox/safebox-privileged.js";
      description = "Path to the privileged process script (in the plugin directory, measured in the app-layer attestation).";
    };
  };

  config = lib.mkIf cfg.enable {
    # ---- Users and groups ------------------------------------------------
    users.users.safebox-privileged = {
      isSystemUser = true;
      group = "safebox-privileged";
      extraGroups = [ "safebox-orchestrator" ];  # lets orchestrator connect to the socket (mode 0660)
      home = "/nonexistent";
      shell = "/usr/sbin/nologin";
      description = "Safebox privileged process — holds master secret, resolves credentials";
    };
    users.groups.safebox-privileged = {};

    # ---- Master secret file — the split's security property ---------------
    # The master secret is readable by safebox-privileged and NOT by the
    # orchestrator. This is the ENTIRE POINT of the split: if the orchestrator
    # can read the master secret, the split provides no confidentiality benefit.
    #
    # The actual file is created by the boot sequence (unseal-zfs-key.sh or
    # equivalent). This activation script sets the ownership AFTER unseal.
    system.activationScripts.safebox-master-key-perms = lib.mkIf (cfg.masterKeyPath != "") ''
      if [ -f "${cfg.masterKeyPath}" ]; then
        chown safebox-privileged:safebox-privileged "${cfg.masterKeyPath}"
        chmod 0400 "${cfg.masterKeyPath}"
      fi
    '';

    # ---- The privileged process systemd unit -----------------------------
    systemd.services."safebox-privileged" = {
      description = "Safebox privileged process — credentials, Protocol calls, master secret";
      wantedBy = [ "multi-user.target" ];
      after = [ "safebox-infra.service" "network.target" ];
      requires = [ "safebox-infra.service" ];
      # Boot order: infra → privileged → orchestrator
      # The orchestrator's unit should declare After=safebox-privileged.service

      environment = {
        APP_DIR = cfg.appDir;
        NODE_ENV = "production";
        SAFEBOX_PRIVILEGED_SOCKET = cfg.socketPath;
      };

      serviceConfig = {
        ExecStart = "${pkgs.nodejs}/bin/node ${cfg.scriptPath}";
        Restart = "on-failure";
        RestartSec = "2s";

        # Run as the privileged user
        User = "safebox-privileged";
        Group = "safebox-privileged";
        SupplementaryGroups = [ "safebox-orchestrator" ];

        # Runtime directory for the socket
        RuntimeDirectory = "safebox";
        RuntimeDirectoryMode = "0755";

        # Hardening — this process holds the master secret, so lock it down hard
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = false;  # Node needs JIT
        # Allow reading the master key and the app dir
        ReadOnlyPaths = [ "/srv/safebox" ];
        ReadWritePaths = [ "/run/safebox" ];

        # Capability: none needed — it's a local-only process
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";
      };
    };

    # ---- Assertions -------------------------------------------------------
    assertions = [
      { assertion = cfg.masterKeyPath != "";
        message = "privileged-process: masterKeyPath must be set — the master secret delivery target."; }
    ];
  };
}
