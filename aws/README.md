# AWS Infrastructure Specification

This directory contains AWS-specific infrastructure specifications for Safebots.

## Quick Start

```bash
# Build infrastructure image
cd aws
sudo ./scripts/build-ami.sh base,media,llm-medium

# Verify build
./scripts/verify-build.sh

# Deploy
aws ec2 run-instances \
  --image-id ami-xxxxx \
  --instance-type r6i.8xlarge \
  --key-name your-key \
  --metadata-options "HttpTokens=required,InstanceMetadataTags=enabled"

# Verify attestation
./scripts/verify-attestation.sh <instance-id>
```

## Directory Structure

```
aws/
├── scripts/           # Build and verification scripts
│   ├── build-ami.sh             # Master build script
│   ├── verify-build.sh          # Verify build reproducibility
│   ├── verify-attestation.sh    # Verify TPM attestation
│   └── components/              # Component installers
│
├── docs/              # AWS-specific documentation
│   ├── SAFEBOX-COMPLETE-SUMMARY.md
│   ├── SAFEBOX-ZFS-DOCKER-MARIADB-ARCHITECTURE.md
│   └── ... (25 technical documents)
│
└── manifests/         # Component manifests
    └── safebox-packages.json
```

## Components

See [../README.md](../README.md#composable-components) for the complete list of 18 components.

## AWS-Specific Features

### Nitro System Integration
- Hardware root of trust
- Memory encryption in hardware
- Attestation via AWS APIs

### vTPM 2.0 Support
- Measured boot
- PCR (Platform Configuration Register) values
- Remote attestation

### Instance Types

| Configuration | Instance Type | vCPU | RAM | Storage | Monthly Cost* |
|---------------|---------------|------|-----|---------|---------------|
| Tiny | t3.large | 2 | 8 GB | 30 GB | ~$60 |
| Small | c6i.2xlarge | 8 | 16 GB | 50 GB | ~$250 |
| Medium | r6i.8xlarge | 32 | 256 GB | 150 GB | ~$1,900 |
| Large | x2idn.16xlarge | 64 | 1 TB | 250 GB | ~$8,000 |
| XL (GPU) | p5.48xlarge | 192 | 2 TB | 1 TB | ~$98,000 |

*Approximate on-demand pricing in us-east-1

## Documentation

Complete documentation is in the [docs/](docs/) directory. Key documents:

- [SAFEBOX-COMPLETE-SUMMARY.md](docs/SAFEBOX-COMPLETE-SUMMARY.md) - Complete architecture
- [SAFEBOX-ZFS-DOCKER-MARIADB-ARCHITECTURE.md](docs/SAFEBOX-ZFS-DOCKER-MARIADB-ARCHITECTURE.md) - Storage architecture
- [DETERMINISTIC-AI-ONLY-RNG.md](docs/DETERMINISTIC-AI-ONLY-RNG.md) - Deterministic inference

## Support

- 📖 Main Documentation: [../README.md](../README.md)
- 💬 Discussions: [GitHub Discussions](https://github.com/Safebots/Infrastructure/discussions)
- 🐛 Issues: [GitHub Issues](https://github.com/Safebots/Infrastructure/issues)
