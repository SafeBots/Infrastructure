# Safebox Composable AMI Architecture

**Production-Ready AWS AMI for Multi-Tenant AI Workloads**

[![License](https://img.shields.io/badge/license-Apache%202.0%20%2F%20MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](CHANGELOG.md)
[![Status](https://img.shields.io/badge/status-production--ready-brightgreen.svg)](docs/SAFEBOX-COMPLETE-SUMMARY.md)

---

## 🚀 What is Safebox?

Safebox is a **composable AWS AMI** that provides secure, multi-tenant infrastructure for AI/ML workloads. Mix and match 18 components to build custom AMIs optimized for your use case.

**Key Features:**
- 🧩 **Composable:** 18 mix-and-match components (base + 17 optional)
- 🤖 **70+ AI Models:** Tiny to XL (1.5B to 744B parameters)
- 🔒 **Triple Encryption:** Nitro RAM + vTPM + ZFS AES-256-GCM
- 🎯 **Deterministic:** Reproducible inference without breaking crypto
- 📄 **Complete Pipelines:** PDF/video → vector search
- ✅ **GPL-Free:** 100% permissive licenses in runtime

---

## ⚡ Quick Start

### Build Your First AMI

```bash
# Clone the build system
git clone https://github.com/your-org/safebox-ami
cd safebox-ami

# Build medium-tier AMI (recommended default)
sudo ./build-ami.sh base,media,vision,embed,llm-medium

# Result: 110 GB AMI with full ingestion + coding/math LLMs
```

### Run Deterministic Inference

```bash
# Set seed for reproducible output
export SAFEBOX_INFERENCE_SEED="my_research_seed_12345"
export LD_PRELOAD=/opt/safebox/lib/libsafebox_deterministic.so

# Run inference (same input + seed = identical output)
echo "Explain quantum computing" | llama-cli --model qwen-3.6-27b-q4.gguf
```

### Ingest Documents

```bash
# PDF → vector embeddings
safebox-ingest pdf research_paper.pdf

# Video → scene keyframes + transcript embeddings  
safebox-ingest video lecture.mp4

# Search across all ingested content
safebox-search "machine learning optimization techniques"
```

---

## 📦 Components

### Core Components

| Component | Size | Description |
|-----------|------|-------------|
| **base** | ~8 GB | MariaDB, PHP, nginx, Docker, Node.js, ZFS, 50+ npm packages (always included) |
| **media** | ~370 MB | FFmpeg (LGPL), pdfium, libvips, ImageMagick |
| **libreoffice** | ~600 MB | Office document conversion |

### AI/ML Components

| Component | Size | Models | Use Case |
|-----------|------|--------|----------|
| **vision** | ~1.5 GB | SigLIP, BiRefNet, SAM 2 | Image understanding |
| **embed** | ~1.5 GB | BGE-M3, Nomic, Jina | Text embeddings |
| **speech** | ~1.2 GB | Whisper Turbo/Large, Kokoro TTS | Audio processing |
| **ocr** | ~50 MB | PaddleOCR | Text extraction |

### LLM Tiers

| Tier | Size | Models | Best For |
|------|------|--------|----------|
| **llm-tiny** | ~7.5 GB | Gemma E2B, Qwen 4B, Privacy Filter | Edge, routing, PII redaction |
| **llm-small** | ~26 GB | Qwen 8B, Mistral 12B, Phi-4, Gemma 9B | Classification, extraction |
| **llm-medium** ⭐ | ~103 GB | **Qwen 27B, Gemma 4 31B/26B**, Mistral 24B | **Coding, math, reasoning** |
| **llm-large** | ~169 GB | Llama Scout, Qwen 72B, Nemotron 49B | Long context, complex tasks |
| **llm-xl** | ~420 GB | **GLM-5.1 (MIT)**, DeepSeek V3.2, Qwen 397B | Frontier coding, research |

### Infrastructure Components

| Component | Size | Description |
|-----------|------|-------------|
| **cuda** | ~3 GB | NVIDIA GPU support |
| **vllm** | ~3 GB | Batched LLM serving |
| **diffusion-small** ⚠️ | ~8 GB | Stable Diffusion (AGPL - flagged) |
| **index** ⚠️ | ~300 MB | FalkorDB vector/graph (SSPL - flagged) |

---

## 🎯 Recommended Configurations

### Development / Edge
```bash
./build-ami.sh base,llm-tiny
# 15 GB, 8 GB RAM, t3.large
```

### General Purpose
```bash
./build-ami.sh base,media,llm-small
# 32 GB, 16 GB RAM, c6i.2xlarge
```

### Production (Recommended) ⭐
```bash
./build-ami.sh base,media,vision,embed,speech,llm-medium
# 110 GB, 64 GB RAM, r6i.8xlarge
```

### Research / Frontier
```bash
./build-ami.sh base,media,vision,embed,speech,llm-xl,cuda,vllm
# 850 GB, 256+640 GB RAM, p5.48xlarge
```

---

## 🔐 Security Features

### Triple-Layer Encryption
1. **AWS Nitro Enclave** - Hardware RAM encryption
2. **vTPM 2.0** - Measured boot with attestation
3. **ZFS AES-256-GCM** - Per-dataset encryption

### Deterministic Inference
- ✅ AI-only: LD_PRELOAD wrapper for model runners
- ✅ Crypto-safe: OpenSSL/TLS use real kernel entropy
- ✅ TPM-compatible: Attestation chain preserved
- ✅ Multi-tenant: Per-process seed isolation

### License Compliance
- ✅ **GPL-free runtime** (all permissive licenses)
- ✅ AI models: Apache 2.0, MIT, BSD, custom permissive
- ✅ Media toolchain: LGPL 2.1+ (dynamic), BSD, MPL 2.0
- ⚠️ Flagged: diffusion-small (AGPL), index (SSPL)

---

## 🆕 April 2026 Model Updates

### Five Major Additions

**1. OpenAI Privacy Filter** (1.5B, Apache 2.0)
- PII redaction: names, emails, passwords, accounts
- 96% accuracy, 128K context, runs in browser
- Added to `llm-tiny`

**2. Qwen 3.6 27B** (Apache 2.0)
- Coding specialist: 77.2% SWE-bench Verified
- Matches Claude 4.5 Opus on Terminal-Bench
- Beats 397B model on coding tasks
- Added to `llm-medium`

**3. Gemma 4 31B Dense** (Apache 2.0)
- Math/reasoning: 89.2% AIME 2026
- #3 open model globally (Arena AI)
- Google's first Apache 2.0 licensed model
- Added to `llm-medium`

**4. Gemma 4 26B MoE** (Apache 2.0)
- Only 3.8B active (efficient!)
- 79.2% GPQA Diamond (beats gpt-oss-120B)
- Added to `llm-medium`

**5. GLM-5.1** (744B MoE, MIT)
- #1 SWE-bench Pro (beats GPT-5.4 and Claude Opus 4.6)
- 8-hour autonomous coding capability
- MIT license (most permissive for XL tier)
- Trained on Huawei chips (zero NVIDIA)
- Added to `llm-xl`

---

## 📚 Documentation

### Core Documentation
- [**Complete Summary**](docs/SAFEBOX-COMPLETE-SUMMARY.md) - Full architecture overview
- [**Composable Architecture**](docs/SAFEBOX-COMPOSABLE-ARCHITECTURE.md) - 18-component system
- [**Final April 2026**](docs/SAFEBOX-FINAL-APRIL-2026.md) - Latest model updates

### Technical Deep Dives
- [**Deterministic RNG**](docs/DETERMINISTIC-AI-ONLY-RNG.md) - LD_PRELOAD solution (545 lines)
- [**Cascading Manifests**](docs/CASCADING-MANIFESTS.md) - Auto-discovery system (1200 lines)
- [**NPM Packages**](docs/NPM-PACKAGES-CATALOG.md) - 50+ package catalog (1008 lines)
- [**Media Toolchain**](docs/NODEJS-MEDIA-LIBRARY.md) - FFmpeg, pdfium wrappers

### API References
- [**Package Catalog**](docs/safebox-packages.json) - JSON schema
- [**Component Manifests**](manifests/) - Per-component specs
- [**Build Scripts**](scripts/) - Installation procedures

---

## 🏗️ Architecture

### Directory Structure
```
/opt/safebox/
├── manifests/           # Component manifests (auto-discovered at boot)
├── node_modules/        # 50+ npm packages
├── runtimes/            # llama.cpp, ONNX, whisper, vLLM
├── models/              # AI/ML models by tier
├── media/               # FFmpeg, pdfium, libvips
├── lib/                 # libsafebox_deterministic.so, wrappers
└── bin/                 # Executables, scripts

/opt/safebox-build/      # Build system
├── build-ami.sh         # Master build script
└── components/          # Per-component installers
```

### Data Flow
```
User Request → Safebox Workflow Engine (PHP)
    ↓
    ├─→ Document Ingestion (PDF/video)
    │   ├─→ pdfium/FFmpeg (extract)
    │   ├─→ SigLIP/Whisper (AI models)
    │   └─→ BGE-M3 (embeddings) → MariaDB/ZFS
    │
    ├─→ AI Inference (LLMs)
    │   ├─→ llama-server (LD_PRELOAD for determinism)
    │   └─→ ChaCha20 PRNG → deterministic output
    │
    └─→ Vector Search
        ├─→ Query embeddings
        └─→ Similarity search → ranked results
```

---

## 🧪 Testing

### Determinism Test
```bash
# Verify bitwise reproducibility
export SAFEBOX_INFERENCE_SEED="test_seed_12345"
export LD_PRELOAD=/opt/safebox/lib/libsafebox_deterministic.so

for i in {1..10}; do
  echo "Test prompt" | llama-cli --model model.gguf --seed 0 > out_$i.txt
done

# All outputs should be identical
sha256sum out_*.txt | awk '{print $1}' | sort -u | wc -l
# Expected: 1
```

### Crypto Randomness Test
```bash
# Verify TLS still uses real entropy (no LD_PRELOAD)
for i in {1..10}; do
  openssl s_client -connect localhost:443 -brief < /dev/null 2>&1 | \
    grep "Session-ID:"
done
# Expected: All different session IDs
```

### Ingestion Pipeline Test
```bash
# Test PDF ingestion
safebox-ingest pdf document.pdf
safebox-search "machine learning" --top-k 5
# Expected: Relevant sections with confidence scores
```

---

## 📊 Benchmarks

### Model Performance (April 2026)

**Qwen 3.6 27B:**
- SWE-bench Verified: **77.2%** (beats 397B)
- Terminal-Bench 2.0: **59.3%** (matches Claude 4.5 Opus)

**Gemma 4 31B:**
- AIME 2026: **89.2%** (math)
- GPQA Diamond: **84.3%** (science)
- Arena AI: **#3 globally** among open models

**GLM-5.1 744B:**
- SWE-bench Pro: **58.4%** (#1, beats GPT-5.4 and Claude Opus 4.6)
- 8-hour autonomous coding sessions

### Ingestion Throughput
- **PDF:** 5-10 pages/sec
- **Video:** 1-2 scenes/sec  
- **Audio:** 10x realtime

---

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Development Setup
```bash
# Clone repository
git clone https://github.com/your-org/safebox-ami
cd safebox-ami

# Install dependencies
./scripts/install-dev-deps.sh

# Build test AMI
sudo ./build-ami.sh base,llm-tiny

# Run tests
./scripts/run-tests.sh
```

---

## 📄 License

This project uses multiple licenses:

- **Core framework:** Apache 2.0
- **AI models:** Apache 2.0, MIT, BSD, custom permissive (see [LICENSE-MODELS.md](LICENSE-MODELS.md))
- **Media tools:** LGPL 2.1+ (dynamic link), BSD, MPL 2.0 (see [LICENSE-MEDIA.md](LICENSE-MEDIA.md))
- **Documentation:** CC BY 4.0

**GPL-free guarantee:** No GPL dependencies in runtime path.

See [LICENSE](LICENSE) for full details.

---

## 🙏 Acknowledgments

### AI Models
- Google DeepMind (Gemma 4)
- Alibaba Qwen Team (Qwen 3.6)
- Zhipu AI / Z.ai (GLM-5.1)
- OpenAI (Privacy Filter)
- Meta (Llama 4)
- Mistral AI (Mistral Small 4)

### Open Source Projects
- [llama.cpp](https://github.com/ggerganov/llama.cpp)
- [ONNX Runtime](https://onnxruntime.ai/)
- [vLLM](https://github.com/vllm-project/vllm)
- [FFmpeg](https://ffmpeg.org/)
- [MariaDB](https://mariadb.org/)
- [OpenZFS](https://openzfs.org/)

---

## 📞 Support

- 📖 **Documentation:** [docs/](docs/)
- 💬 **Discussions:** [GitHub Discussions](https://github.com/your-org/safebox-ami/discussions)
- 🐛 **Issues:** [GitHub Issues](https://github.com/your-org/safebox-ami/issues)
- 📧 **Email:** support@safebox.ai

---

## 🗺️ Roadmap

### Q2 2026 (Current)
- ✅ 18-component composable architecture
- ✅ 70+ AI models integrated
- ✅ Deterministic inference (LD_PRELOAD)
- ✅ Complete ingestion pipelines
- ✅ GPL-free guarantee

### Q3 2026
- [ ] Llama 4 Scout integration (10M context)
- [ ] Real-time streaming inference
- [ ] Multi-modal unified embeddings

### Q4 2026
- [ ] Cross-lingual video search
- [ ] Edge optimization (Q3_K_M quantization)
- [ ] Kubernetes deployment support

---

## 📈 Status

- **Version:** 1.0.0
- **Status:** Production-Ready
- **Last Updated:** April 23, 2026
- **Models:** 70+ (all permissive licenses)
- **Components:** 18 (mix-and-match)

---

## 🎯 Why Safebox?

### The Problem
Building AI infrastructure is hard:
- 🔴 Complex dependency management
- 🔴 License compliance nightmares
- 🔴 Multi-tenant security concerns
- 🔴 Non-reproducible inference

### The Solution
Safebox provides:
- ✅ **Composable:** Pick exactly what you need
- ✅ **Compliant:** GPL-free, all permissive licenses
- ✅ **Secure:** Triple encryption, per-process isolation
- ✅ **Reproducible:** Deterministic inference without breaking crypto

---

## 🚀 Get Started

```bash
# 1. Clone the repository
git clone https://github.com/your-org/safebox-ami

# 2. Build your first AMI (recommended: medium tier)
cd safebox-ami
sudo ./build-ami.sh base,media,vision,embed,llm-medium

# 3. Launch on AWS
aws ec2 run-instances --image-id ami-xxxxx --instance-type r6i.8xlarge

# 4. Run your first inference
ssh ubuntu@instance-ip
echo "Hello, Safebox!" | llama-cli --model qwen-3.6-27b-q4.gguf
```

**Welcome to the future of AI infrastructure!** 🎉

---

<p align="center">
  <sub>Built with ❤️ by the Safebox Team</sub>
</p>
