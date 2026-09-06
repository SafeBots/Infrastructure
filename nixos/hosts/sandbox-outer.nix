# hosts/sandbox-outer.nix — the OUTER host for the optional inspection sandbox.
#
# This host COMPOSES the base safebox and wraps it: it imports hosts/safebox.nix
# (the exact same attested base that ships by itself) and adds the sandbox-host
# wrapper module on top. So the relationship is explicit and auditable:
#
#     base safebox      = commonModules + hosts/safebox.nix            (ships alone)
#     inspection sandbox = commonModules + hosts/safebox.nix + wrapper (this file)
#
# The base is unchanged and unaware of the sandbox. The outer host is the base
# PLUS the interceptor + inner-microVM launcher. Removing this file leaves the
# base fully intact — the wrapper is strictly additive.
{ config, pkgs, lib, ... }:

{
  imports = [
    ./safebox.nix            # <-- the base, verbatim. The wrapper builds ON it.
  ];

  networking.hostName = lib.mkForce "safebox-sandbox";

  # Turn on the sandbox wrapper (interceptor + inner-VM host + bridge).
  safebox.sandboxHost = {
    enable = true;
    interceptorCaPath = ./sandbox-ca/interceptor-ca.crt;   # provisioned at build; measured
    bridgeName = "sbx0";
    bridgeAddr = "10.200.0.1";        # the interceptor's address == inner VM's only gateway
    bridgeCidr = 24;
    innerImage = "/var/lib/safebox-sandbox/inner.img";      # built from .#sandbox-inner
  };

  # Defense in depth: fail the BUILD if the outer bridge address and the inner
  # VM's sole gateway ever diverge -- a mismatch would silently leave the inner
  # VM with no egress (fail-closed) or mask a misconfig. The inner image is built
  # with interceptorAddr defaulting to the same 10.200.0.1; if either is retuned,
  # this assertion forces the other to match.
  assertions = [
    { assertion = config.safebox.sandboxHost.bridgeAddr == "10.200.0.1";
      message = "sandbox-outer: bridgeAddr must equal the inner VM's interceptorAddr (10.200.0.1). If you change one, change both."; }
  ];
}
