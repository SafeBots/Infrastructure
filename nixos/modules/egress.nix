# modules/egress.nix — PER-PROCESS network egress policy.
#
# The box's containment story assumes "empty egress": code can't phone home.
# But networking.firewall (hardening.nix) is INBOUND-only — it does not restrict
# outbound at all. This module makes egress real, and does it PER SERVICE, which
# is stronger than one box-wide allowlist: it enforces WHO may reach WHERE, so a
# compromised web tier can't reach an auditor IP as cover, and a runner can't
# reach anything.
#
# Mechanism: systemd IPAddressDeny=any + IPAddressAllow=<list> per service
# (kernel-enforced via eBPF, composes with the existing systemd sandboxing).
# Default is deny-any with NO allow => a service under this policy that isn't
# given an allowlist can make NO outbound connections.
#
# CAVEAT (documented, not hidden): IPAddressAllow matches IP PREFIXES, not
# hostnames. For our own infra (auditor endpoints, backup peer) IPs are stable
# and this is exact. For CDN-backed fetches (weights, cloud buckets) the honest
# pattern is a forward proxy the box controls doing hostname allowlisting, with
# the service allowed only the proxy's IP. safebox.egress.<svc>.viaProxy names
# that intent; the proxy itself is a follow-on, but the allowlist seam is here.
{ config, lib, ... }:
let
  cfg = config.safebox.egress;
  loopback = [ "127.0.0.0/8" "::1/128" ];
  # localhost is always allowed (unix-socket / loopback IPC is not egress).
  mkService = name: policy: {
    serviceConfig = {
      IPAddressDeny = "any";
      IPAddressAllow = loopback ++ policy.allow;
    };
  };
in {
  options.safebox.egress = lib.mkOption {
    default = {};
    description = ''
      Per-service egress policy. Each entry locks a systemd service to
      IPAddressDeny=any plus an explicit allowlist (loopback always allowed).
      Omit allow (or give []) for deny-all: the service can reach nothing but
      localhost. This is what makes "empty egress" real and per-identity.
    '';
    type = lib.types.attrsOf (lib.types.submodule {
      options = {
        allow = lib.mkOption {
          type = lib.types.listOf lib.types.str; default = [];
          description = "IP prefixes this service may reach (e.g. auditor/backup-peer IPs). [] = localhost only.";
        };
        viaProxy = lib.mkOption {
          type = lib.types.nullOr lib.types.str; default = null;
          description = "For CDN/hostname destinations: the forward-proxy IP this service must go through (hostname allowlisting happens at the proxy). Documents the seam.";
        };
      };
    });
  };

  config = {
    # Apply each declared policy to its systemd service.
    systemd.services = lib.mapAttrs mkService cfg;
  };
}
