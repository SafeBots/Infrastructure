# Safebox Console — hardware configuration
#
# Per-cloud hardware configuration. This file is a placeholder that gets
# overridden at build time by the cloud-specific hardware configuration
# (e.g., aws/console/hardware-configuration.nix). Each cloud variant
# sets the correct kernel, boot device, and vTPM configuration.
#
# The separation keeps the main configuration.nix cloud-agnostic while
# allowing each cloud to specify its own kernel modules, disk layout,
# and attestation hardware.

{ config, lib, pkgs, modulesPath, ... }:

{
  imports = [
    (modulesPath + "/profiles/qemu-guest.nix")
  ];

  # Default: QEMU/KVM for local testing. Cloud-specific overrides replace this.
  boot.initrd.availableKernelModules = [
    "virtio_pci" "virtio_blk" "virtio_scsi" "virtio_net"
    "ahci" "sd_mod" "sr_mod"
  ];

  boot.kernelModules = [ "kvm-amd" "kvm-intel" "tpm_tis" "tpm_crb" ];

  # The root disk. Cloud-specific overrides set the actual device.
  fileSystems."/" = lib.mkDefault {
    device = "/dev/vda1";
    fsType = "ext4";
    options = [ "ro" ];
  };

  # Data disk for ZFS pool (mutable state: keys, audit log, allowlist)
  # Created on first boot, same as the inner Safebox.
  fileSystems."/var/lib/safebox" = lib.mkDefault {
    device = "zpool/console";
    fsType = "zfs";
  };
}
