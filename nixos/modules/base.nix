# modules/base.nix
#
# Declarative translation of the PACKAGE + SERVICE portions of
# aws/scripts/components/base/install-base.sh.
#
# install-base.sh's SYSTEM_PACKAGES array is replaced by services/packages
# below. Versions are no longer pinned per-package here — the flake's nixpkgs
# commit pin (flake.nix) fixes every version by hash at once. That is a
# STRICTER form of Bug-3's reproducibility fix.
#
# F1/F3 RESOLVED (host-authoritative). nginx, mariadb, and php run as HOST
# services in the MEASURED base — their versions are part of M0, attested and
# grokkable. The container tier (containers.nix) no longer duplicates them; it
# runs ADDITIONAL services only (model runners, extra webservers, tools) as
# category-2. This closes F1: Autohost writes vhosts to the ONE nginx that
# actually serves 80/443 (the host nginx), so custom domains serve correctly.
{ config, pkgs, lib, ... }:

{
  system.stateVersion = "24.11";

  # ---- System packages (former SYSTEM_PACKAGES array) --------------------
  # docker-ce, zfs, iptables are kernel-coupled -> stay as the blob floor,
  # provided by NixOS's kernel-matched builds (correct: co-built with the
  # kernel, exactly as the refactor's build-from-source analysis concluded
  # they should NOT be hand-built).
  environment.systemPackages = with pkgs; [
    nodejs_20            # node + npm; exact version from the nixpkgs pin
    # nginx / mariadb / php provided via services.* below (MEASURED host core)
    iptables             # iptables-1.8.10 (kernel/netfilter-coupled; floor)
    fail2ban             # fail2ban-1.0.2
    # llama.cpp / ollama live in the container tier (containers.nix); they are
    # ALSO in nixpkgs (pkgs.llama-cpp / pkgs.ollama) if promoted to host later.
  ];

  # ---- Docker (docker-ce-25.0.5) + the daemon.json hardening -------------
  # Faithful port of install-base.sh's /etc/docker/daemon.json (Bug-7 fix):
  # userns-remap, no-new-privileges, icc off, zfs storage driver on
  # safebox-pool/docker, log rotation, ulimits.
  virtualisation.docker = {
    enable = true;
    daemon.settings = {
      userns-remap = "default";
      live-restore = true;
      log-driver = "json-file";
      log-opts = { max-size = "100m"; max-file = "5"; };
      default-ulimits.nofile = { Name = "nofile"; Hard = 64000; Soft = 64000; };
      no-new-privileges = true;
      icc = false;
      storage-driver = "zfs";
      storage-opts = [ "zfs.fsname=safebox-pool/docker" ];
    };
  };
  # Docker uses the zfs storage driver on safebox-pool/docker, which the
  # dataset service creates — so docker must start AFTER it (fixes an ordering
  # gap: without this, docker could start before its storage dataset exists).
  systemd.services.docker = {
    after = [ "safebox-zfs-datasets.service" ];
    requires = [ "safebox-zfs-datasets.service" ];
  };
  # dockremap user/group for userns-remap=default (install-base.sh created these).
  users.users.dockremap = { isSystemUser = true; group = "dockremap"; };
  users.groups.dockremap = {};

  # ---- nginx — TLS terminator only (Qbix webserver handles the rest) ------
  # nginx's sole job: terminate TLS on 80/443 and proxy to the Qbix webserver
  # on localhost. No fastcgi_pass, no php-fpm socket, no PHP config. All PHP
  # execution, static file serving, WebSocket, access-controlled files
  # (X-Accel-Redirect), and component cache (X-Cache-Tree) are handled by the
  # Qbix webserver directly. This is what remains after removing php-fpm.
  #
  # Why keep nginx at all: battle-tested TLS (session resumption, OCSP stapling,
  # Let's Encrypt via security.acme), sendfile() for large static assets, and
  # the Autohost custom-domain cert management already wired to it.
  services.nginx = {
    enable = true;
    recommendedTlsSettings = true;
    recommendedGzipSettings = true;
    recommendedOptimisation = true;
    recommendedProxySettings = true;

    # Default vhost: proxy everything to the Qbix webserver.
    # Uses unix socket (faster than TCP loopback, no port allocation).
    virtualHosts."_" = {
      default = true;
      locations."/" = {
        proxyPass = if config.safebox.qbixWebserver.socketPath != null
          then "http://unix:${config.safebox.qbixWebserver.socketPath}"
          else "http://127.0.0.1:${toString config.safebox.qbixWebserver.port}";
        proxyWebsockets = true;  # WebSocket upgrade passthrough
        extraConfig = ''
          proxy_set_header Host $host;
          proxy_set_header X-Real-IP $remote_addr;
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          proxy_set_header X-Forwarded-Proto $scheme;
        '';
      };
    };

    # Autohost-managed custom-domain vhosts (TLS certs only — routing is in
    # the Qbix webserver). Autohost writes cert configs here + reloads nginx.
    appendHttpConfig = ''
      include /etc/nginx/conf.d/auto/*.conf;
    '';
  };

  # ---- Qbix PHP webserver (replaces php-fpm) ------------------------------
  # Fork-after-preload: 0ms bootstrap, shared-nothing (no state leaks),
  # 30MB shared + ~5MB/worker. Handles PHP, static files, WebSocket,
  # X-Accel-Redirect, X-Cache-Tree. See nixos/modules/qbix-webserver.nix.
  safebox.qbixWebserver.enable = true;
  # Autohost target dirs + the app webroot exist in the base so paths are valid
  # before the first custom domain / app deploy.
  systemd.tmpfiles.rules = [
    "d /etc/nginx/conf.d/auto 0750 nginx nginx -"
    "d /etc/nginx/conf.d/auto-certs 0750 nginx nginx -"
    "d /safebox/www 0750 nginx nginx -"
    # Directory + permission structure ported from install-base.sh (the mkdir/
    # chmod block). NixOS creates most paths implicitly, but install-base.sh set
    # specific owners/modes these services rely on — carry them verbatim so the
    # NixOS host is a strict superset.
    "d /opt/safebox 0755 root root -"
    "d /opt/safebox/manifests 0755 root root -"
    "d /opt/safebox/lib 0755 root root -"
    "d /opt/safebox/bin 0755 root root -"
    "d /srv/safebox/runtimes/system 0750 root root -"
    "d /safebox/nginx/ssl 0710 nginx nginx -"     # 0710: nginx reads, others traverse-only
    "d /safebox/mariadb/data 0700 mysql mysql -"  # 0700: DB data private to mysql
  ];

  # ---- PHP-FPM — REMOVED (replaced by the Qbix webserver) ----------------
  # The Qbix webserver handles PHP execution directly via fork-after-preload.
  # php-fpm and its fastcgi socket are no longer needed. The systemd sandbox
  # that was here has been ported to the qbix-webserver.nix module verbatim.
  # If you need php-fpm for some reason, uncomment the block below — but the
  # Qbix webserver is strictly better for Qbix Platform apps (0ms bootstrap,
  # shared-nothing safety, built-in WebSocket and X-Accel-Redirect).
  #
  # services.phpfpm.pools.safebox = { ... };  # see git history

  # ---- PHP-FPM systemd sandbox — REMOVED (ported to qbix-webserver.nix) ---
  # The identical hardening (SystemCallFilter, ProtectSystem strict, etc.) is
  # now applied to the Qbix webserver service directly. See qbix-webserver.nix.


  # InnoDB<->ZFS tuning ported from install-base.sh's safebox.cnf; the ZFS-side
  # settings (recordsize=16k etc.) are in modules/zfs.nix. Version from the
  # nixpkgs pin.
  services.mysql = {
    enable = true;
    package = pkgs.mariadb;
    # Root has no network login; local socket auth only (no password file to
    # manage, no orphaned secret). App DB users are provisioned by the app
    # deploy, not baked into the measured base.
    ensureDatabases = [ "safebox" ];
    settings.mysqld = {
      datadir = "/safebox/mariadb/data";
      innodb_file_per_table = 1;
      innodb_page_size = "16k";
      innodb_flush_method = "O_DIRECT";
      innodb_flush_log_at_trx_commit = 1;
      sync_binlog = 1;
      innodb_doublewrite = 0;          # ZFS checksums; doublewrite redundant
      max_connections = 500;
      thread_cache_size = 50;
      # Bind to localhost only — the DB is never exposed off-box.
      bind-address = "127.0.0.1";
    };
  };

  # ---- Component manifest -------------------------------------------------
  # install-base.sh wrote /opt/safebox/manifests/base.json. Under NixOS the
  # closure hash IS the manifest (measured in Phase 3), but we still emit a
  # human-readable manifest for the attestation log / parity with v1.
  environment.etc."safebox/manifests/base.json".text = builtins.toJSON {
    component = { name = "base"; version = "2.0.0-nixos"; license = [ "Apache-2.0" "MIT" ]; };
    note = "Versions fixed by flake nixpkgs pin; closure hash is the real manifest.";
    security = {
      shellAccessPolicy = "zero-interactive-access";   # see hardening.nix
      zfsEncryption = "aes-256-gcm";                    # see zfs.nix
      dockerUsernsRemap = true;
    };
  };
}
