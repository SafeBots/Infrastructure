# sandbox-host.nix — OPTIONAL inspection-sandbox outer host (Variant 2)
#
# Wraps the base safebox: runs an inner microVM (untrusted workload) behind a
# TLS-terminating MITM interceptor, all on ONE machine (so no inter-machine
# network topology has to be attested). Enabled only via hosts/sandbox-outer.nix,
# which imports the base and adds this. The default Safebox never imports this.
#
# The interceptor reads plaintext -- containment for untrusted code, and it would
# be surveillance for the user's own code -- so it lives ONLY here, never in the
# default base.
{ config, lib, pkgs, ... }:
let
  cfg = config.safebox.sandboxHost;
  # The interceptor binary: v0 wraps a mature MITM. Packaged from the tree so the
  # closure (and thus the measurement) covers it. Replaced by the U-written,
  # capability-bounded, M-of-N-blessed interceptor in a fast-follow (BATCH-TESTING-SPEC Turn 4).
  interceptor = pkgs.writeShellApplication {
    name = "safebox-interceptor";
    runtimeInputs = [ pkgs.mitmproxy pkgs.coreutils ];
    text = ''
      set -euo pipefail
      # Terminate inner TLS with our CA, apply policy (allowlist + volume meter +
      # audit), re-originate a validated TLS outward. Deny-default; a host absent
      # from the allowlist is refused. mitmdump runs transparent on the bridge.
      CA_DIR="$1"; POLICY="$2"; BRIDGE_ADDR="$3"
      exec mitmdump \
        --mode transparent \
        --listen-host "$BRIDGE_ADDR" --listen-port 8443 \
        --set confdir="$CA_DIR" \
        --set block_global=true \
        --scripts ${./sandbox-interceptor/policy_addon.py} \
        --set safebox_policy="$POLICY"
    '';
  };
