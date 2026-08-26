# modules/egress-defaults.nix — concrete per-service egress policy for the
# actual Safebox services. Imports egress.nix and fills in the allowlists.
# Tune the IP placeholders per deployment (auditor endpoints, backup peer).
{ lib, ... }:
{
  imports = [ ./egress.nix ];

  safebox.egress = {
    # The Qbix PHP web tier (the weakest link): its DB is a LOCAL unix socket,
    # nginx reaches it over a unix socket, so it needs NO outbound network.
    # deny-all => a compromised web tier physically cannot phone home.
    "phpfpm-safebox".allow = [];

    # ZFS-snapshot backup / rsync: allow ONLY the controlled backup peer (or the
    # M-of-N-blessed storage-mapping host). Placeholder prefix — set per deploy.
    "safebox-zfs-backup".allow = [ "10.0.0.0/32" ];  # REPLACE: backup peer IP

    # The weight-fetcher is a one-shot inbound fetch; CDN-backed, so it goes via
    # the box-controlled proxy (hostname allowlisting at the proxy), and is
    # allowed only the proxy IP. Placeholder until the proxy lands.
    "safebox-fetch-weights" = { allow = [ ]; viaProxy = "10.0.0.1"; };  # REPLACE: proxy IP

    # Model runners have NO business making outbound connections: deny-all.
    "docker-safebox-llama-deepseek".allow = [];
  };
}
