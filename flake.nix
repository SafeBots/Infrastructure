{
  description = "Safebox Infrastructure — immutable base image";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
  };

  outputs = { self, nixpkgs }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs { inherit system; };
  in {
    # The base image as a NixOS system configuration.
    # This is the declarative equivalent of install-base.sh: no SSH, no TTY,
    # ZFS-backed storage, Docker for managed containers, Node.js system component.
    nixosConfigurations.safebox-base = nixpkgs.lib.nixosSystem {
      inherit system;
      modules = [
        ./nix/base.nix
        ./nix/system-component.nix
      ];
    };

    # Individual packages — useful for CI and for pulling components
    # into other NixOS configurations without importing the full base.
    packages.${system} = {
      system-component = pkgs.callPackage ./nix/system-component.nix {};
      default = self.nixosConfigurations.safebox-base.config.system.build.toplevel;
    };

    # VM-based integration test. Boots the base image in a QEMU VM and
    # verifies: safebox-system starts, SSH is absent, Docker is running,
    # ZFS tools are available, health endpoint responds.
    checks.${system}.integration = import ./nix/tests/integration.nix { inherit pkgs; };
  };
}