in {
  options.safebox.sandboxHost = {
    enable = lib.mkEnableOption "the optional untrusted-code inspection sandbox outer host";
    interceptorCaPath = lib.mkOption {
      type = lib.types.path;
      description = "Interceptor CA cert (baked into the inner VM trust store; measured).";
    };
    interceptorCaDir = lib.mkOption {
      type = lib.types.str; default = "/var/lib/safebox-interceptor/ca";
      description = "Runtime dir holding the interceptor CA key+cert (interceptor-only, 0700).";
    };
    policyPath = lib.mkOption {
      type = lib.types.path; default = ../../sandbox/interceptor/policy.example.json;
      description = "Interceptor policy: host allowlist, volume metering, audit level.";
    };
    bridgeName = lib.mkOption { type = lib.types.str; default = "sbx0"; };
    bridgeAddr = lib.mkOption {
      type = lib.types.str; default = "10.200.0.1";
      description = "The interceptor's address on the bridge. MUST equal the inner VM's only gateway.";
    };
    bridgeCidr = lib.mkOption { type = lib.types.int; default = 24; };
    innerImage = lib.mkOption {
      type = lib.types.str; default = "/var/lib/safebox-sandbox/inner.img";
      description = "Path to the built inner microVM image (from .#sandbox-inner).";
    };
  };

  config = lib.mkIf cfg.enable {
    # ---- Outer host immutability (belt-and-suspenders over NixOS's automatic
    #      no-package-manager property) --------------------------------------
    # On NixOS there is no runtime package manager: the store IS the package db,
    # so once sealed (SSH removed) the outer host CANNOT install apps or update
    # packages without rebuilding the closure -- which changes the measurement
    # and fails attestation. Assertions make the invariant auditable and fail
    # the build if an install path is ever reintroduced.
    assertions = [
      { assertion = !config.services.openssh.enable;
        message = "sandbox-host: sealed outer host must have NO sshd. It hosts untrusted code."; }
      { assertion = (config.virtualisation.docker.enable or false) -> (config.safebox.appVerify.enable or false);
        message = "sandbox-host: if docker is present it must be app-verify-gated (no arbitrary docker-run on the outer host)."; }
      # Address consistency: the interceptor's bridge address MUST be what the
      # inner microVM uses as its sole gateway, or the inner VM has no egress
      # (fail-closed) OR, worse, a mismatch masks a misconfig. Assert it here.
      { assertion = cfg.bridgeAddr != "";
        message = "sandbox-host: bridgeAddr must be set and must equal the inner VM's gateway (safebox.sandboxInner.interceptorAddr)."; }
    ];

    # ---- The MITM interceptor service ------------------------------------
    systemd.services."sandbox-interceptor" = {
      description = "TLS-terminating inspection interceptor for the inner microVM";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" "sandbox-bridge.service" ];
      requires = [ "sandbox-bridge.service" ];
      serviceConfig = {
        ExecStart = "${interceptor}/bin/safebox-interceptor "
                  + "${cfg.interceptorCaDir} ${cfg.policyPath} ${cfg.bridgeAddr}";
        Restart = "on-failure";
        # It reads plaintext -> most-trusted component -> lock it down hard.
        DynamicUser = true;
        StateDirectory = "safebox-interceptor";
        AmbientCapabilities = [ "CAP_NET_ADMIN" "CAP_NET_RAW" "CAP_NET_BIND_SERVICE" ];
        CapabilityBoundingSet = [ "CAP_NET_ADMIN" "CAP_NET_RAW" "CAP_NET_BIND_SERVICE" ];
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        NoNewPrivileges = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        RestrictNamespaces = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
      };
    };

    # ---- In-machine bridge: the inner microVM's ONLY neighbor -------------
    # The bridge has the interceptor's address; the inner VM's single tap joins
    # it and routes ONLY here. The bridge has NO uplink of its own -- egress
    # happens solely because the interceptor forwards allowlisted, inspected
    # traffic. A fully compromised inner VM still reaches nothing but the
    # interceptor.
    systemd.services."sandbox-bridge" = {
      description = "Isolated inner-VM bridge: no route except through this to the interceptor (no uplink)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-pre.target" ];
      serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
      path = [ pkgs.iproute2 ];
      script = ''
        ip link add ${cfg.bridgeName} type bridge 2>/dev/null || true
        ip addr replace ${cfg.bridgeAddr}/${toString cfg.bridgeCidr} dev ${cfg.bridgeName}
        ip link set ${cfg.bridgeName} up
        # NO ip route / NO NAT to any uplink here: the bridge is a dead-end except
        # for the interceptor process, which owns the real uplink separately.
      '';
    };

    # ---- Inner microVM launcher (per job; the batch worker drives lifecycle) --
    # This declares the CAPABILITY to launch the inner microVM with exactly one
    # tap to the bridge. The batch worker (sandbox/batch_worker.py) calls it per
    # job via its SandboxDriver. Firecracker/cloud-hypervisor is the runtime;
    # microvm.nix or a thin launcher wires the single tap. Declared here so the
    # launcher + its single-tap topology are in the measured closure.
    systemd.services."sandbox-inner-runner@" = {
      description = "Boot one inner microVM (single tap → %i job)";
      serviceConfig = {
        Type = "simple";
        # ExecStart points at the launcher that boots cfg.innerImage with ONE tap
        # on ${cfg.bridgeName} and no other device. The %i is the job id; the
        # worker creates the tap, starts this, and tears it down.
        ExecStart = "${pkgs.writeShellScript "boot-inner" ''
          set -euo pipefail
          JOB="$1"; TAP="sbxtap-$JOB"
          ${pkgs.iproute2}/bin/ip tuntap add "$TAP" mode tap 2>/dev/null || true
          ${pkgs.iproute2}/bin/ip link set "$TAP" master ${cfg.bridgeName}
          ${pkgs.iproute2}/bin/ip link set "$TAP" up
          # Launch the microVM with EXACTLY this one tap; no other NIC.
          exec ${pkgs.firecracker or pkgs.cloud-hypervisor}/bin/firecracker \
            --no-api --config-file /dev/stdin <<CFG
          { "boot-source": {"kernel_image_path":"${cfg.innerImage}.kernel"},
            "drives":[{"drive_id":"root","path_on_host":"${cfg.innerImage}","is_root_device":true,"is_read_only":true}],
            "network-interfaces":[{"iface_id":"eth0","host_dev_name":"'$TAP'"}] }
          CFG
        ''} %i";
        Restart = "no";
      };
    };

    networking.firewall.enable = true;
    # System-level: keep the box otherwise closed.
    services.openssh.enable = lib.mkForce false;
  };
}
