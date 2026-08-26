# modules/zfs.nix
#
# Declarative port of the ZFS portion of install-base.sh — the F2 fix.
#
# The datasets are Tier-2 (data): they are NOT part of the measured image.
# They persist across reboots and across base-image updates (that's the whole
# point — data survives, per trust.html). So they are provisioned at first
# boot by a oneshot service, not baked into the closure.
#
# F2 invariants preserved EXACTLY:
#   - explicit mountpoints (safebox->/safebox, mariadb->/safebox/mariadb nested,
#     tenants->/safebox/tenants, docker->/var/lib/docker) — the load-bearing
#     fix that stops data landing unencrypted on the root volume.
#   - encryption=aes-256-gcm, keyformat=raw, keylocation=file://<keyfile>.
#   - MariaDB dataset tuning: recordsize=16k, primarycache=metadata,
#     compression=zstd (better ratio on repeating column data than pool lz4),
#     logbias=throughput, compression.
#   - post-create verification that every mountpoint landed correctly and that
#     /safebox is genuinely a zfs mount — fail otherwise.
#
# PHASE-3 CHANGE FROM F2: the key at /run/safebox/zfs-key is no longer a static
# file placed by a pre-step. It will be unsealed by the TPM under the M-of-N
# measurement POLICY (refactor.md 3.3) so it releases only under an approved
# measurement, and survives approved updates. Until Phase 3 lands, this module
# expects the keyfile to exist (parity with v1) and leaves a clear TODO.
{ config, pkgs, lib, ... }:

let
  cfg = config.safebox.zfs;
  pool = "safebox-pool";
  keyfile = "/run/safebox/zfs-key";

  # dataset -> mountpoint map (install-base.sh dataset_mountpoint()).
  datasets = {
    safebox = "/safebox";
    docker  = "/var/lib/docker";
    mariadb = "/safebox/mariadb";
    tenants = "/safebox/tenants";
    models  = "/safebox/models";   # model weights (category-2 DATA): encrypted store for the
    # system component's SHA-256-governed /models/install. Runners mount read-only.
  };

  mkCreate = name: mp: ''
    if ! zfs list ${pool}/${name} >/dev/null 2>&1; then
      zfs create \
        -o compression=lz4 \
        -o atime=off \
        -o encryption=aes-256-gcm \
        -o keyformat=raw \
        -o keylocation=file://${keyfile} \
        -o mountpoint=${mp} \
        ${pool}/${name}
    else
      current_mp="$(zfs get -H -o value mountpoint ${pool}/${name})"
      if [ "$current_mp" != "${mp}" ]; then
        echo "Correcting ${pool}/${name} mountpoint $current_mp -> ${mp}"
        zfs set mountpoint=${mp} ${pool}/${name}
      fi
    fi
  '';

  mkVerify = name: mp: ''
    got="$(zfs get -H -o value mountpoint ${pool}/${name})"
    if [ "$got" != "${mp}" ]; then
      echo "ERROR: ${pool}/${name} mountpoint is '$got', expected '${mp}'." >&2
      echo "       Data written to ${mp} would land on the unencrypted root volume." >&2
      exit 1
    fi
  '';
