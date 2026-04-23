# Changelog

All notable changes to the Safebots Infrastructure project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-23

### Added
- 18-component composable architecture
- 70+ AI models across 5 LLM tiers (tiny to XL)
- Deterministic inference via LD_PRELOAD (AI-only RNG)
- Complete ZFS + Docker + MariaDB storage architecture
- Native MariaDB with file-per-table + ZFS snapshots/clones
- Instant workspace creation via ZFS copy-on-write
- 50+ NPM packages for document/PDF/image/chart generation
- Cascading manifest system with auto-discovery
- Complete PDF and video ingestion pipelines
- GPL-free runtime guarantee
- Triple-layer encryption (Nitro + vTPM + ZFS)
- Multi-tenant isolation via systemd + ZFS datasets

### April 2026 Model Updates
- OpenAI Privacy Filter 1.5B (Apache 2.0) - PII redaction
- Qwen 3.6 27B (Apache 2.0) - Coding specialist, 77.2% SWE-bench
- Gemma 4 31B Dense (Apache 2.0) - Math/reasoning, 89.2% AIME 2026
- Gemma 4 26B MoE (Apache 2.0) - Efficient, 3.8B active
- GLM-5.1 744B MoE (MIT) - #1 SWE-bench Pro, 8-hour autonomous coding

### Components
1. base (required) - MariaDB, PHP, nginx, Docker, Node.js, ZFS
2. media - FFmpeg, pdfium, libvips, ImageMagick
3. libreoffice - Office document conversion
4. vision - SigLIP, BiRefNet, SAM 2
5. vision-hq - High-quality vision models
6. embed - BGE-M3, Nomic, Jina + rerankers
7. speech - Whisper Turbo/Large, Silero VAD, Kokoro TTS
8. speech-hq - Whisper Large v3, high-quality TTS
9. ocr - PaddleOCR
10. llm-tiny - 4 models, 7.5 GB
11. llm-small - 4 models, 26 GB
12. llm-medium - 6 models, 103 GB (recommended)
13. llm-large - 4 models, 169 GB
14. llm-xl - 4 models, 420-850 GB
15. cuda - NVIDIA GPU support
16. vllm - Batched LLM serving
17. diffusion-small - Stable Diffusion (AGPL flagged)
18. index - FalkorDB vector/graph (SSPL flagged)

### Documentation
- README.md with complete table of contents
- 25 technical documents (6,000+ lines)
- Complete architecture specifications
- Build system documentation
- License compliance guides

### Security
- Deterministic AI inference without breaking crypto
- Per-dataset ZFS encryption (AES-256-GCM)
- TPM-sealed keys
- vTPM 2.0 measured boot
- Nitro Enclave hardware RAM encryption
- systemd-based resource isolation
- chroot filesystem isolation

### Performance
- Qwen 3.6 27B: 77.2% SWE-bench, matches Claude 4.5 Opus
- Gemma 4 31B: 89.2% AIME 2026, #3 open model globally
- GLM-5.1: #1 SWE-bench Pro (58.4%)
- PDF ingestion: 5-10 pages/sec
- Video ingestion: 1-2 scenes/sec
- Audio transcription: 10x realtime

## [Unreleased]

### Planned for Q3 2026
- Llama 4 Scout integration (10M context)
- Real-time streaming inference
- Multi-modal unified embeddings
- Enhanced workspace management UI

### Planned for Q4 2026
- Cross-lingual video search
- Edge optimization (Q3_K_M quantization)
- Kubernetes deployment support
- Advanced cost optimization
