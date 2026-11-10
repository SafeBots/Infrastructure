#!/bin/bash
# dracut module "safebox": installs the TPM unseal step into the initramfs
# and orders it before every zfs-import unit. Installed on all four
# distributions (AL2023, OL9, Debian, Ubuntu) from the same source; Debian and
# Ubuntu images use dracut instead of initramfs-tools for exactly this reason.
#
# dracut sources this file; it must not run anything at source time beyond
# defining the four hook functions below.

# Called by dracut to decide whether the module can be included. We require
# tpm2-tools and zfs on the build host because the initramfs is useless
# without them, and a silent omission would produce an image that never
# boots on any cloud.
check() {
    require_binaries tpm2_create tpm2_unseal tpm2_pcrextend zpool zfs || return 1
    return 0
}

# The unseal unit is a systemd unit (not a dracut hook script), hence
# "systemd". "dm" brings the device-mapper tooling systemd-veritysetup needs
# at the point our unit's ordering references initrd-root-fs.target. "zfs"
# supplies the kernel module, zpool/zfs binaries and their import units,
# which our unit orders itself before.
depends() {
    echo systemd dm zfs
    return 0
}

# Kernel modules: dm-verity for the root, and the TPM stack. tpm_tis covers
# the AWS NitroTPM and GCP/Azure vTPM (TIS/FIFO or CRB interface depending on
# the hypervisor); tpm_crb covers the CRB-only firmware TPMs on OCI and some
# Azure generations. Both are harmless if unused.
installkernel() {
    hostonly='' instmods dm-verity tpm tpm_tis tpm_crb
}

install() {
    # Userland the unseal script calls. inst_multiple fails the build if any
    # is missing, which is the behaviour we want.
    inst_multiple \
        tpm2_createprimary tpm2_create tpm2_load tpm2_unseal \
        tpm2_startauthsession tpm2_policypcr tpm2_flushcontext \
        tpm2_pcrread tpm2_pcrextend \
        blkid lsblk shred sha256sum zpool zfs \
        mount umount chown chmod mkdir sync install stat head cut tr grep \
        readlink basename sleep rmdir mv rm cat od dirname false

    # tpm2-tools speaks to the kernel through libtss2-tcti-device, which is
    # dlopen()ed at runtime and therefore invisible to dracut's automatic
    # library dependency scan. Install every TCTI/ESYS library found so the
    # tools can open /dev/tpmrm0.
    local lib
    for lib in /usr/lib64/libtss2-* /usr/lib/x86_64-linux-gnu/libtss2-*; do
        [ -e "$lib" ] || continue
        inst_library "$lib"
    done

    # The two scripts. The unseal script hard-codes the library path, so the
    # destination directory is part of the contract between the two files.
    # They are taken from the module directory if the installer copied them
    # there, else from /usr/lib/safebox on the build root.
    local src
    for src in safebox-seal.sh safebox-unseal.sh; do
        if [ -r "$moddir/$src" ]; then
            inst_simple "$moddir/$src" "/usr/lib/safebox/$src"
        elif [ -r "/usr/lib/safebox/$src" ]; then
            inst_simple "/usr/lib/safebox/$src" "/usr/lib/safebox/$src"
        else
            dfatal "safebox: $src not found in $moddir or /usr/lib/safebox"
            return 1
        fi
    done
    chmod 0755 "$initdir/usr/lib/safebox/safebox-unseal.sh"
    chmod 0644 "$initdir/usr/lib/safebox/safebox-seal.sh"

    # The unit, enabled in the initrd target. $SYSTEMD_ENABLE is not a
    # dracut variable on every version we support, so enable by creating the
    # wants symlink directly; that is exactly what systemctl enable would do
    # for a unit with WantedBy=initrd.target.
    inst_simple "$moddir/safebox-unseal.service" \
        "$systemdsystemunitdir/safebox-unseal.service"
    mkdir -p "$initdir$systemdsystemunitdir/initrd.target.wants" \
             "$initdir$systemdsystemunitdir/initrd-root-fs.target.requires"
    ln_r "$systemdsystemunitdir/safebox-unseal.service" \
        "$systemdsystemunitdir/initrd.target.wants/safebox-unseal.service"
    # Requires (not Wants) from the root-fs target: a failed unseal must
    # block switch-root, not merely be logged.
    ln_r "$systemdsystemunitdir/safebox-unseal.service" \
        "$systemdsystemunitdir/initrd-root-fs.target.requires/safebox-unseal.service"

    # The unit Requires= and orders After= dev-tpmrm0.device. systemd only
    # creates .device units for devices udev tags "systemd", and the stock
    # 99-systemd.rules tags block, tty and net devices but not the TPM
    # character device; without this rule the device unit never appears,
    # the Requires= job times out and the boot fails closed on every box.
    mkdir -p "$initdir/usr/lib/udev/rules.d"
    printf 'SUBSYSTEM=="tpmrm", KERNEL=="tpmrm*", TAG+="systemd"\n' \
        > "$initdir/usr/lib/udev/rules.d/90-safebox-tpm.rules"

    # No emergency shell inside the initramfs, ever. If safebox-unseal.sh
    # fails after the TPM has released the keys but before PCR 15 is
    # extended, dracut's default is to drop to a root shell on the serial
    # console with the sealing policy still satisfiable, and anyone holding
    # the console could run tpm2_unseal by hand. The kernel command line
    # sets rd.shell=0 rd.emergency=reboot; mask the units here as well so
    # the shell cannot be reached through a unit that ignores those
    # parameters, and leave out the helpers the shell would run.
    #
    # Ordering: dracut runs module install() hooks in directory order, so
    # this module (90) runs before 98dracut-systemd and 99base, which are
    # the modules that would install the real units, sushell and
    # rdsosreport. dracut-install skips a destination that already exists,
    # so planting the masks and stubs here first means the later modules
    # leave them in place. The stubs point at /bin/false rather than being
    # absent, because an absent path would simply be filled in later.
    local unit p
    mkdir -p "$initdir$systemdsystemunitdir" "$initdir/usr/bin" "$initdir/usr/sbin"
    for unit in dracut-emergency.service emergency.service emergency.target \
                rescue.service rescue.target; do
        rm -f "$initdir$systemdsystemunitdir/$unit"
        ln -s /dev/null "$initdir$systemdsystemunitdir/$unit"
    done
    for p in usr/bin/sushell usr/sbin/sushell usr/bin/rdsosreport usr/sbin/rdsosreport; do
        rm -f "$initdir/$p"
        ln -s /bin/false "$initdir/$p"
    done

    # Mount point for the boot partition inside the initramfs.
    mkdir -p "$initdir/boot"
}
