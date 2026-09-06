# Models — what Safebox can run

Safebox does not bundle model weights. It downloads them from pinned sources, verifies every shard against SHA-256 hashes, and stores them on the encrypted ZFS model volume. This document lists every model the Infrastructure currently supports, organized by modality, with the runner that serves it and the manifest that pins it.

Hashes are captured mechanically from each model's `model.safetensors.index.json` (or equivalent) at the pinned revision — not hand-transcribed. The authoritative hash source is always the manifest file in `model-runners/<runner>/manifests/`. See `model-runners/MODEL-SOURCES.md` for pinned repos and revisions, and `model-runners/WEIGHTS-SCHEMA.md` for the manifest format.

## Text — LLMs

Runner: [`model-runners/vllm/`](model-runners/vllm/) (vLLM, OpenAI-compatible API over Unix socket)

| Model | Params | License | Hardware | Context | Manifest |
|---|---|---|---|---|---|
| DeepSeek-V4-Pro-0813 | 1.6T MoE (~49B active) | MIT | 8× H100 | 1M | `deepseek-v4-pro-0813.json` |
| DeepSeek-V4-Flash-0731 | MoE (~49B active) | MIT | 4× H100 | 1M | `deepseek-v4-flash-0731.json` |
| DeepSeek-V3 | 671B MoE | MIT | 8× H100 | 128K | `deepseek-v3.json` |
| Kimi-K3 (Moonshot) | MoE | MIT | 4× H100 | 1M | `kimi-k3.json` |
| Kimi-Linear-48B | 48B (3B active, KDA) | MIT | 4× GPU | 1M | `kimi-linear-48b.json` |
| LLaMA 3.3 70B Instruct | 70B | Llama 3.3 Community | 2× A100 80GB | 128K | `llama-3.3-70b-instruct.json` |
| Qwen 3-32B | 32B | Apache 2.0 | 1× A100 80GB | 128K | `qwen-3-32b.json` |
| Mistral Small 3 | 22B | Apache 2.0 | 1× A100 80GB | 32K | `mistral-small-3.json` |
| Gemma 3 12B IT | 12B | Gemma license | 1× A100 40GB | 128K | `gemma-3-12b-it.json` |
| Nemotron-3-Nano-Omni 30B | 30B (3B active) | Commercial OK | SGLang | 128K | `nemotron-3-nano-omni.json` |

Also documented in `model-runners/MODEL-SOURCES.md` but not yet manifested: GLM 5.2 (753B MoE, MIT), Nemotron-3-Ultra (550B, reference only), DeepSeek-R1 distills.

## Image — Diffusion

Runner: [`model-runners/comfyui/`](model-runners/comfyui/) (ComfyUI workflow engine, seed passthrough for deterministic generation)

| Model | Params | License | Hardware | Resolution | Manifest |
|---|---|---|---|---|---|
| SDXL 1.0 | 6.6B | OpenRAIL++-M | 1× A100 40GB | up to 2048² | `sdxl-base-1.0.json` |
| Flux.1 Dev | 12B | Non-commercial | 1× H100 80GB | up to 2048² | `flux-1-dev.json` |
| Flux.1 Schnell | 12B | Apache 2.0 | 1× A100 40GB | up to 2048² | `flux-1-schnell.json` |

ComfyUI also supports ControlNet, InstantID, IP-Adapter, LoRA, and inpainting as workflow nodes — all configured via the workflow template, not separate manifests.

## Video

Runners: [`model-runners/ltx-video/`](model-runners/ltx-video/) and [`model-runners/wan-video/`](model-runners/wan-video/)

| Model | Params | License | Hardware | Max length | Manifest |
|---|---|---|---|---|---|
| LTX-Video 2.3 Distilled | 8B | Apache 2.0 | 16GB VRAM | 20s @ 24fps | `ltx-2-3-distilled.json` |
| LTX-Video 2.3 Dev | 22B | Apache 2.0 | 24GB+ VRAM | 20s @ 24fps | `ltx-2-3-dev.json` |
| Wan 2.2 T+I2V 5B | 5B | Apache 2.0 | 16GB VRAM | 7.5s @ 16fps | `wan-2-2-ti2v-5b.json` |
| Wan 2.2 T2V A14B | 27B MoE (14B active) | Apache 2.0 | 24GB+ VRAM | 5s @ 16fps | `wan-2-2-t2v-a14b.json` |
| Wan 2.2 I2V A14B | 27B MoE (14B active) | Apache 2.0 | 24GB+ VRAM | 5s @ 16fps | `wan-2-2-i2v-a14b.json` |

LTX-Video is the draft-iteration runner (fast, includes synchronized audio). Wan is the hero-quality runner (slower, higher fidelity). Both serve `/v1/video/generate`; route by model name.

## Audio — Music and Sound Effects

Runner: [`model-runners/stable-audio-3/`](model-runners/stable-audio-3/)

| Model | Params | License | Hardware | Max length | Manifest |
|---|---|---|---|---|---|
| Stable Audio Open 1.0 | 1.4B | Community (CC training data) | 8GB+ VRAM | 47s | `stable-audio-open-1.0.json` |
| Stable Audio Open Small | 459M | Community (CC training data) | 4GB+ VRAM | 11s | `stable-audio-open-small.json` |

