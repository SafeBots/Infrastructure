# nix/tests/integration.nix — NixOS VM test for the Safebox base image.
#
# Verifies:
#   - safebox-system service starts and its control socket appears
#   - SSH is not running and not installed
#   - TTY login is disabled
#   - Docker is running
#   - ZFS tools are available
#   - Health endpoint responds with { status: "ok" }

{ pkgs }:
pkgs.nixosTest {
  name = "safebox-integration";

  nodes.safebox = { config, pkgs, ... }: {
    imports = [ ../../nix/base.nix ];

    # Override for test: use a mock system component that listens on the
    # Unix control socket and responds to health checks.
    systemd.services.safebox-system.serviceConfig.ExecStart =
      pkgs.lib.mkForce "${pkgs.nodejs_20}/bin/node -e \"
        const http = require('http');
        const server = http.createServer((req, res) => {
          res.writeHead(200, {'content-type': 'application/json'});
          res.end(JSON.stringify({status: 'ok', uptime: process.uptime()}));
        });
        server.listen('/run/safebox/control.sock');
        console.log('mock system component started');
      \"";
  };

  testScript = ''
    safebox.start()
    safebox.wait_for_unit("safebox-system.service")

    # Verify SSH is not running and not installed
    safebox.fail("systemctl is-active sshd")
    safebox.fail("which sshd")

    # Verify no TTY login
    safebox.fail("systemctl is-active getty@tty1")

    # Verify Docker is running
    safebox.wait_for_unit("docker.service")

    # Verify ZFS tools are available
    safebox.succeed("which zfs")
    safebox.succeed("which zpool")

    # Verify the system component socket exists
    safebox.wait_for_file("/run/safebox/control.sock")

    # Verify health endpoint
    safebox.succeed("curl --unix-socket /run/safebox/control.sock http://localhost/healthz | jq -e '.status == \"ok\"'")
  '';
}