in
{
  options.safebox.zfs.dataDevice = lib.mkOption {
    type = lib.types.str;
    default = "/dev/sdf";
    description = ''
      Block device for the safebox-pool ZFS pool — the HOT / transactional tier
      (MariaDB InnoDB, live app state). This is where cloud-agnosticism for the
      hot tier lives: every cloud offers block storage (AWS EBS, GCP Persistent
      Disk, Azure Managed Disk, OCI Block Volume); only the device name differs.
      AWS attaches /dev/sdf by default; GCP/Azure/OCI present the attached data
      disk under their own name — set this per host. The pool is created here
      ONLY if the device is empty (never destructive).

      DELIBERATELY block-device, NOT an object store mounted via goofys/s3fs.
      ZFS (and InnoDB on it) need real block semantics — true fsync durability,
      partial writes, transaction groups. A FUSE object-store mount gives
      eventual consistency and whole-object writes; running a transactional FS
      on it appears to work and then corrupts under load. Object storage is the
      COLD/large tier below, not the substrate ZFS sits on.
    '';
  };

  options.safebox.storage.objectBackend = lib.mkOption {
    type = lib.types.nullOr (lib.types.submodule {
      options = {
        kind = lib.mkOption {
          type = lib.types.enum [ "s3" "gcs" "azure-blob" "oci-object" "s3-compatible" ];
          description = "Which object store backs the COLD/large tier (weights, backups). Any S3-compatible endpoint works via 's3-compatible'.";
        };
        bucket = lib.mkOption { type = lib.types.str; description = "Bucket / container name."; };
        endpoint = lib.mkOption {
          type = lib.types.nullOr lib.types.str; default = null;
          description = "Override endpoint URL (required for s3-compatible / non-AWS; leave null for the provider default).";
        };
        prefix = lib.mkOption { type = lib.types.str; default = "safebox"; description = "Key prefix within the bucket."; };
      };
    });
    default = null;
    description = ''
      OFF BY DEFAULT, and an EGRESS TRADEOFF — not a neutral storage tier.
      Optional object-storage backend for the COLD / large / immutable tier
      (ZFS-snapshot backups, archives). Turning it on opens a sanctioned
      high-bandwidth OUTBOUND path to a blob store, which relaxes the box's
      empty-egress posture — the same posture that contains generated code. So
      enabling it is governed, not an operator toggle:

      PER-MAPPING M-OF-N: each concrete destination (kind + bucket + endpoint +
      prefix) must be blessed by M-of-N auditors before the backend will touch
      it. object-backend.sh verifies the mapping fail-closed against the blessed
      set shipped in the measured base (attestation/storage-mappings/). A bucket
      the auditors never signed can never be written to, whatever config says —
      this is what keeps the relaxed egress from becoming a careless exfil path.

      SOVEREIGNTY: bytes are client-side encrypted BEFORE upload, so the store —
      whichever cloud — only ever holds ciphertext. NOT provider SSE (that hands
      the key to the operator). The hot tier's ZFS key stays TPM-sealed and
      unaffected.

      NOTE: weights do NOT use this — they are pulled INBOUND from pinned,
      content-addressed sources (HF origin -> IPFS/CID mirror), a fetch with no
      outbound bucket. And the PREFERRED backup path is ZFS send/recv to a
      controlled peer (the Safecloud failover role, post-1.0); cloud-bucket
      backup is the explicitly-less-sovereign fallback. See storage/README.md.
    '';
  };

  config = {
  # ZFS support in the image (zfs-2.2.6 equivalent, kernel-matched by NixOS).
  boot.supportedFilesystems = [ "zfs" ];
  boot.zfs.forceImportRoot = false;
  networking.hostId = lib.mkDefault "00000000";  # set per-host in hosts/

  # Ship the boot-time unseal script INSIDE the measured base (Phase 3.3), so
  # the unseal logic is itself measured — it can't be swapped for a version
  # that skips the M-of-N policy check without changing M0.
  environment.etc."safebox/unseal-zfs-key.sh".source =
    ./scripts/unseal-zfs-key.sh;

  # First-boot dataset provisioning — the F2 create+verify logic.
  systemd.services.safebox-zfs-datasets = {
    description = "Provision Safebox encrypted ZFS datasets (F2 fix)";
    wantedBy = [ "multi-user.target" ];
    after = [ "zfs-import.target" ];
    before = [ "docker.service" "mysql.service" ];
    serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
    path = [ pkgs.zfs pkgs.coreutils pkgs.util-linux ];
    script = ''
      set -euo pipefail

      # Pool creation (first boot). Terraform attaches a raw data volume (see
      # each terraform/modules/*/main.tf: /dev/sdf on AWS, safebox-data device
      # elsewhere). If the pool doesn't exist yet, create it on that device —
      # but ONLY if the device is genuinely empty, so we NEVER destroy data.
      if ! zpool list ${pool} >/dev/null 2>&1; then
        DATA_DEV="${cfg.dataDevice}"
        if [ ! -b "$DATA_DEV" ]; then
          echo "ERROR: ZFS pool '${pool}' absent and data device $DATA_DEV not found." >&2
          echo "       Attach the data volume (terraform) before first boot." >&2
          exit 1
        fi
        # Refuse if the device already has a filesystem/partition signature —
        # creating a pool would destroy it. Fail-safe, not fail-destructive.
        if blkid "$DATA_DEV" >/dev/null 2>&1; then
          echo "ERROR: $DATA_DEV already has data (blkid found a signature)." >&2
          echo "       Refusing to create pool '${pool}' over existing data." >&2
          exit 1
        fi
        echo "Creating ZFS pool '${pool}' on empty device $DATA_DEV (first boot)."
        zpool create -f -o ashift=12 -O canmount=off -O mountpoint=none ${pool} "$DATA_DEV"
      fi

      # Fail-fast if the pool still isn't present (F2 Bug-2).
      if ! zpool list ${pool} >/dev/null 2>&1; then
        echo "ERROR: ZFS pool '${pool}' not available after create attempt." >&2
        exit 1
      fi

      # Phase 3.3: unseal the ZFS key from the TPM under the M-of-N POLICY.
      # The sealed blob (produced by attestation/seal/seal-key-to-policy.sh) is
      # bound to the auditors' authorizing key, NOT to a fixed PCR value — so it
      # unseals under ANY M-of-N-approved measurement (survives approved updates)
      # and refuses under an unapproved one (tamper). See trust.html.
      SEALED_BLOB=/etc/safebox/zfs-key.sealed        # part of the measured base
      BLESSING=/run/safebox/current-blessing.json    # the box's current M-of-N blessing
      if [ -f "$SEALED_BLOB" ] && [ -c /dev/tpmrm0 -o -c /dev/tpm0 ]; then
        mkdir -p "$(dirname ${keyfile})"
        if ! ${pkgs.bash}/bin/bash /etc/safebox/unseal-zfs-key.sh \
               "$SEALED_BLOB" "$BLESSING" ${keyfile}; then
          echo "FATAL: ZFS key did not unseal under the current measurement." >&2
          echo "       This box is not running an M-of-N-approved state, or the" >&2
          echo "       TPM refused the policy. Refusing to mount encrypted data." >&2
          exit 1
        fi
        chmod 0400 ${keyfile}
      elif [ -f ${keyfile} ]; then
        # v1-parity fallback ONLY where no TPM is present (e.g. pre-Phase-3
        # bring-up). Loud, so it can't silently become the production path.
        echo "WARNING: using plain keyfile ${keyfile} (no TPM unseal)." >&2
        echo "         Production MUST seal the key to the measurement policy." >&2
        chmod 0400 ${keyfile}
      else
        echo "ERROR: no sealed key blob and no keyfile. Cannot obtain the ZFS" >&2
        echo "       encryption key. On a confidential instance, seal the key" >&2
        echo "       first (attestation/seal/seal-key-to-policy.sh)." >&2
        exit 1
      fi

      # Create datasets with explicit mountpoints + encryption (F2).
      ${lib.concatStringsSep "\n" (lib.mapAttrsToList mkCreate datasets)}

      # MariaDB InnoDB<->ZFS tuning (install-base.sh zfs set block).
      if zfs list ${pool}/mariadb >/dev/null 2>&1; then
        zfs set recordsize=16k        ${pool}/mariadb
        zfs set primarycache=metadata ${pool}/mariadb
        zfs set logbias=throughput    ${pool}/mariadb
        # zstd (not the pool-default lz4) for the DB: much better ratio on the
        # repeating low-entropy column data (publisherId, streamName per row).
        # ZFS is the SINGLE compression+encryption layer — InnoDB compression and
        # InnoDB at-rest encryption stay OFF, so ZFS sees plaintext it can
        # compress, then encrypts. recordsize stays 16k to match InnoDB pages
        # (avoids read/write amplification on point queries).
        zfs set compression=zstd      ${pool}/mariadb
      fi

      # Quotas (install-base.sh).
      zfs set quota=20G  ${pool}/safebox || true
      zfs set quota=100G ${pool}/docker  || true

      # Verify every mountpoint landed correctly (F2 post-create verification).
      ${lib.concatStringsSep "\n" (lib.mapAttrsToList mkVerify datasets)}

      # Confirm /safebox is genuinely a zfs mount, else the encryption story
      # is void (install-base.sh stat -f check).
      fstype="$(stat -f -c %T /safebox 2>/dev/null || echo unknown)"
      if [ "$fstype" != "zfs" ]; then
        echo "ERROR: /safebox is not a ZFS mount (stat reports '$fstype')." >&2
        exit 1
      fi

      echo "Safebox ZFS datasets provisioned and verified (F2)."
    '';
  };
  };
}
