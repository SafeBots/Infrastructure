# Model sources — canonical repos, pinned revisions, mirrors

Verified download origins + git revisions to pin, gathered 2026-07-28. These are
the `sources[]` origins for each manifest's `weights[]` (see WEIGHTS-SCHEMA.md).

**On hashes:** HuggingFace stores per-file **SHA-256** in each repo (LFS pointer
`oid sha256:...`, and the `model.safetensors.index.json` lists every shard). The
authoritative way to capture them is to read that index at the PINNED revision at
build time — a `resolve-model-hashes.sh` pass, exactly like image digests. Hand-
transcribing 20-30 shard hashes per model is error-prone and revision-fragile, so
this file pins the REPO + REVISION (the trust decision) and the hash capture is
mechanical from there. SHA-256 is the hash function throughout.

---

## Kimi Linear 48B  (single-GPU-ish frontier, KDA)
- **Repo:** `moonshotai/Kimi-Linear-48B-A3B-Instruct`  (also `-Base`)
- **URL:** https://huggingface.co/moonshotai/Kimi-Linear-48B-A3B-Instruct
- **Pin revision:** `806a95e` (current main) — verify before build
- **Size / shards:** 98.3 GB, 20× safetensors
- **Runner:** vLLM, `--tensor-parallel-size 4 --max-model-len 1048576 --trust-remote-code`
  (Moonshot's own command uses TP=4 — NOT single-GPU as first assumed; needs ~4 GPUs)
- **GGUF option:** `bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF` → runs on the llama.cpp runner (Q4_K_M / Q8_0)
- **Index (for hashes):** `/resolve/806a95e/model.safetensors.index.json`

## DeepSeek-V3  (already had a manifest)
- **Repo:** `deepseek-ai/DeepSeek-V3`  (and `-Base`)
- **URL:** https://huggingface.co/deepseek-ai/DeepSeek-V3
- **Pin revision:** `d990f04` (main) — fp8, custom_code
- **Runner:** vLLM, TP=8, trust-remote-code
- **Index:** `/resolve/d990f04/model.safetensors.index.json`

## Nemotron 3 Nano Omni  (CORRECTION: SGLang, not vLLM)
- **Repo:** `nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16` (FP8/NVFP4 variants "to come")
- **URL:** https://huggingface.co/nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16
- **Size:** 30B/32B params, ~April 2026, commercial use OK
- **Runner:** **SGLang**, NVIDIA's own images: `lmsysorg/sglang:dev-cu13-nemotronh-nano-omni-reasoning-v3` (CUDA 13) / `dev-nemotronh-nano-omni-reasoning-v3` (CUDA 12.9). `sglang serve --model-path <repo> --trust-remote-code`. Needs `librosa` for audio.
- **NOTE:** our manifest said vLLM — Omni currently wants SGLang + a model-specific dev image. Either add an SGLang runner, or wait for mainline vLLM support.

## Nemotron 3 Nano (text, non-omni)
- **Repo:** `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-Base-BF16`
- **Runner:** vLLM/SGLang, commercial OK. arxiv 2512.20848.

## Nemotron 3 Ultra  (rack scale, reference only)
- **Repo:** `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16`
- **Runner:** SGLang, TP=8 EP=8, 262144 ctx. 550B/A55B — multi-GPU rack.

---

## Mirror / IPFS plan
1. Fetch each model once from the HF origin at the pinned revision.
2. Verify every shard against the repo's `model.safetensors.index.json` SHA-256.
3. Add to our IPFS pinning node with a **sha2-256 multihash + raw leaves** so the
   CID EMBEDS the same SHA-256 (see CID note in WEIGHTS-SCHEMA.md) — one digest,
   two encodings, not two separate hashes.
4. Publish CIDs into each manifest's `sources[]` ahead of the HF origin.
5. Safecloud (future) runs the durable pinning node.

**Cloud-agnostic mirror today:** before Safecloud lands, the pinned weights can
be served from any object store via `storage/object-backend.sh` (S3/GCS/Azure/
OCI/S3-compatible, client-side encrypted). Set `safebox.storage.objectBackend`
and publish weights there; the CID/SHA-256 in each manifest still verifies them.
See `storage/README.md` for why this is the cold tier, distinct from the ZFS hot
tier and from Safecloud.

---

## TTS models — commercial-license audit (added 2026-07-28)

The TTS field is full of "open-source!" models whose WEIGHTS are actually
non-commercial. For Safebux-metered serving, only permissive (MIT/Apache)
weights qualify. Verified licenses:

### Chatterbox-Turbo  — COMMERCIAL-OK (MIT)  ✅
- **Repo:** `ResembleAI/chatterbox-turbo`  ·  rev `3c40542`
- 350M, zero-shot cloning + emotion + paralinguistic tags, ~6x realtime / ~75ms.
- Real hash captured: t3_turbo_v1.safetensors SHA-256 fcf1f8c1...cdf87 (1.92GB).
- ONNX build: `ResembleAI/chatterbox-turbo-ONNX` (fits the onnx runner).
- **The Fish-S2 replacement that is actually serveable.** PerTh watermark on all output.

### Chatterbox-Multilingual (base) — COMMERCIAL-OK (MIT)  ✅
- **Repo:** `ResembleAI/chatterbox`  ·  23 languages. Verify rev on HF.

### Orpheus 3B — COMMERCIAL-OK (Apache-2.0)  ✅
- **Repo:** `canopylabs/orpheus-3b-0.1-ft`  ·  Llama-based Speech-LLM.
- Best commercial-safe EXPRESSIVE pick. Sizes 150M/400M/1B/3B. Verify rev.
- Multilingual variants: verify their license separately (base English 3B is Apache).

### Higgs Audio v2 (3B) — COMMERCIAL-OK (Apache-2.0)  ✅  *** v2 ONLY ***
- **Repo:** `bosonai/higgs-audio-v2-generation-3B-base`  ·  built on Llama-3.2-3B.
- Best commercial-safe NATURALNESS/quality; multi-speaker + speech+music. vLLM-Omni servable.
- *** DO NOT use `bosonai/higgs-audio-v3-tts-4b` — v3 is Boson Research/Non-Commercial;
    production/hosted/revenue use needs a separate commercial license. DISQUALIFIED. ***

### DISQUALIFIED for Safebux serving (non-commercial weights) ❌
- **Fish Audio S2 / S2-Pro** — Fish Audio Research License (non-commercial). `fishaudio/s2-pro`.
- **Higgs Audio v3** — Boson Research/Non-Commercial (see above).
- **Voxtral (Mistral) TTS** — CC BY-NC 4.0.
- **F5-TTS** — weights CC-BY-NC.
- **XTTS-v2** — CPML (non-commercial).
- (All are downloadable/inspectable and fine for RESEARCH, just not for metered serving.)

### Already in tree
- **Kokoro-82M** — Apache-2.0, the cheap always-shippable baseline (no cloning/emotion).
  Chatterbox/Orpheus/Higgs-v2 are the commercial-safe EXPRESSIVE upgrades over it.

NOTE: every "beats ElevenLabs" figure above is vendor-run. Treat as "same class",
A/B on your own audio before betting hardware or quality claims on it.

---

## DeepSeek-V4-Pro-0813 — COMMERCIAL-OK (MIT) ✅  [added 2026-08-13]

- **Repo:** `deepseek-ai/DeepSeek-V4-Pro-0813` · **License: MIT** (repo + weights, ungated)
- **Runner:** existing `vllm/` (also SGLang; vLLM 0.9.x / SGLang Day-0 — TGI unsupported, Ollama/llama.cpp GGUFs unverified). 1.6T MoE, ~49B active, 1M context.
- **Flagship sibling of V4-Flash** — same MoE family (CSA+HCA attention). Frontier coding/reasoning (~80.6% SWE-bench Verified, DeepSeek's own number).
- **Model-selection note:** DeepSeek positioned **V4-Flash as BEATING Pro on every agentic benchmark they published** — Pro is for raw reasoning/context depth, NOT automatically for agentic/coding, and costs ~5× the hardware. Prefer Flash unless the workload needs 1.6T-scale reasoning or full 1M context at depth.
- `trustRemoteCode: true` → **REVIEW-GATED** (same club as v4-flash, deepseek-v3, kimi-k3, kimi-linear-48b, nemotron-omni). Pin the main commit, review custom modeling + `encoding_dsv4`, vet via trust-or-simulate before promotion.
- **No Jinja chat template** — same as Flash; use vLLM `--tokenizer-mode deepseek_v4`.
- **No in-weights DSpark draft** (unlike Flash) — no `--speculative-config` unless a compatible draft is added.
- **Hardware: heaviest runner in the catalog.** ~862GB weights. Native FP4 on a single **8×B300** node; Hopper path is a **2-node H200** cluster for full 1M context. Running on less compromises *context length*, not just throughput. Any 'cheap' framing is the hosted API, irrelevant to in-box cost.

## DeepSeek-V4-Flash-0731 — COMMERCIAL-OK (MIT) ✅  [added 2026-08-07]

- **Repo:** `deepseek-ai/DeepSeek-V4-Flash-0731` · **License: MIT** (repo + weights, ungated)
- **Runner:** existing `vllm/` (also SGLang). 284B MoE, 13B active, 1M context.
- Released 2026-07-31 (official; supersedes April preview — same architecture, new post-training).
- `trustRemoteCode: true` → **REVIEW-GATED** (same club as deepseek-v3, kimi-k3, kimi-linear-48b, nemotron-omni). Pin the main commit, review custom modeling + `encoding_dsv4`, vet via trust-or-simulate before promotion.
- **No Jinja chat template** — repo ships `encoding/` (encode_messages/parse_message_from_completion_text). Use vLLM `--tokenizer-mode deepseek_v4` so the OpenAI endpoint works without the helpers.
- **DSpark speculative decoding** ships inside the checkpoint (one flag, no second model). **Caveat:** unavailable on sm_120 (aborts during warmup) — disable the spec flag there.
- **Heavy to self-host:** DeepSeek's own vLLM example uses a single 4×GB300 node; GGUF quant ≈110 GB combined RAM+VRAM (8-bit 162 GB / 3-bit 103 GB). NOT single-consumer-GPU. Every expert stays resident despite 13B active.
- The HN "very affordable" = hosted API ($0.14/$0.28 per M tokens), NOT in-box serving cost.
- All benchmark numbers are DeepSeek's own — verify on your own agentic eval.
