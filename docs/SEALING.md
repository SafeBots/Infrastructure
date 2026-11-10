# Safebox Image Sealing

## Overview

Safebox uses a **two-image workflow** to balance auditability with production hardening. The build pipeline produces two images from a single chroot:

- **Image A (audit):** SSH enabled, `safebox-audit` user present. Auditors boot a throwaway instance of this to inspect the full system.
- **Image B (production):** Identical to Image A except for a single flag file (`/etc/safebox/sealed`). On boot, `safebox-sealed-boot.service` detects this flag and masks SSH via overlay whiteouts, then applies kernel hardening.

The critical property: Image B differs from Image A by **exactly one block** on the dm-verity root partition. The seal script writes a single flag file; the build pipeline patches that one block on Image A's raw disk and recomputes the dm-verity hash tree. An auditor can verify this by recomputing the Merkle path for that one changed block (~21 hashes for an 8 GB partition).

## Build Flow

```
build-image.sh  (aws/, gcp/, azure/, oci/)
     |
     +-- debootstrap + component installers
     +-- cleanup-image.sh (host-side scrub of chroot)
     |
     +-- verify-image.sh --audit        <-- asserts SSH present, safebox-audit user
     +-- build-verity-root.sh           <-- writes verity disk, captures audit root hash
     +-- capture -> audit image          (AWS: AMI, GCP: GCE image, Azure: managed image, OCI: custom image)
     |
     +-- safebox-seal-image.sh --chroot <-- writes /etc/safebox/sealed (one file)
     +-- verify-image.sh                <-- asserts sealed flag present
     +-- build-verity-root.sh           <-- writes verity disk, captures production root hash
     +-- capture -> production image     (same cloud-specific format)
```

The workflow is identical across all four supported clouds (AWS, GCP, Azure, OCI). Each cloud's `build-image.sh` handles the cloud-specific capture mechanism while the chroot build, seal, and verity steps use the same shared scripts under `common/`.

Both verity builds use `mkfs.ext4 -d` (direct population via libext2fs, no kernel mount) with `SOURCE_DATE_EPOCH=0`, deterministic UUIDs, fixed hash seeds, no journal, and debugfs superblock normalisation. This makes the root partition byte-identical given the same directory tree, regardless of the build host's filesystem layout or the wall-clock time (see the Reproducibility section below for the full analysis).

## Audit Image (Image A)

The audit image is the full Safebox image with SSH as the **only** remote access vector. Every other way to get a shell -- cloud-init, SSM agent, serial console, hypervisor console -- is removed or disabled by `install-base.sh`. SSH is hardened:

- `PermitRootLogin no` -- root cannot log in
- `PasswordAuthentication no` -- keys only
- `AllowUsers safebox-audit` -- only the audit user can connect
- No baked-in host keys -- regenerated on first boot
- `MaxAuthTries 3`, `MaxSessions 2`, `ClientAliveInterval 300`

The `safebox-audit` user (uid 1100) has a home directory with the build team's authorized public keys. It can `sudo` to inspect anything auditors need to see. This is intentional: a meaningful audit requires reading `/etc/shadow`, checking TPM state, inspecting kernel parameters, and verifying that secrets are not on the root filesystem.

On an audit instance, `safebox-sealed-boot.service` sees no `/etc/safebox/sealed` flag and exits silently, so SSH runs normally, `kernel.modules_disabled` is not set, and `hidepid=2` is not applied -- auditors can load diagnostic modules and see all processes.

The build script accepts `--audit-pubkeys <file>` to inject auditor SSH public keys into the `safebox-audit` user's `authorized_keys` file. If omitted, the build team's default keys are used.

## The Seal Script

`safebox-seal-image.sh --chroot <rootfs>` transitions the chroot from audit to production state. It performs exactly one operation:

1. **Write the sealed flag** -- creates `/etc/safebox/sealed` with deterministic content (no timestamps, no variable data). Mode 0444.

That's it. SSH binaries, the audit user, config files, and packages all remain on the root filesystem. They are masked at boot time by the overlay (see Production Boot below), not removed from the disk image.

The script is idempotent: running it on an already-sealed chroot is a no-op.

