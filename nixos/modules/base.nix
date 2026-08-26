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

  # ---- nginx — MEASURED host core (F1/F3 resolved) -----------------------
  # THE nginx: owns 80/443, serves the Qbix PHP app via php-fpm, AND is the
  # nginx Autohost configures (F1 closed — same nginx serves and is targeted).
  # Version comes from the pinned nixpkgs commit (flake.nix), not a hardcoded
  # number.
  services.nginx = {
    enable = true;
    recommendedTlsSettings = true;
    recommendedGzipSettings = true;
    recommendedOptimisation = true;
    recommendedProxySettings = true;

    # Default vhost: serve the Qbix app over php-fpm (C2 fix — something now
    # actually terminates and serves, via fastcgi to the php-fpm socket below,
    # instead of the dead 127.0.0.1:3000 proxyTarget).
    virtualHosts."_" = {
      default = true;
      root = "/safebox/www";
      locations."~ \\.php$" = {
        extraConfig = ''
          fastcgi_pass unix:${config.services.phpfpm.pools.safebox.socket};
          fastcgi_index index.php;
          include ${pkgs.nginx}/conf/fastcgi_params;
          fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        '';
      };
      locations."/" = {
        tryFiles = "$uri $uri/ /index.php?$query_string";
      };
    };

    # Autohost-managed custom-domain vhosts. Autohost writes here + reloads
    # nginx; because THIS nginx includes it, the domains serve. (F1)
    appendHttpConfig = ''
      include /etc/nginx/conf.d/auto/*.conf;
    '';
  };
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

  # ---- PHP-FPM — MEASURED host core (Bug-8 hardening) --------------------
  # Version from the nixpkgs pin. Socket is consumed by nginx above (C2 fix).
  services.phpfpm.pools.safebox = {
    user = "nginx";
    group = "nginx";
    settings = {
      "listen.owner" = "nginx";
      "listen.group" = "nginx";
      "pm" = "dynamic";
      "pm.max_children" = 32;
      "pm.start_servers" = 4;
      "pm.min_spare_servers" = 2;
      "pm.max_spare_servers" = 8;
    };
    phpOptions = ''
      expose_php = Off
      allow_url_include = Off
      allow_url_fopen = Off
      ; Bug-8: disable functions never needed in plugin web code.
      disable_functions = exec,passthru,shell_exec,system,proc_open,popen,curl_multi_exec,parse_ini_file,show_source,dl,phpinfo
    '';
  };

  # ---- PHP-FPM systemd sandbox (Bug-8+ hardening) -----------------------
  # php-fpm is the measured-base service that runs application code and faces
  # untrusted internet input through nginx — the highest-value place for a tight
  # syscall + filesystem sandbox. systemd's SystemCallFilter compiles to a
  # seccomp BPF filter, so this is the CPU-tier equivalent of the container
  # seccomp profiles, applied natively to the host service. All of this ships in
  # the measured base, so the confinement is attested.
  #
  # Calibrated to what a PHP app legitimately needs: serve from /safebox/www,
  # talk to MariaDB over its unix socket, write sessions/uploads to a private
  # temp. Everything escape-prone is denied.
  systemd.services."phpfpm-safebox".serviceConfig = {
    # Syscall confinement — allowlist by group, then subtract the dangerous.
    # NOTE: @resources is deliberately NOT stripped — the php-fpm master calls
    # setrlimit for worker process management, and removing it can break the
    # 'pm=dynamic' pool. @privileged and @obsolete are the high-value removals.
    SystemCallFilter = [ "@system-service" "~@privileged" "~@obsolete" ];
    SystemCallErrorNumber = "EPERM";
    SystemCallArchitectures = "native";
    # Filesystem confinement.
    ProtectSystem = "strict";              # whole FS read-only …
    ReadWritePaths = [ "/safebox/www" ];   # … except the app root
    ProtectHome = true;
    PrivateTmp = true;                     # private /tmp for sessions/uploads
    PrivateDevices = true;                 # no raw device access
    ProtectKernelTunables = true;
    ProtectKernelModules = true;           # cannot load kernel modules
    ProtectKernelLogs = true;
    ProtectControlGroups = true;
    ProtectClock = true;
    ProtectHostname = true;
    ProtectProc = "invisible";             # cannot see other processes in /proc
    ProcSubset = "pid";
    RestrictNamespaces = true;             # no unshare/new namespaces
    RestrictRealtime = true;
    RestrictSUIDSGID = true;
    LockPersonality = true;
    NoNewPrivileges = true;
    # NOTE: MemoryDenyWriteExecute is intentionally OMITTED — PHP OPcache with
    # JIT enabled uses W+X mappings and would fail to start under it. If the app
    # confirms opcache.jit is off, add `MemoryDenyWriteExecute = true;` for the
    # extra W^X guarantee.
    # Network: MariaDB over unix socket, nginx over the fpm socket. AF_NETLINK is
    # included because getaddrinfo/libc interface enumeration needs it; without
    # it, any DNS resolution in PHP can fail.
    RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" "AF_NETLINK" ];
    # php-fpm workers run as nginx (non-root) and need no capabilities.
    CapabilityBoundingSet = "";
    UMask = "0077";
  };


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
