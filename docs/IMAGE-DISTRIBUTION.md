# Image Distribution

## Source of Truth: One Build, Many Channels

The Safebox infrastructure base is a single filesystem image. Whether built by `dnf` (current production path via `install-base.sh`) or by Nix (target path via `flake.nix`), the output is a raw filesystem whose SHA-256 hash is the image's identity. Every distribution channel serves the same bytes. The governance claim that blesses a particular image hash applies regardless of how the image reaches the target machine.

```
Source of truth (Nix derivation OR dnf build)
  -> nix build / packer build -> raw .img file (hashable, inspectable)
    -> aws ec2 import-image -> AMI (convenient for AWS)
    -> gcloud compute images import -> GCP image
    -> az image create -> Azure image
    -> Safecloud chunking -> distributed across Drops (decentralized, no egress cost)
```

All four channels serve the same bits. The image's SHA-256 matches the blessed governance claim. A safebox booted from an AMI in us-east-1 and a safebox booted from a Safecloud download on bare metal run identical code and produce identical PCR0 values (assuming the same build).

## The Three-AMI Pipeline (AWS)

The current production path for AWS uses a three-stage AMI pipeline, managed by Packer and the scripts in `aws/scripts/`:

### AMI 1: Package Cache

The first AMI installs all system packages via `dnf` (or downloads Nix store paths). This AMI exists solely to avoid re-downloading packages on every build. It has SSH enabled, a root password, and is not hardened. It is never run in production.

Purpose: speed up subsequent builds by caching the package layer.

### AMI 2: Complete, SSH On

The second AMI takes AMI 1 as its base and runs `install-base.sh`, which:

- Installs the Node.js system component to `/opt/safebox/system/`
- Configures ZFS pools and datasets
- Sets up Docker and container networking
- Writes systemd units for the system component
- Copies the genesis governance keys to `/var/lib/safebox/governance/governance-keys.json`
- Configures firewall rules (iptables/nftables)

SSH is still enabled at this stage so the build system can verify the image, run smoke tests (`test/smoke.js`), and inspect the filesystem. This AMI is a development/testing artifact.

### AMI 3: Immutable, Measured

The third AMI takes AMI 2 and removes SSH:

- `install-base.sh` removes the SSH server package entirely (`dnf remove openssh-server`)
- Removes SSH host keys, authorized_keys, and sshd config
- Removes any lingering user password hashes
- Removes the Packer build user
- Removes package manager caches

After this stage, the only way into the machine is through the system component's Unix domain sockets (which require HMAC authentication) or through the AWS console's serial port (which requires AWS IAM credentials and leaves an audit trail in CloudTrail).

This AMI is the production image. Its filesystem hash is what gets measured as PCR0 by the Nitro hypervisor. The governance claim blesses this hash.

### Why Three Stages

A single-stage build would work but would be slow (re-download all packages on every build) and hard to debug (no SSH for inspection). The three-stage pipeline separates concerns: caching (AMI 1), installation (AMI 2), and hardening (AMI 3). Only AMI 3 is production; AMIs 1 and 2 are build artifacts.

## Raw Filesystem Images

Publishing the exact filesystem as `.img` or `.tar.xz` enables cross-cloud deployment and full inspectability.

### Properties

- **Full inspectability.** Anyone can download the image, mount it read-only, and audit every byte. The image is the code. There is no "trust the cloud provider's import process" -- you can verify the filesystem contents match the source tree.
- **Cross-cloud.** The same image works on AWS (via `aws ec2 import-image`), GCP (via `gcloud compute images import`), Azure (via `az image create`), OCI, and bare metal. The cloud-specific import is a thin wrapper around "write these bytes to a virtual disk."
- **Hash verifiability.** `sha256sum safebox-base-v1.2.3.img` produces the same hash that governance blessed. No opaque AMI ID -- the hash IS the identity.

### Cost

