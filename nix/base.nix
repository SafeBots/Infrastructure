# nix/base.nix — NixOS module for the Safebox base image.
#
# This is the declarative replacement for install-base.sh.
# Key invariants:
#   - No SSH. Ever. openssh is never in the closure (not installed-then-removed).
#   - No TTY login. getty services are disabled.
#   - ZFS for storage. hostId is required.
#   - Docker for managed containers, overlay2 driver, journald logging.
#   - Node.js system component runs as a systemd service.
#   - Firewall allows only 443/tcp (HTTPS).

{ config, pkgs, lib, ... }:
{
  # --------------------------------------------------------------------------
  # Boot and kernel
  # --------------------------------------------------------------------------
  boot.loader.grub.enable = true;
  boot.kernelPackages = pkgs.linuxPackages_latest;

  # ZFS support
  boot.supportedFilesystems = [ "zfs" ];
  boot.zfs.forceImportRoot = false;
  networking.hostId = "deadbeef"; # must be set for ZFS — override per deployment

  # --------------------------------------------------------------------------
  # No SSH — ever
  # --------------------------------------------------------------------------
  # This is the Nix equivalent of install-base.sh's SSH removal.
  # SSH is never in the closure, not installed-then-removed.
  services.openssh.enable = lib.mkForce false;

  # --------------------------------------------------------------------------
  # No TTY login
  # --------------------------------------------------------------------------
  services.getty.autologinUser = null;
  systemd.services."getty@".enable = false;
  systemd.services."serial-getty@".enable = false;

  # --------------------------------------------------------------------------
  # Docker for managed containers
  # --------------------------------------------------------------------------
  virtualisation.docker = {
    enable = true;
    autoPrune.enable = true;
    daemon.settings = {
      "storage-driver" = "overlay2";
      "log-driver" = "journald";
      "no-new-privileges" = true;
    };
  };

  # --------------------------------------------------------------------------
  # System packages
  # --------------------------------------------------------------------------
  environment.systemPackages = with pkgs; [
    nodejs_20
    zfs
    docker
    curl  # health checks only
    jq    # config parsing
  ];

  # --------------------------------------------------------------------------
  # Firewall: only the ports we need
  # --------------------------------------------------------------------------
  networking.firewall = {
    enable = true;
    allowedTCPPorts = [ 443 ]; # HTTPS only
  };

  # --------------------------------------------------------------------------
  # Kernel and system hardening
  # --------------------------------------------------------------------------
  security = {
    lockKernelModules = true;
    protectKernelImage = true;
    allowSimultaneousMultithreading = true;
  };

  # --------------------------------------------------------------------------
  # Systemd service: Safebox system component
  # --------------------------------------------------------------------------
  systemd.services.safebox-system = {
    description = "Safebox System Component";
    after = [ "network.target" "docker.service" "zfs.target" ];
    wants = [ "docker.service" "zfs.target" ];
    wantedBy = [ "multi-user.target" ];

    serviceConfig = {
      Type = "simple";
      ExecStart = "${pkgs.nodejs_20}/bin/node /opt/safebox/system/server.js";
      Restart = "always";
      RestartSec = 5;

      # Security hardening
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      ReadWritePaths = [
        "/run/safebox"
        "/etc/safebox"
        "/srv/safebox"
      ];
      PrivateTmp = true;
    };

    environment = {
      NODE_ENV = "production";
      SAFEBOX_SYSTEM_CONFIG = "/etc/safebox/managed-containers.json";
      SAFEBOX_SYSTEM_SECRET = "/etc/safebox/system.hmac";
    };
  };

  # --------------------------------------------------------------------------
  # Required directories (created at boot via tmpfiles)
  # --------------------------------------------------------------------------
  systemd.tmpfiles.rules = [
    "d /run/safebox 0750 root root -"
    "d /run/safebox/containers 0750 root root -"
    "d /etc/safebox 0750 root root -"
    "d /srv/safebox 0750 root root -"
    "d /srv/safebox/models 0750 root root -"
    "d /srv/safebox/volumes 0750 root root -"
  ];

  system.stateVersion = "24.11";
}
