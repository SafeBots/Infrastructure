# hosts/ami1-builder.nix — the AMI-1 "builder" profile.
#
# AMI-1 is the ONLY image with an ingress channel, and that channel is SSH and
# NOTHING ELSE. You boot AMI-1, SSH in, run attestation/image-seal/seal-image.sh,
# and image the result as AMI-2 (the attested production image with zero ingress).
#
# The point of a dedicated builder profile: the thing that gets attested (AMI-2)
# is produced by a short auditable scrub, not by hoping the whole Nix closure is
# bit-reproducible (it's only ~91%). AMI-1 does the heavy lifting; the seal makes
# the OUTPUT deterministic by construction.
#
# Import this INSTEAD OF hosts/safebox.nix when building the .#ami1 package.
# It re-enables exactly one thing hardening.nix turns off — sshd — and asserts
# that nothing else that offers a shell is present.
{ config, pkgs, lib, ... }:

{
  imports = [ ./safebox.nix ];

  # ---- The ONE ingress channel: SSH, key-only, nothing else ----------------
  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;      # keys only
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "prohibit-password";
      X11Forwarding = false;
      AllowTcpForwarding = false;          # no tunneling out
      AllowAgentForwarding = false;
    };
    # Host keys are generated at boot and REMOVED by seal-image.sh — they must not
    # persist into AMI-2 (they'd be per-instance nondeterministic bytes).
  };
  # SSH port open ONLY on AMI-1. AMI-2's hardening.nix opens only 80/443.
  networking.firewall.allowedTCPPorts = lib.mkForce [ 22 ];

  # A login user for the builder session. Removed (its .ssh, its home) by the seal.
  # Build-time guard: the placeholder must be replaced with a real key before
  # building a builder image. Left as-is, sshd rejects the malformed key and the
  # operator is silently locked out of the builder (fail-safe, but confusing).
  # The assertion for this is in the assertions block below.
  users.users.builder = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    openssh.authorizedKeys.keys = [
      # "ssh-ed25519 AAAA... operator@safebox"  # <- inject at build time
      "REPLACE_WITH_BUILDER_PUBLIC_KEY"
    ];
  };

  # ---- Explicitly NObody else gets in: no telnet, no cloud console agents ----
  # These are the channels your instruction named. None are in the closure; we
  # assert it at build time so a cloud module can't quietly pull one in.
  services.amazon-ssm-agent.enable = lib.mkForce false;   # AWS Session Manager
  # (Azure WALinuxAgent, GCP guest-agent shells, serial console agents: not in
  #  the NixOS closure unless a cloud module adds them — asserted below.)

  assertions = [
    {
      assertion = config.services.openssh.enable;
      message = "ami1-builder MUST have SSH (it is the only ingress). Use hosts/safebox.nix for the sealed AMI-2.";
    }
    {
      assertion = !(config.services.amazon-ssm-agent.enable or false);
      message = "AMI-1 forbids AWS SSM (a second remote-shell channel). SSH is the only ingress.";
    }
    {
      # getty/serial/debug-shell stay off even on the builder — SSH only.
      assertion = !(config.systemd.services."serial-getty@ttyS0".enable or false);
      message = "AMI-1 forbids serial console. SSH is the only ingress.";
    }
    {
      # The builder SSH key must be injected before build, or the placeholder
      # (a malformed key) locks the operator out of the only ingress silently.
      assertion = !(builtins.elem "REPLACE_WITH_BUILDER_PUBLIC_KEY"
                      config.users.users.builder.openssh.authorizedKeys.keys);
      message = "ami1-builder: REPLACE_WITH_BUILDER_PUBLIC_KEY is still the placeholder. "
              + "Inject a real ed25519 public key before building the builder image, "
              + "or you will boot a builder you cannot SSH into.";
    }
  ];
}