### Why not remove SSH from the disk?

The root filesystem is protected by dm-verity -- the kernel verifies every block against a Merkle hash tree, making the root partition read-only and tamper-evident. The system boots with `systemd.volatile=overlay`, which places a tmpfs overlay on top of the read-only root for any runtime writes.

Removing SSH from the disk image would require modifying hundreds of files (binaries, libraries, man pages, dpkg database entries), rebuilding the entire ext4 filesystem, and recomputing the verity hash tree. Every one of those modifications is a potential source of nondeterminism that must be eliminated for the auditor verification round-trip to work.

The flag-only approach eliminates all of that complexity. The seal step changes exactly one file, which lands at a known block offset because `mkfs.ext4 -d` allocates blocks deterministically. The verity hash difference between Image A and Image B is exactly one leaf hash plus the ~21 interior Merkle tree nodes on the path from that leaf to the root.

### Security model

Removing SSH from the disk is defense-in-depth, not a security boundary. An attacker who gains root access on a running Safebox instance can install any backdoor program via the tmpfs overlay -- not just SSH, but any arbitrary binary. The attacker doesn't need SSH to be on the disk; they can bring their own tools.

The actual security against remote access comes from preventing root access in the first place:

- **dm-verity** ensures the root filesystem cannot be modified persistently
- **kernel.modules_disabled=1** prevents loading kernel modules after boot
- **All accounts locked** with shells set to nologin
- **TPM-sealed keys** bound to the measured boot chain
- **No cloud agents** (cloud-init, SSM, etc.) that could provide a shell

Masking SSH in the overlay at boot is a practical measure that prevents the SSH daemon from running, which is all that matters operationally. The SSH binaries sitting inert on the read-only verity root pose no risk because nothing can execute them -- the overlay whiteouts make them invisible to the running system.

## Production Boot

On every boot, `safebox-sealed-boot.service` checks for `/etc/safebox/sealed`:

- **Absent (audit image):** the service exits silently. SSH runs normally, no additional hardening is applied.
- **Present (production image):** the service applies three hardening measures:

**Step 1: SSH masking via overlay whiteouts.** The root filesystem is dm-verity (read-only). The system boots with `systemd.volatile=overlay`, which places a tmpfs on top of the read-only root for writes. The service stops any SSH units that may have started, masks `ssh.service`, `ssh.socket`, and `sshd.service` (creating symlinks to `/dev/null` in the overlay), and removes SSH binaries (`sshd`, `ssh`, `scp`, `sftp`, `ssh-keygen`, `ssh-add`, `ssh-agent`, `ssh-keyscan`), the `/etc/ssh` directory, and `/etc/pam.d/sshd` from the overlay. These `rm` operations create **whiteout entries** in the overlay's upper layer -- special directory entries that tell the kernel to return ENOENT for these paths, even though the files still exist on the dm-verity lower layer. The audit user's home directory is also removed from the overlay.

**Step 2: kernel.modules_disabled=1** -- prevents loading any new kernel module for the rest of this boot. The service runs After=multi-user.target, so every module Docker, ZFS, nftables, etc. need is already loaded.

**Step 3: hidepid=2 on /proc** -- each process can only see its own entries, preventing information leakage between UIDs.

Steps 2 and 3 cannot be undone without a reboot. Step 1 is effective because the overlay is tmpfs -- a reboot discards it, but the sealed flag on the verity root triggers this service again on every boot, re-masking SSH each time.

## Auditor Verification Flow

An auditor verifies that the production image is exactly the audit image plus the sealed flag:

1. **Boot Image A** (throwaway instance) -- SSH in as `safebox-audit`, run every check in `AUDIT.md`, inspect the seal script and boot service
2. **Extract Image A's root** -- mount the audit image's root volume on another instance (read-only). On AWS, mount the EBS snapshot; on GCP, attach the audit image's disk; on Azure/OCI, mount the managed image's OS disk.
3. **Run the seal script** on the extracted root:
   ```bash
   safebox-seal-image.sh --chroot /mnt/audit-root
   ```
4. **Build a verity disk** from the sealed chroot:
   ```bash
   SOURCE_DATE_EPOCH=0 build-verity-root.sh /mnt/audit-root /dev/target-disk <grub-hash>
   ```