S3 storage runs approximately $0.023/GB/month. S3 egress runs approximately $0.09/GB. A 110 GB base image costs roughly $2.50/month to store and roughly $10 per download. For a small number of deployments (tens of safeboxes), this is modest. For large-scale distribution (hundreds or thousands of downloads), the egress cost adds up -- this is where Safecloud distribution becomes economically attractive.

### Publishing

The CI pipeline publishes raw images alongside AMIs:

1. `nix build` (or `packer build`) produces the raw `.img` file
2. `sha256sum` computes the image hash
3. The image is uploaded to S3 and/or GitHub Releases
4. Governance signs an OCP claim over the image hash
5. The claim is published to `safebox.org`

A deployer on any cloud can:

1. Download the raw image from S3 or GitHub
2. Verify `sha256sum` matches the governance claim
3. Import into their cloud provider
4. Boot and verify PCR0 matches the blessed hash

## Safecloud Image Distribution

The base image is open source -- no encryption is needed for the image itself. Safecloud distributes the image the same way it distributes any content: chunking, Merkle tree construction, and parallel download from distributed storage nodes (Drops).

### Chunking

The raw image is split into fixed-size chunks of 1 MiB (1,048,576 bytes). The last chunk may be smaller. Each chunk is identified by its content hash:

```
CID = SHA-256(chunk_bytes)
```

The CID (content identifier) is the chunk's address on the Safecloud network. A Drop that holds a chunk can prove it holds the correct bytes -- the downloader verifies `SHA-256(received_bytes) == expected_CID`.

### N-ary Merkle Tree

The chunks are arranged into an N-ary Merkle tree with a fan-out of 16. This means each internal node has up to 16 children. For a 110 GB image:

- **Leaf nodes:** ~105,000 chunks (110 GB / 1 MiB)
- **Level 1:** ~6,563 internal nodes (105,000 / 16)
- **Level 2:** ~411 internal nodes
- **Level 3:** ~26 internal nodes
- **Level 4:** ~2 internal nodes
- **Root:** 1 node

Each internal node's CID is `SHA-256(child_CID_0 || child_CID_1 || ... || child_CID_15)`. The root CID is the identity of the entire image.

### The Self-Verifying Property

The Merkle root of the image equals the image's content hash. The governance claim blesses this hash. The Nitro hypervisor measures the booted filesystem and records it as PCR0. Therefore:

```
Merkle root = blessed image hash = PCR0
```

This is self-verifying. A safebox that boots from a Safecloud-downloaded image and produces the expected PCR0 has proven -- via hardware measurement -- that every byte of the image is correct. No separate "did I download the right thing?" check is needed. The attestation IS the verification.

### Parallel Download from Drops

Drops are Safecloud's distributed storage nodes. They earn Safebux for serving content. A downloading safebox (or any node) can request chunks from multiple Drops in parallel:

1. The downloader obtains the Merkle tree structure (the set of CIDs at each level) from any source -- a Jet, a seed node, or a published manifest.
2. The downloader requests leaf chunks from multiple Drops simultaneously. This is BitTorrent-style multiplexing: different chunks from different sources, in parallel.
3. Each received chunk is verified against its CID before being written to disk.
4. As chunks arrive, the downloader can verify internal Merkle nodes bottom-up.
5. When all chunks are received and verified, the root CID is compared against the blessed hash.

Jets coordinate the download: they know which Drops hold which chunks and can optimize for latency and bandwidth. A popular image (the standard Safebox base) will be replicated across many Drops, ensuring high availability and fast parallel downloads.

### Advantages over S3

| Property | S3 / CDN | Safecloud |
|---|---|---|
| Egress cost | ~$0.09/GB (~$10 per 110 GB download) | Safebux to Drops (amortized across network) |
| Parallelism | Single TCP connection per request | Multiple Drops in parallel |
| Availability | S3 SLA (99.99%) | Redundancy across many Drops |
| Verification | Separate SHA-256 check after download | Per-chunk verification during download |
| Single point of failure | AWS region outage blocks downloads | No single point; chunks on many Drops |
| Censorship | AWS can block access | Distributed; no single chokepoint |

