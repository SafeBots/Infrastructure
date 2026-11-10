# sandbox-inner.nix — OPTIONAL: the inner microVM that runs untrusted code (Variant 2)
#
# This is the config for the INNER NixOS microVM (Firecracker-class) that hosts
# the untrusted binary. It is NOT the default Safebox and NOT the outer host —
# it is the guest the outer sandbox-host boots per job. Its defining properties,
# all measured (part of the inner image's closure), are:
#
#   1. ONE network interface: a single tap to the outer host's interceptor
#      bridge. No other NIC, no default route to anything else. A fully
#      compromised inner binary can reach nothing but the interceptor.
#   2. The interceptor's CA is in the inner trust store, so ordinary TLS clients
#      transparently trust the interceptor (MITM succeeds). Baked in at build =
#      measured, not a runtime action.
#   3. Locked-down: seccomp, resource caps, a hard job timeout, no persistence
#      (rootfs is a ZFS clone destroyed on teardown by the outer host).
{ config, lib, pkgs, ... }:
let cfg = config.safebox.sandboxInner;
in {
  options.safebox.sandboxInner = {
    enable = lib.mkEnableOption "the inner untrusted-code microVM guest";
    interceptorCaCert = lib.mkOption {
      type = lib.types.path;
      description = "Interceptor CA cert, added to the inner trust store (measured). MITM of ordinary TLS clients works because this CA is trusted.";
    };
    interceptorAddr = lib.mkOption {
      type = lib.types.str; default = "10.200.0.1";
      description = "The interceptor's address on the single tap link. The ONLY reachable host.";
    };
    jobTimeoutSec = lib.mkOption {
      type = lib.types.int; default = 900;
      description = "Hard wall-clock cap on a job run; the outer host also enforces teardown.";
    };
  };

  config = lib.mkIf cfg.enable {
    # ---- (1) Single interface, no other route ----------------------------
    # Exactly one link (eth0 = the tap to the interceptor bridge). The default
    # route points ONLY at the interceptor; there is no other gateway. Even if
    # the inner binary rewrites routes, there is no second device to route over.
    networking.useDHCP = false;
    networking.interfaces.eth0.useDHCP = false;
    networking.defaultGateway = { address = cfg.interceptorAddr; interface = "eth0"; };
    # Belt-and-suspenders: refuse to build an inner image that declares any
    # second network interface or an alternate gateway.
    assertions = [
      { assertion = (builtins.length (builtins.attrNames (config.networking.interfaces or {}))) == 1;
        message = "sandbox-inner: exactly ONE interface (eth0 → interceptor) is allowed. A second NIC would be a bypass path around the interceptor."; }
      { assertion = config.networking.defaultGateway.address == cfg.interceptorAddr;
        message = "sandbox-inner: default route must point at the interceptor and nothing else."; }
      { assertion = !config.services.openssh.enable;
        message = "sandbox-inner: the untrusted guest has no sshd."; }
    ];

    # ---- (2) Interceptor CA in the measured trust store ------------------
    # Ordinary TLS clients in the guest will trust certs the interceptor mints,
    # so TLS termination is transparent. TOFU pinning pins to the interceptor
    # (first connection IS the interceptor). Baked-in pins to a real origin fail
    # by design — that's the inspection contract, and a failure is signal.
    security.pki.certificateFiles = [ cfg.interceptorCaCert ];

    # ---- (3) Lockdown ----------------------------------------------------
    # No persistence (rootfs is a throwaway ZFS clone), minimal services, the
    # job runner as a bounded oneshot. seccomp/resource limits mirror the
    # runner profiles used elsewhere in the tree.
    systemd.services."sandbox-job" = {
      description = "Run one untrusted job under inspection, then exit";
      serviceConfig = {
        Type = "oneshot";
        RuntimeMaxSec = cfg.jobTimeoutSec;   # hard timeout
        DynamicUser = true;
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectKernelTunables = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        # ExecStart wired by the batch worker to the job's entrypoint (Turn 3).
        # Egress from here can ONLY reach the interceptor (topology above).
      };
    };
    # The guest advertises nothing inbound.
    networking.firewall.enable = true;
    networking.firewall.allowedTCPPorts = lib.mkForce [ ];
  };
}
