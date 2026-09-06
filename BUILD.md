# Building a Safebox

Two paths. Both produce a sealed, SSH-removed, hardened image. The first works today; the second is the production target.

## Path 1 — Amazon Linux + dnf (works now, AWS only)

The current shipping path. Produces an AMI on AWS. Not reproducible (the image measurement can't be independently verified by rebuilding), but functional, tested, and deployable today.

**Prerequisites:** AWS CLI configured, an AWS account with the IAM policy in `aws/scripts/iam-policy-safebox-builder.json`, jq, and a running EC2 instance with an attached ZFS pool (`safebox-pool`) as the build target (or build from a clean Amazon Linux 2023 AMI).

**Build:**

```
# 1. Start from a clean Amazon Linux 2023 instance
# 2. Clone this repo
git clone https://github.com/Safebots/Infrastructure.git
cd Infrastructure

# 3. Install the base (packages, ZFS, Docker, nginx, PHP-FPM, Node, hardening)
sudo bash aws/scripts/components/base/install-base.sh

# 4. Install the system component (the Node.js host service)
sudo bash aws/scripts/components/system/install-system.sh

# 5. Seal (remove SSH, normalize nondeterminism, assert no forbidden agents)
sudo bash attestation/ami2-seal/seal-ami2.sh

# 6. Create the AMI from the sealed instance
aws ec2 create-image --instance-id <instance-id> --name "safebox-sealed-$(date +%Y%m%d)"
```

Full detail: [`aws/docs/QUICKSTART.md`](aws/docs/QUICKSTART.md). Build pipeline: [`aws/scripts/build-ami.sh`](aws/scripts/build-ami.sh).

**Limitations:** AWS only. Not reproducible (different builds of the same script produce different measurements, so independent verification of the attestation is not possible). The seal normalizes what it can, but the base isn't bit-identical across builds. This is the path for getting a Safebox running today; it is not the path for the reproducibility and multi-cloud claims.

## Path 2 — NixOS (production target, all six clouds)

The reproducible path. One pinned flake produces sealed images for AWS, GCP, Azure, Oracle (OCI), IBM, and Alibaba. Independent parties can rebuild from the same flake and get the same measurement — which is what makes the attestation story verifiable rather than trusted.

**Prerequisites:** A machine with Nix 2.18+ installed, flakes enabled, and network access to `cache.nixos.org` and `github.com`. (This cannot run in the CI container — it needs a real Nix evaluator with cache access.)

**Build:**

```
cd nixos

# 1. Pin nixpkgs to NixOS 26.05 (current stable)
#    Edit flake.nix: replace PIN_ME_TO_A_COMMIT_SHA with:
#      nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

# 2. Lock the flake (THIS is the reproducibility guarantee)
nix flake lock
git add flake.lock && git commit -m "pin nixpkgs 26.05"

# 3. Build the sealed image for your cloud
nix build .#ami          # AWS (sealed, no SSH)
nix build .#gce          # GCP
nix build .#azure        # Azure
nix build .#oci          # Oracle
nix build .#ibm          # IBM
nix build .#alibaba      # Alibaba

# Or build the builder (has SSH, for initial setup):
nix build .#ami-builder  # AWS builder (SSH-ingress, disposable)

# 4. Register the image on your cloud
#    AWS:     aws ec2 register-image ...
#    GCP:     gcloud compute images import ...
#    Azure:   upload VHD to Compute Gallery ...
#    OCI:     oci compute image import ...
#    (per-cloud details in Nix.md)

# 5. Launch with confidential compute enabled
#    AWS:     --cpu-options AmdSevSnp=enabled
#    GCP:     --confidential-compute-type=SEV_SNP
#    Azure:   --security-type ConfidentialVM
#    OCI:     Confidential Computing on E5/E6
#    (per-cloud flags in Nix.md and the README)
```

**Status:** the flake, all modules, and all host configs are written and parser-verified. The parity with the dnf base is proven (`nixos/PARITY.md`). What's gated is the first real build — step 1–2 above (~30 min on a Nix machine). See [`nixos/TURN1-RUNBOOK.md`](nixos/TURN1-RUNBOOK.md) for the copy-pasteable steps with every blocker pre-triaged, and [`Nix-turns.md`](Nix-turns.md) for the full 4-turn plan.

**What the NixOS path gives you that the dnf path doesn't:** reproducible measurements (independent verification), all six clouds from one config, the two-AMI construction (builder → seal → attested image) with deterministic sealing, and the multi-cloud attestation story. This is the production target.

## The two-AMI construction (both paths)

Both paths produce a sealed image the same way:

1. **AMI-1, the builder** — has SSH so you can configure it. Disposable.
2. **The seal** (`attestation/ami2-seal/seal-ami2.sh`) — removes SSH, host keys, all cloud agents (SSM, WALinuxAgent, google-guest-agent, EC2 Instance Connect, OS Login, Azure Arc, OCI agent, Alibaba assistant), serial consoles (ttyS0-3, hvc0, ttyAMA0), emergency/rescue shells, logs, caches, machine-id, and normalizes all timestamps to a fixed epoch. Asserts nothing forbidden survived.
3. **AMI-2, the attested image** — the snapshot of the sealed builder. This is what the TPM measures. No SSH, no console, no shell, no package manager, no way in.

The attested measurement is of the **actual snapshotted AMI-2**, not a theoretical reproducible build. The reproducible NixOS build is for comparison and verification — an independent party rebuilds, seals, and compares. The thing that's attested and running is the actual snapshot.

## The sandbox variant (optional)

For testing untrusted code, a separate build target wraps the sealed Safebox in one more layer (inner NixOS microVM + MITM interceptor). See [`sandbox/BUILD.md`](sandbox/BUILD.md).

```
nix build .#sandbox-outer    # outer host (base + interceptor wrapper)
nix build .#sandbox-inner    # inner microVM (single NIC, CA in trust store)
```

## After building

- **Run the test suite:** `bash tests/run-all.sh` (42 suites, all in-repo)
- **Install models:** use [`cli/safebox-models/`](cli/safebox-models/) to install model weights via the system component's `/models/install` API
- **Per-cloud attestation:** [`attestation/TURN3-ATTESTATION-RUNBOOK.md`](attestation/TURN3-ATTESTATION-RUNBOOK.md)
- **Full reference:** [`Nix.md`](Nix.md), the [README](README.md)
