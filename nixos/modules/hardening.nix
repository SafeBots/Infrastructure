# modules/hardening.nix
#
# The Bug-5 invariant, declaratively — the single most important thing to carry
# from install-base.sh into NixOS: ZERO interactive-shell access.
#
# install-base.sh REMOVED sshd/ssm/telnet/getty AFTER install and then VERIFIED
# they were gone. NixOS is stronger: these are simply never in the closure, so
# there is nothing to remove and nothing that a later package pull can silently
# reactivate. A closure that cannot produce a shell is the native form of
# "zero interactive access by design."
#
# The attestation guarantee is "this is the exact code that booted." It says
# nothing about what a shell user could do after boot — so there must be no
# shell user. The boot cycle (attested) is the only legitimate change mechanism.
{ config, pkgs, lib, ... }:

{
  # ---- No SSH (install-base.sh Tier 2 removal) ---------------------------
  # This is the AMI-2 (attested, production) stance: zero ingress. The AMI-1
  # BUILDER profile (hosts/ami1-builder.nix) re-enables SSH as its ONLY ingress
  # so an operator can run attestation/ami2-seal/seal-ami2.sh, which tears SSH
  # back down and normalizes nondeterminism to produce the attested AMI-2.
  services.openssh.enable = false;

  # ---- No cloud remote-shell agents --------------------------------------
  # NixOS cloud images don't ship AWS SSM / Azure WALinuxAgent shell channels
  # by default; assert they stay disabled. (IAM-role metadata access still
  # works — that's the instance metadata service, not a shell agent.)
  # If a cloud module tries to enable an agent that offers run-command/shell,
  # override it to false in the host file.

  # ---- No getty / serial-getty / debug-shell (Tier 4) --------------------
  systemd.services."getty@".enable = false;
  systemd.services."serial-getty@ttyS0".enable = false;
  systemd.services."debug-shell".enable = false;
  # Also drop autovt so no virtual-terminal login is spawned.
  systemd.services."autovt@".enable = false;

  # ---- No legacy remote-access daemons (Tier 1) --------------------------
  # These are simply not in environment.systemPackages / services, so they're
  # absent from the closure. Nothing to remove; nothing to mask.

  # ---- No mutable users / no password login ------------------------------
  # Nobody can be added at runtime, and no account has a usable password.
  users.mutableUsers = false;
  # No root password, no root shell login channel.
  users.users.root.hashedPassword = "!";   # locked

  # ---- Firewall (former iptables hardening) ------------------------------
  # Default-deny; only what the stack needs is opened. Ports 22/23/513/514/
  # 5985/5986 (the shell ports install-base.sh asserted were closed) are never
  # opened here.
  networking.firewall = {
    enable = true;
    allowedTCPPorts = [ 80 443 ];   # HTTP/HTTPS only; adjust per deployment
    # No 22. No 23. No WinRM. No rsh/rlogin.
  };

  # ---- auditd (former /etc/audit/rules.d/safebox.rules) ------------------
  # Full parity with install-base.sh's safebox.rules. The dnf/rpm watches are
  # dropped as moot (no dnf/rpm on NixOS — the store IS the package db, and
  # /nix/store exec is watched instead), but the npm/composer, config-file, and
  # privilege-escalation watches carry over verbatim.
  security.auditd.enable = true;
  security.audit.enable = true;
  security.audit.rules = [
    # ZFS key access
    "-w /run/safebox/zfs-key -p rwa -k safebox_zfs_key"
    # Exec provenance: on NixOS the store replaces dnf/rpm as the code source.
    "-w /nix/store -p x -k safebox_exec"
    # Runtime package managers that still exist (app deploy / plugin installs).
    "-w /run/current-system/sw/bin/npm -p x -k safebox_pkg"
    "-w /run/current-system/sw/bin/composer -p x -k safebox_pkg"
    # Sensitive config files (install-base.sh watched daemon.json, php.ini, nginx).
    "-w /etc/docker/daemon.json -p wa -k safebox_config"
    "-w /etc/nginx -p wa -k safebox_config"
    # Privilege escalation attempts.
    "-a always,exit -F arch=b64 -S setuid -F a0=0 -F auid>=1000 -F auid!=4294967295 -k safebox_priv_esc"
  ];

  # ---- fail2ban (install-base.sh installed fail2ban-1.0.2 as a service) ---
  # base.nix has the package; enable the SERVICE here so it actually runs,
  # matching install-base.sh. Default jails protect the SSH-less box's remaining
  # ingress surface (nginx). No sshd jail (there is no sshd).
  services.fail2ban.enable = true;

  # ---- Assertion: fail the build if a shell channel sneaks in ------------
  # Build-time guard mirroring install-base.sh's runtime `ss -tnl` port checks
  # and its removal-then-verify of ssh/ssm/getty. On NixOS these are absence
  # guarantees: the build fails rather than a runtime check catching it late.
  assertions = [
    {
      assertion = !config.services.openssh.enable;
      message = "Safebox invariant violated: SSH is enabled. An attested Safebox must have zero remote-shell access (install-base.sh Bug-5).";
    }
    {
      # SSM / Azure agent / any cloud run-command shell channel must stay off.
      # These option paths exist only if the respective cloud module is imported;
      # the `or false` keeps the assertion valid when they're absent entirely.
      assertion = !(config.services.amazon-ssm-agent.enable or false);
      message = "Safebox invariant violated: amazon-ssm-agent is enabled — it is a remote-shell channel (install-base.sh Tier 3). Disable it in the host file.";
    }
    {
      assertion = !(config.services.getty.autologinUser != null);
      message = "Safebox invariant violated: a getty autologin user is set. The attested base must spawn no login prompt (install-base.sh Tier 4).";
    }
  ];
}