5. **Compare root hashes** -- the `ROOTHASH` output must match Image B's root hash from the build manifest

If the hashes match, the production image is exactly what the auditor inspected plus one flag file. The auditor can also verify what the boot service does with that flag by reading `safebox-sealed-boot.service`, which is itself on the verity root and part of the audited image.

### Why the round-trip works

The dm-verity root filesystem is read-only -- the kernel verifies every block read against the hash tree and never writes to the device. This means booting Image A for an interactive audit does not change the root partition's content.

The seal script writes exactly one file: `/etc/safebox/sealed`. Because `mkfs.ext4 -d` populates the filesystem deterministically (sorted directory entries, sequential block allocation, all timestamps clamped to `SOURCE_DATE_EPOCH=0`), this file lands at the same block offset every time. The resulting directory tree fed to `mkfs.ext4 -d` produces the same blocks, `veritysetup format` produces the same hash tree, and the root hash matches.

### Reproduction requirements

The auditor must use:

- **Same e2fsprogs version** as the build (recorded in `verity.json` as `e2fsprogs_version`). Different versions of `mkfs.ext4 -d` may produce different block allocation layouts, htree structures, or metadata formats. Install the exact version or use a container image with the build tools pinned.
- **Linux x86_64 host.** The build uses `mkfs.ext4 -d` and standard POSIX tools, all of which run natively on x86_64 Linux.
- **Same `SOURCE_DATE_EPOCH`** (always 0 for Safebox builds).

The `verity.json` manifest records the build tools and parameters needed for reproduction. The auditor should verify their tool versions match before comparing hashes.

## Why These Measures Are Conditional

All production hardening measures would block legitimate audit work:

| Measure | Why auditors need it off |
|---------|-------------------------|
| SSH access | Auditors need to log in and inspect the running system |
| Root access (via sudo) | Reading `/etc/shadow`, checking TPM state, inspecting kernel parameters |
| Module loading | Auditors may need diagnostic modules (e.g., kprobes for tracing) |
| `/proc` visibility | Inspecting which processes run as which UIDs, checking for unexpected listeners |

Making them conditional on the sealed flag means the audit image is fully inspectable while the production image gets maximum hardening.

## Reproducibility

The verity root hash must be exactly reproducible by an auditor who extracts Image A's root filesystem, applies the seal script (writes the flag), and rebuilds the verity disk. This requires eliminating **every** source of nondeterminism in the ext4 root partition, because dm-verity hashes every block.

### Why `mkfs.ext4 -d` (the key design decision)

The original approach -- `mkfs.ext4` -> `mount` -> `rsync` -> `umount` -- creates files through the Linux kernel, which introduces three nondeterminism vectors that cannot be fixed after the fact:

1. **Inode generation numbers.** The kernel assigns a random `i_generation` to every new inode (used for NFS file handles). These values are stored in the on-disk inode and vary between runs.

2. **Directory htree layout.** ext4 directories use a hash tree (htree) for fast lookup. When files are created through the kernel, the htree splits depend on insertion order. The insertion order comes from `readdir()` on the source filesystem, which varies with its hash seed. So the same set of files produces different directory layouts depending on which filesystem the source chroot lives on.

3. **Block allocation order.** The kernel's delayed allocator assigns data blocks based on file creation order. Different `readdir()` order on the source -> different block allocation -> different partition content -> different verity hash.

`build-verity-root.sh` uses `mkfs.ext4 -d <staging-dir>` instead. This populates the filesystem using `libext2fs` directly (no kernel mount), which eliminates all three vectors: `scandir()`+`alphasort` for deterministic directory traversal, sequential block allocation in sorted filename order, and no random inode generations (all set to 0 by libext2fs). Additionally, when `SOURCE_DATE_EPOCH` is set, `mkfs.ext4 -d` clamps every file timestamp to that epoch, making the result independent of when the build ran.

### Full nondeterminism mitigation table