Stable Audio 3 medium and small (the upgraded successors) are documented in `docs/MODEL-CATALOG.md` with full specs; manifests pending weight availability.

## Speech — Text-to-Speech

Runners: [`model-runners/kokoro-tts/`](model-runners/kokoro-tts/), [`model-runners/chatterbox-tts/`](model-runners/chatterbox-tts/), [`model-runners/orpheus-tts/`](model-runners/orpheus-tts/)

| Model | Params | License | Hardware | Features | Manifest |
|---|---|---|---|---|---|
| Kokoro 82M | 82M | Apache 2.0 | CPU / any GPU | Fast baseline TTS | `kokoro-82m.json` |
| Kokoro 82M Multilingual | 82M | Apache 2.0 | CPU / any GPU | 5 languages | `kokoro-82m-multilingual.json` |
| Chatterbox Turbo | 350M | MIT | 1× GPU | Zero-shot cloning, emotion, 6× realtime | `chatterbox-turbo.json` |
| Chatterbox Multilingual | — | MIT | 1× GPU | 23 languages | `chatterbox-multilingual.json` |
| Orpheus 3B | 3B | Apache 2.0 | 1× GPU | Expressive speech-LLM | `orpheus-3b.json` |
| Higgs Audio v2 3B | 3B | Apache 2.0 | 1× GPU | Multi-speaker, speech+music | `higgs-audio-v2-3b.json` |

License note: Higgs Audio **v3** is non-commercial (Boson Research License) and is NOT included. Fish Audio S2, Voxtral, F5-TTS, and XTTS-v2 are also non-commercial and excluded. Only MIT/Apache weights qualify for production serving.

## Speech — Transcription

Runner: [`model-runners/whisper/`](model-runners/whisper/)

| Model | Params | License | Hardware | Speed | Manifest |
|---|---|---|---|---|---|
| Whisper Large v3 | 1.5B | MIT | 1× A100 40GB | 50× realtime | `whisper-large-v3.json` |
| Whisper Large v3 Turbo | 809M | MIT | 1× T4 | 80× realtime | `whisper-large-v3-turbo.json` |
| Distil-Whisper Large v3 | 756M | MIT | 1× T4 | 100× realtime | `distil-whisper-large-v3.json` |
| Whisper Medium | 769M | MIT | CPU / any GPU | 30× realtime | `whisper-medium.json` |
| Whisper Small | 244M | MIT | CPU / any GPU | 60× realtime | `whisper-small.json` |

## 3D — Image-to-Mesh

Runner: [`model-runners/triposr/`](model-runners/triposr/)

| Model | License | Hardware | Speed | Output | Manifest |
|---|---|---|---|---|---|
| TripoSR | MIT | 1× GPU (6GB+) | <0.5s on A100 | GLB, OBJ, PLY | `triposr.json` |

For text-to-3D, chain ComfyUI (text → image) then TripoSR (image → mesh). Direct text-to-3D models (Shap-E, Point-E, Trellis) are documented in `docs/MODEL-CATALOG.md` but do not ship as wrapped runners in 1.0.

## Documents — PDF/DOCX/PPTX Extraction

Runner: [`model-runners/mineru/`](model-runners/mineru/)

| Model | License | Hardware | Speed | Input | Output |
|---|---|---|---|---|---|
| MinerU 2.5 (pipeline) | Apache 2.0 | 1× T4 / consumer GPU | ~0.5-1s/page | PDF, DOCX, PPTX, XLSX, images | Markdown, JSON |
| MinerU 2.5 (VLM) | Apache 2.0 | 1× A10 / 24GB GPU | ~2-5s/page | Same | Same (higher fidelity on hard docs) |

## Embeddings and Reranking

Runner: [`model-runners/onnx/`](model-runners/onnx/) (ONNX Runtime, CPU-optimized)

| Model | License | Dimensions | Manifest |
|---|---|---|---|
| BGE-Small-EN v1.5 | MIT | 384 | `bge-small-en-v1.5.json` |
| BGE-Reranker-Base | MIT | — | `bge-reranker-base.json` |
| CLIP ViT-Base Patch32 | MIT | 512 | `clip-vit-base-patch32.json` |

## Privacy and Safety

Runner: [`model-runners/privacy-filter/`](model-runners/privacy-filter/)

Content filtering (PII, profanity, NSFW) applied before and after LLM inference. Runs on CPU or T4.

## How models are verified

Each manifest pins a HuggingFace repo and revision. At download time, every shard is verified against the SHA-256 from the repo's `model.safetensors.index.json` at that revision. The manifest hash (SHA-256 of the manifest file itself) is what the M-of-N auditor quorum blesses — so "which models are authorized to run" is a governance decision, not an operator decision. A model whose manifest hash is not in the blessed set is refused by the system component.

Model volumes are mounted read-only by the runners and are not replicated via ZFS send — on failover, the standby re-fetches from the supply chain using the same manifests, verified by the same hashes.

For deterministic verification (the Solana-like spot-check model), every runner accepts a `seed` field in the inference protocol. Same model + same prompt + same seed = same output. See [`attestation/verify/`](attestation/verify/) for how this composes with the verification service.
