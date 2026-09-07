# qbix-webserver.nix — Qbix PHP webserver replacing php-fpm.
#
# The Qbix webserver (https://github.com/Qbix/webserver) is a pure-PHP web
# server that handles PHP execution, static files, WebSocket, access-controlled
# file serving (X-Accel-Redirect), and component-level cache invalidation
# (X-Cache-Tree) — all in one process, without nginx proxying to php-fpm.
#
# Why it replaces php-fpm:
#   - Fork-after-preload: workers inherit loaded classes via copy-on-write.
#     0ms bootstrap per request vs. 10–50ms on php-fpm.
#   - Shared-nothing: each request is a clean fork. No state leaks (unlike
#     Swoole/FrankenPHP). Your existing PHP code works exactly as on php-fpm.
#   - Memory: 30MB shared + ~5MB/worker vs. 30–60MB × N workers on php-fpm.
#   - WebSocket: built in. No separate Node server needed for socket.io basics.
#   - Access control: X-Accel-Redirect — PHP checks access, server streams file.
#   - Component cache: X-Cache-Tree — invalidate one component, keep the rest.
#
# nginx stays as a thin TLS terminator + sendfile for large static assets.
# The fastcgi_pass / php-fpm pool / socket wiring all go away.
#
# Future: the U webserver (https://github.com/ULanguageOrg/webserver) will
# replace this once PHP→U transpilation is production-ready, collapsing the
# entire stack into a single Cosmopolitan binary with no PHP dependency.
{ config, lib, pkgs, ... }:
let
  cfg = config.safebox.qbixWebserver;

  # Fetch the Qbix webserver from GitHub, pinned.
  # TAG v1.0.0 — update rev + hash when the tag is created.
  qbixWebserverSrc = pkgs.fetchFromGitHub {
    owner = "Qbix";
    repo = "webserver";
    rev = "v1.0.0";  # tagged 2026-08-31, commit ed49cd6
    sha256 = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    # ^^^ placeholder — run `nix-prefetch-git https://github.com/Qbix/webserver --rev v1.0.0`
    # to get the real hash, or `nix build` will error with the correct one.
  };
in {
  options.safebox.qbixWebserver = {
    enable = lib.mkEnableOption "Qbix PHP webserver (replaces php-fpm)";
    socketPath = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = "/run/safebox/qbix-webserver.sock";
      description = "Unix socket path for nginx to proxy to (preferred over TCP port). Set to null to use TCP port instead.";
    };
    port = lib.mkOption {
      type = lib.types.int; default = 9080;
      description = "TCP port (used only if socketPath is null). nginx proxies to this.";
    };
    workers = lib.mkOption {
      type = lib.types.int; default = 4;
      description = "Number of pre-fork workers (fork-after-preload, COW shared memory).";
    };
    appDir = lib.mkOption {
      type = lib.types.str; default = "/srv/safebox/apps/App";
      description = "APP_DIR for the Qbix Platform app (--app flag).";
    };
    webRoot = lib.mkOption {
      type = lib.types.str; default = "/safebox/www";
      description = "Document root for static files and PHP scripts.";
    };
    configPath = lib.mkOption {
      type = lib.types.str; default = "/srv/safebox/config/server.json";
      description = "Path to the Qbix webserver config (keepalive, cache, rate limit).";
    };
  };

  config = lib.mkIf cfg.enable {
    # ---- The Qbix webserver systemd service --------------------------------
    systemd.services."qbix-webserver" = {
      description = "Qbix PHP webserver (fork-after-preload, replaces php-fpm)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" "mysql.service" ];
      requires = [ "mysql.service" ];

      environment = {
        APP_DIR = cfg.appDir;
      };

      serviceConfig = {
        ExecStart = lib.concatStringsSep " " ([
          "${pkgs.php}/bin/php"
          "${qbixWebserverSrc}/qbixserver.php"
          "--root=${cfg.webRoot}"
          "--workers=${toString cfg.workers}"
          "--app=${cfg.appDir}"
          "--config=${cfg.configPath}"
        ] ++ (if cfg.socketPath != null
              then [ "--socket=${cfg.socketPath}" ]
              else [ "--port=${toString cfg.port}" ]));
        Restart = "on-failure";
        RestartSec = "2s";

        # Run as the web user (same as nginx, for file access parity)
        User = "nginx";
        Group = "nginx";

        # Hardening — same stance as the old php-fpm sandbox, ported verbatim.
        # The Qbix webserver is the measured-base service that runs application
        # code and faces untrusted internet input — tightest sandbox warranted.
        SystemCallFilter = [ "@system-service" "~@privileged" "~@obsolete" ];
        SystemCallErrorNumber = "EPERM";
        SystemCallArchitectures = "native";
        ProtectSystem = "strict";
        ReadWritePaths = [ cfg.webRoot "/run/safebox" ];
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        ProcSubset = "pid";
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        NoNewPrivileges = true;
        RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" "AF_NETLINK" ];
        CapabilityBoundingSet = "";
        UMask = "0077";
      };
    };
  };
}
