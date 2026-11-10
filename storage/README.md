# Storage tiers: hot on block, cold on objects, Safecloud later

Safebox storage is deliberately split into tiers, because "where does the box
put data" has two different answers with two different correct technologies.

## Tier 1 - HOT / transactional (ZFS on a block device)

MariaDB InnoDB, live app state, anything needing real filesystem semantics.
Lives on the encrypted `safebox-pool` ZFS pool, on a **block device**
(`safebox.zfs.dataDevice`). Cloud-agnostic already: every cloud offers block
storage (AWS EBS, GCP Persistent Disk, Azure Managed Disk, OCI Block Volume) and
only the device name differs. Encryption is ZFS-native AES-256-GCM, key
TPM-sealed to the auditor policy.

**Why not object storage here?** ZFS and InnoDB need true block semantics -
`fsync` durability, partial writes, transaction groups. A goofys/s3fs FUSE mount
gives eventual consistency and whole-object writes; a transactional filesystem on
top of it appears to work and then corrupts under load. This is a general
anti-pattern, not a Safebox quirk. So the hot tier stays on block, and its
cloud-agnosticism comes from the block-device abstraction, not from object
storage.

## Tier 2 - COLD / large / immutable (object storage: OFF by default, egress tradeoff)

ZFS-snapshot backups, archives. Write-once/read-many, no transactional semantics -
the right fit for object storage, and the seam that makes this data cloud-agnostic:
`safebox.storage.objectBackend.kind` picks `s3` / `gcs` / `azure-blob` /
`oci-object` / `s3-compatible`. Implemented in `object-backend.sh` (rclone).

**This is a security tradeoff, not a neutral tier — and it is OFF by default.**
Turning it on opens a sanctioned high-bandwidth OUTBOUND path to a blob store,
which relaxes the empty-egress posture that contains generated code. Three things
keep that from becoming a careless exfil vector:

1. **Per-mapping M-of-N approval.** Each concrete destination
   (`kind + bucket + endpoint + prefix`) must be blessed by M-of-N auditors before
   the backend will touch it. `object-backend.sh` verifies the mapping fail-closed
   (via `attestation/storage-mappings/verify-mapping.py`) against the blessed set
   shipped in the measured base. A bucket the auditors never signed can never be
   written to, whatever config says. This is the same M-of-N machinery that
   blesses a measurement (`attestation/bless/`), applied per storage mapping.
2. **Client-side encrypted before upload.** rclone `crypt` with the box's own key
   (TPM-sealed material); the store only ever holds ciphertext. **Not** provider
   SSE - that would put the key in the operator's hands.
3. **Never under ZFS.** Object put/get only; backups are ZFS *send streams* stored
   as objects (`backup-zfs`), never a filesystem on the object store.

**Weights do NOT use this tier.** They are pulled INBOUND from pinned,
content-addressed sources (HF origin -> IPFS/CID mirror), a fetch with no outbound
bucket and no egress relaxation; the manifest CID/SHA-256 verifies them.

**Preferred backup path is a controlled peer, not a cloud bucket.** ZFS send/recv
to a box you control (the Safecloud failover role, Tier 3) keeps backups on
infrastructure you own. Cloud-bucket backup is the explicitly-less-sovereign
fallback for when you don't have a peer — which is exactly why it's gated.

Left unset (`objectBackend = null`, the default), none of this is active: no
outbound blob path exists, and the cold tier is local disk plus inbound weight
fetch. The stronger sovereignty story is ZFS-only; this option exists for those
who accept the tradeoff and get it auditor-approved per destination.

## Tier 3 - Safecloud (post-1.0, a DIFFERENT layer)

Safecloud is a decentralised, encrypted, self-pricing storage/streaming
**network** (a Qbix plugin; browser Cloud + Node Jets + browser-tab Drops;
convergent AES-256-GCM, content-addressed chunks, on-chain payment). It answers
"how do boxes distribute encrypted content and back each other up across the
network," not "where does one box put a database file."

It is **not** the box's at-rest store, for three reasons: it distributes chunks
across a network (including browser tabs) rather than providing a local disk;
its client is the browser and its enforcement (OCP authorization/payment,
proof-of-storage) is still TODO in its own repo; and the box's hot tier needs
low-latency local transactional storage. Making Safecloud the primary data store
would fight both systems.

Where it fits, and where the Infrastructure README already scopes it (post-1.0):
(a) **cross-box failover / redundancy** - the P2P overlay that rolls a hostname
to a peer holding a fresh snapshot; and (b) **encrypted weight distribution** -
its convergent-encryption + CID model is exactly right for "same weights,
deduplicated, encrypted, cloud-agnostic, verifiable," which is why the model
manifests already list a `safecloud` mirror + IPFS CID ahead of the HF origin.
Adopt it there once its auth/payment enforcement lands - not as the at-rest store.