At scale (hundreds or thousands of safebox deployments), the Safecloud path is significantly cheaper. The network bears the distribution cost via Safebux rather than the publisher paying S3 egress fees.

## Bootstrap Concern

A brand-new safebox faces a chicken-and-egg problem: it needs to download the image to boot, but it cannot use Safecloud until it is running. The bootstrap path is:

1. **First boot:** Use an AMI (AWS) or raw image downloaded from S3/CDN. This is the traditional path. The safebox boots, attests, and joins the network.
2. **Subsequent updates:** Once a safebox is running, it can download successor images from Safecloud. The succession ceremony (Phase 3) already requires booting a new instance with a new image -- that new instance can pull its image from Drops instead of S3.
3. **Seeding:** A running safebox can seed its own image to Drops, making it available for future downloads. The more safeboxes running, the more Drops hold the image, the faster and more reliable downloads become.

The AMI/S3 path is always available as a fallback. Safecloud distribution is an optimization, not a requirement.

## Nix Build: Deterministic Hash = Predicted PCR0

In a Nix world, the build process is deterministic. Given the same `flake.lock` (pinned dependency set), `nix build` produces bit-identical output. This means:

- The Nix output hash (the store path hash) predicts the PCR0 value before the image is booted.
- Governance signers can approve a Nix flake revision. The flake revision determines the output hash. The output hash determines PCR0. No need to build the image, boot it, measure it, and then approve -- the approval can happen at the source level.
- Every base update IS a succession (Phase 3): `nix build` produces a new image, governance blesses the hash, the current instance pre-authorizes that hash as its successor's measurement, a new instance boots and takes over via Path A.

### Nix vs dnf: What Changes

| Aspect | dnf (current) | Nix (target) |
|---|---|---|
| Build reproducibility | Best-effort (pinned versions in `install-base.sh`) | Deterministic (same inputs = same output) |
| PCR0 prediction | Empirical (build, boot, measure) | Computed (from Nix store hash) |
| SSH removal | Installed then removed in AMI 3 | Never in the closure (never installed) |
| Three-AMI pipeline | Required (cache, install, harden) | Single `nix build` (no stages needed) |
| Governance approval | Bless the AMI hash after inspection | Bless the flake revision before build |

### What Stays the Same

The Node.js code (`server.js`, `auth.js`, `secret.js`, etc.) is unchanged between dnf and Nix builds. The config files (`managed-containers.json`, `governance-keys.json`) are unchanged. The attestation pipeline is unchanged -- Nix just makes the measurement predictable rather than empirical. The succession ceremony is unchanged -- it works the same whether the image was built by Nix or Packer.

Both build systems coexist in the repo. The cutover happens when the Nix build produces an image that passes the same attestation and test suite. No flag day.

## CI Pipeline

Image distribution is a build pipeline and CI concern, not base code. The base does not contain image distribution logic -- it contains the volume loader (Phase 1) which can download content from Safecloud sources, but the image itself is distributed externally.

The CI pipeline:

1. Builds the image (`nix build` or `packer build`)
2. Computes SHA-256 of the raw image
3. Publishes to S3 and/or GitHub Releases with the hash
4. Imports to AMI, publishes AMI ID + region mapping
5. Chunks into Safecloud via a Jet (or a standalone uploader tool)
6. Governance signs an OCP claim over the image hash
7. `safebox.org` publishes the claim and the Merkle tree manifest

The governance claim format for image blessing:

```json
{
  "ocp": 1,
  "stm": {
    "type": "imageBlessing",
    "imageHash": "sha256:a1b2c3d4...",
    "version": "1.2.3",
    "buildSystem": "nix",
    "flakeRevision": "abc123...",
    "merkleRoot": "sha256:a1b2c3d4..."
  }
}
```

The `imageHash` and `merkleRoot` are the same value (both are the SHA-256 of the complete image content, just computed differently -- linear hash vs Merkle tree). The `flakeRevision` (Nix) or equivalent (dnf) provides provenance back to the source.
