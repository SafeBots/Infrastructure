{
  description = "Safebox Console — frozen outer Safebox image (Inductive Security base case)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";
  };

  outputs = { self, nixpkgs }: let
    system = "x86_64-linux";
    pkgs = nixpkgs.legacyPackages.${system};
  in {
    # The NixOS configuration for the outer Safebox Console.
    # This produces a fully reproducible, read-only system image.
    nixosConfigurations.safebox-console = nixpkgs.lib.nixosSystem {
      inherit system;
      modules = [
        ./configuration.nix
        ./hardware-configuration.nix
      ];
    };

    # Build the image as a raw disk for cloud import
    packages.${system} = {
      # Raw disk image for AWS AMI import
      image-raw = self.nixosConfigurations.safebox-console.config.system.build.image;

      # QCOW2 for testing
      image-qcow2 = self.nixosConfigurations.safebox-console.config.system.build.qcow2Image;
    };
  };
}