| Source | Vector | Mitigation |
|--------|--------|------------|
| ext4 UUID | Random per `mkfs` | Fixed via `uuid_for_label()` -- deterministic SHA-256 of partition label |
| ext4 htree hash seed | Random per `mkfs` | Fixed via `hash_seed_for_label()` |
| ext4 journal | Could replay on mount | Disabled (`-O ^has_journal`) |
| ext4 inode table | Lazy init leaves stale blocks | `lazy_itable_init=0` fully initialises during `mkfs` |
| Unused data blocks | Stale data from previous builds | Partition zeroed (`blkdiscard` or `dd if=/dev/zero`) before `mkfs` |
| Inode generation numbers | Kernel assigns random per inode | `mkfs.ext4 -d` uses libext2fs (no kernel); all generations 0 |
| Directory htree layout | Depends on file insertion order | `mkfs.ext4 -d` uses `scandir()`+`alphasort` -- sorted alphabetically |
| Block allocation order | Depends on file creation order | `mkfs.ext4 -d` allocates sequentially in sorted order |
| File timestamps | Build creates files at wall-clock time | `SOURCE_DATE_EPOCH` clamps all timestamps via e2fsprogs |
| Superblock timestamps | `e2fsck` and `tune2fs` write current time | Normalised to `SOURCE_DATE_EPOCH` via `debugfs` |
| Mount count (s_mnt_count) | Incremented on each mount | Reset to 0 via `debugfs` |
| GPT partition GUIDs | `sgdisk` assigns random | Fixed via deterministic SHA-256 of partition label |
| GPT disk GUID | `sgdisk` assigns random | Fixed via deterministic SHA-256 |
| FAT32 ESP volume serial | `mkfs.vfat` assigns random | Fixed via `-i` with deterministic value |
| `/etc/shadow` "last changed" | `passwd -l` writes current day | Normalised to day 0 by awk rewrite in cleanup-image.sh |
| Logs, history, caches | Vary per build | Deleted by cleanup-image.sh before capture |
| `machine-id` | Unique per system | Blanked (zero-length) |
| SSH host keys | Random per generation | Not generated until first boot (no baked-in host keys) |
| Backup files (shadow-, passwd-) | Carry pre-build state | Deleted by cleanup-image.sh |
| BOOT partition superblock | Timestamps from mount/grub-install | Normalised via debugfs (not covered by verity, but makes whole disk reproducible) |
| `find` command ordering | Locale-dependent sort for EFI binaries | `LC_ALL=C sort` piped after `find` |
| Sealed flag file | Written by seal script | Deterministic content, no timestamps (clamped by SOURCE_DATE_EPOCH) |

Note: the seal step itself introduces zero nondeterminism vectors because it writes exactly one file with fixed content. All nondeterminism mitigation is in the initial image build (`build-verity-root.sh` and `cleanup-image.sh`), not in the seal.

### What is NOT covered by the verity hash

The dm-verity root hash covers only partition 3 (SAFEBOX-ROOT). These partitions are outside the hash and their content may vary between builds without affecting verification:

- **P1 (SAFEBOX-ESP):** FAT32 EFI System Partition. Contains shim, GRUB, and stub grub.cfg. The volume serial, GPT GUID, and file order are now deterministic, but FAT32 timestamp precision (2-second granularity) and `grub-install` output on Debian may still vary.
- **P2 (SAFEBOX-BOOT):** ext4 boot partition with journal. Contains kernel, initramfs, grub.cfg, and sealed blobs directory. Superblock is normalised but the journal and grub-install artifacts may vary.
- **P4 (SAFEBOX-HASH):** dm-verity hash tree. Deterministic given identical P3 content.

For verification, the auditor compares only the verity root hash (covering P3). The ESP and boot partition content is verified by the boot chain itself (Secure Boot -> shim -> signed GRUB -> measured kernel).

## Files

| Path | Purpose |
|------|---------|
| `common/seal/safebox-seal-image.sh` | The seal script -- writes the sealed flag (source) |
| `common/seal/safebox-sealed-boot.service` | The boot-time hardening unit -- masks SSH, applies kernel hardening (source) |
| `common/image/build-verity-root.sh` | Builds the 4-partition GPT disk with dm-verity |
| `common/image/verify-image.sh` | Pre-capture assertions (`--audit` for Image A, default for Image B) |
| `common/image/cleanup-image.sh` | Host-side chroot cleanup before capture |
| `/opt/safebox/bin/safebox-seal-image.sh` | Seal script (installed on image) |
| `/etc/systemd/system/safebox-sealed-boot.service` | Boot-time hardening unit (installed) |
| `/etc/safebox/sealed` | Flag file written by the seal script |

