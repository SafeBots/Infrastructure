# Safebox Console — NixOS configuration
#
# This is the Inductive Security base case P(0): a frozen, fully deterministic,
# fully open-source image that runs exactly ONE Qbix app (the Safebox Console)
# and nothing else. The image is built with Nix for full reproducibility:
# anyone can build it from source and verify the hash matches the deployed image.
#
# The Console serves three roles:
#   1. Governance gateway — M-of-N operations for the paired inner Safebox
#   2. Egress proxy — domain-based allowlist for inner Safebox outbound traffic
#   3. Key custodian — organization keys sealed to this box's TPM
#
# The Software Signer (the signing key sealed to this box's TPM, with the
# signing logic baked into this image) is a REQUIRED co-signer in the M-of-N
# governance quorum. It enforces structural invariants:
#   - Will not co-sign image updates that remove dm-verity
#   - Will not co-sign allowlist changes for bare IP addresses
#   - Will not co-sign its own removal from the required signers
#   - Will not co-sign succession to an image without a Software Signer
#
# This image is NEVER updated in place. Changes go through governed succession:
# a new Console image is built, the existing M-of-N quorum (including the
# current Software Signer) blesses it, and the new image is deployed as a
# replacement. The old Console continues running until the new one is verified.

{ config, pkgs, lib, ... }:

{
  # ── System basics ──────────────────────────────────────────────────────

  system.stateVersion = "24.05";

  # Read-only root filesystem. The Nix store is already immutable;
  # this ensures nothing outside it can be modified either.
  fileSystems."/" = {
    device = "none";
    fsType = "tmpfs";
    options = [ "defaults" "size=256M" "mode=755" ];
  };

  fileSystems."/nix/store" = {
    device = "/dev/disk/by-label/nixos";
    fsType = "ext4";
    options = [ "ro" ];
  };

  # Data partition: encrypted ZFS pool for mutable state (keys, audit log,
  # allowlist state). Sealed to TPM, same pattern as the inner Safebox.
  # The pool is created on first boot by the console-firstboot service.

  boot.loader.grub = {
    enable = true;
    device = "nodev";
    efiSupport = true;
    # GRUB password set at build time; no recovery entry
    extraConfig = ''
      set superusers="safebox"
    '';
  };

  boot.loader.efi.canTouchEfiVariables = false;

  # Minimal kernel: no modules we don't need
  boot.kernelParams = [
    "lockdown=integrity"
    "kernel.sysrq=0"
    "quiet"
  ];

  # ── Networking ─────────────────────────────────────────────────────────

  networking = {
    hostName = "safebox-console";
    firewall = {
      enable = true;
      allowedTCPPorts = [
        443   # HTTPS — Console web UI and egress proxy API
        8443  # dnsclient challenge endpoint
        9443  # Inner Safebox private link (egress proxy + governance API)
      ];
      # No SSH, no HTTP by default
    };
    # No IPv6 unless explicitly needed
    enableIPv6 = false;
  };

  # ── Services ───────────────────────────────────────────────────────────

  # Nginx: TLS termination for the Console app and the egress proxy
  services.nginx = {
    enable = true;
    recommendedTlsSettings = true;
    recommendedOptimisation = true;
    recommendedGzipSettings = true;
    recommendedProxySettings = true;

    virtualHosts = {
      # Console web UI — governance interface
      "console" = {
        forceSSL = true;
        # Self-signed initially; real cert via ACME or manual provisioning
        sslCertificate = "/var/lib/safebox/tls/console.crt";
        sslCertificateKey = "/var/lib/safebox/tls/console.key";
        locations."/" = {
          proxyPass = "http://unix:/run/safebox/console-app.sock";
        };
      };

      # Egress proxy — inner Safebox sends outbound requests here
      "egress" = {
        listen = [{ addr = "0.0.0.0"; port = 9443; ssl = true; }];
        sslCertificate = "/var/lib/safebox/tls/console.crt";
        sslCertificateKey = "/var/lib/safebox/tls/console.key";
        locations."/" = {
          proxyPass = "http://unix:/run/safebox/egress-proxy.sock";
        };
      };
    };
  };

  # PHP-FPM for the one Qbix app (Safebox Console)
  services.phpfpm.pools.console = {
    user = "safebox-console";
    group = "safebox-console";
    settings = {
      "listen" = "/run/safebox/console-app.sock";
      "listen.owner" = "nginx";
      "listen.group" = "nginx";
      "pm" = "dynamic";
      "pm.max_children" = 8;
      "pm.start_servers" = 2;
      "pm.min_spare_servers" = 1;
      "pm.max_spare_servers" = 4;
      "php_admin_value[expose_php]" = "Off";
      "php_admin_value[disable_functions]" = "exec,passthru,shell_exec,system,proc_open,popen,parse_ini_file,show_source";
    };
  };

  # ── Users ──────────────────────────────────────────────────────────────

  users.users.safebox-console = {
    isSystemUser = true;
    group = "safebox-console";
    home = "/var/lib/safebox/console";
    shell = pkgs.shadow + "/bin/nologin";
    uid = 991;
  };

  users.groups.safebox-console = {
    gid = 991;
  };

  # ── Security hardening ────────────────────────────────────────────────

  # No SSH
  services.openssh.enable = false;

  # No unnecessary services
  services.avahi.enable = false;

  # Hardened sysctls matching the inner Safebox
  boot.kernel.sysctl = {
    "kernel.kptr_restrict" = 2;
    "kernel.dmesg_restrict" = 1;
    "kernel.yama.ptrace_scope" = 3;
    "kernel.unprivileged_bpf_disabled" = 1;
    "net.core.bpf_jit_harden" = 2;
    "net.ipv4.conf.all.accept_redirects" = 0;
    "net.ipv4.conf.default.accept_redirects" = 0;
    "net.ipv4.conf.all.send_redirects" = 0;
    "net.ipv4.conf.default.send_redirects" = 0;
    "net.ipv4.icmp_ignore_bogus_error_responses" = 1;
  };

  # Minimal package set — nothing that isn't needed
  environment.systemPackages = with pkgs; [
    # Runtime
    nodejs_20
    php83
    nginx

    # TPM tools for Software Signer
    tpm2-tools
    tpm2-tss

    # Nftables for egress allowlist enforcement
    nftables

    # Diagnostics (no shell access, but useful in the journal)
    coreutils
    iproute2
    curl
  ];

  # No documentation, no man pages, no info
  documentation.enable = false;

  # ── Software Signer service ───────────────────────────────────────────

  # The Software Signer is a Node.js service that:
  #   1. Holds a signing key sealed to this box's TPM
  #   2. Listens on a Unix socket for co-signing requests
  #   3. Validates each request against structural invariants
  #   4. Co-signs only if invariants are satisfied
  #
  # It is installed from common/console/software-signer/ and runs as its
  # own user with no network access (IPAddressDeny=any) — it communicates
  # only through its Unix socket.

  systemd.services.safebox-software-signer = {
    description = "Safebox Software Signer (Inductive Security invariant enforcer)";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];

    serviceConfig = {
      Type = "simple";
      User = "safebox-signer";
      Group = "safebox-signer";
      ExecStart = "${pkgs.nodejs_20}/bin/node /opt/safebox/console/software-signer/signer.js";
      Restart = "always";
      RestartSec = 5;

      # The Software Signer has NO network access. It talks only through
      # its Unix socket. This is belt-and-suspenders: even if the signer
      # code has a bug, it cannot exfiltrate the signing key over the network.
      IPAddressDeny = "any";

      # Read-only filesystem except for the socket and the TPM device
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      NoNewPrivileges = true;
      CapabilityBoundingSet = "";
      SystemCallFilter = "@system-service";

      RuntimeDirectory = "safebox-signer";
    };
  };

  users.users.safebox-signer = {
    isSystemUser = true;
    group = "safebox-signer";
    shell = pkgs.shadow + "/bin/nologin";
    uid = 989;
  };

  users.groups.safebox-signer = {
    gid = 989;
  };

  # ── Egress proxy service ──────────────────────────────────────────────

  # The egress proxy accepts requests from the inner Safebox on port 9443,
  # checks each destination against the governed allowlist, and forwards
  # allowed requests. It runs as safebox-infra (uid 990) and listens on
  # a Unix socket that nginx proxies to.

  systemd.services.safebox-egress-proxy = {
    description = "Safebox egress proxy (governed allowlist)";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" "safebox-software-signer.service" ];

    serviceConfig = {
      Type = "simple";
      User = "safebox-infra";
      Group = "safebox-infra";
      ExecStart = "${pkgs.nodejs_20}/bin/node /opt/safebox/console/egress-proxy/proxy.js";
      Restart = "always";
      RestartSec = 5;

      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      NoNewPrivileges = true;
      SystemCallFilter = "@system-service";

      RuntimeDirectory = "safebox-egress";
      StateDirectory = "safebox/egress";
    };
  };
}