The build manifest (written by each cloud's `build-image.sh`) uses schema version 3 with separate `production` and `audit` sub-objects, each containing the image identifier and root hash for that cloud.

## Re-Audit

A sealed production image cannot be audited interactively (SSH is masked at boot). To re-audit after a change:

1. Rebuild from the updated source tree -- `build-image.sh` produces both images
2. Run the full `AUDIT.md` checklist on the new audit image
3. Verify the production root hash matches the auditor-reproduced hash

The root hash is the single value that ties the audited image to the production image. If it matches, the only difference is the sealed flag, and the boot service's behaviour given that flag is itself part of what the auditor inspects.

## Nondeterminism Vectors Eliminated

This section enumerates every nondeterminism vector identified in the image build pipeline and how each is mitigated. It serves as both documentation and a checklist for future changes.

### Kernel-level vectors (eliminated by mkfs.ext4 -d)

These three vectors are inherent to creating files through the Linux kernel and cannot be fixed by post-processing. The switch from mount+rsync+umount to `mkfs.ext4 -d` (which uses libext2fs directly, bypassing the kernel) eliminates all three:

- **Random inode generation numbers (`i_generation`):** The kernel assigns a random 32-bit generation to every new inode. libext2fs sets all generations to 0.
- **Directory htree insertion-order dependence:** ext4's htree splits depend on the order entries are inserted. The kernel inserts in `readdir()` order, which depends on the source filesystem's hash seed. `mkfs.ext4 -d` uses `scandir()`+`alphasort`, producing identical htree layouts regardless of source.
- **Block allocation insertion-order dependence:** The kernel's delayed allocator assigns data blocks based on file creation order. `mkfs.ext4 -d` allocates sequentially in sorted filename order.

### Filesystem-level vectors

- **ext4 UUID and hash seed:** Fixed to deterministic values derived from SHA-256 of the partition label.
- **ext4 journal:** Disabled on the root partition (`-O ^has_journal`).
- **Lazy inode table initialisation:** Disabled (`lazy_itable_init=0`) so all inode table blocks are fully initialised by `mkfs`.
- **Stale data in unused blocks:** Partition zeroed before `mkfs` via `blkdiscard` or `dd if=/dev/zero`.
- **Superblock timestamps:** Normalised to `SOURCE_DATE_EPOCH` via `debugfs` after `e2fsck` and `tune2fs`.
- **Mount count:** Reset to 0 via `debugfs`.

### Partition table vectors

- **GPT partition GUIDs:** Fixed to deterministic values derived from SHA-256 of each partition label.
- **GPT disk GUID:** Fixed to a deterministic value.
- **FAT32 volume serial number:** Fixed via `mkfs.vfat -i` with a deterministic value.

### File content vectors (handled by cleanup-image.sh)

- **`/etc/shadow` "last changed" field:** `passwd -l` updates this to the current day. `cleanup-image.sh` normalises it to day 0 via awk rewrite.
- **Logs, caches, shell history, cloud state, SSH host keys, machine-id, backup files:** Deleted or blanked by `cleanup-image.sh` before capture.
- **File timestamps from build operations:** `SOURCE_DATE_EPOCH` causes `mkfs.ext4 -d` to clamp all file timestamps, so files created at different wall-clock times produce identical on-disk content.

### Seal-step vectors

None. The seal step writes exactly one file with fixed content. The timestamp of the new file is clamped by `SOURCE_DATE_EPOCH` during the subsequent `mkfs.ext4 -d` run, so even the flag file's metadata is deterministic.

### Build tool vectors

- **`find` command ordering:** EFI binary discovery pipes through `LC_ALL=C sort` to eliminate locale-dependent ordering.
- **`grub-install` (Debian family):** May produce slightly different output across grub package versions. This affects only the boot partition, which is outside the verity hash.
