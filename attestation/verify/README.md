# Attested Verification Service — Open Verification for closed-source code

This service lets auditors ask property questions about code they cannot see, and get answers with cryptographic proof that an attested AI model read the real code in a real Safebox. The code never leaves the box; the auditor gets verified answers.

The service lives entirely in the open-source measured base. Publishing it discloses nothing about the closed source it reads — it is the *machinery* that needs to be trusted, not the code the machinery reads.

## How it works

1. The **resolver** (in the measured base) enumerates every file in the app layer, hashes each, and builds a prompt with the file contents interpolated. It halts on any digest mismatch — it never substitutes, never falls back, never resolves a file whose hash doesn't match the manifest. The developer cannot hide files or swap sanitized versions because the enumeration runs in the base, not their code.

2. The **seed** is derived deterministically from the query: `SHA256(query | template_hash | model_hash) mod 2^31`. Same question + same code + same model → same seed → same answer. This is non-interactive: any auditor asking the same question at any time gets the same result, without coordinating with anyone.

3. The **model** (co-located in the Safebox, identified by weight hash) reads the resolved prompt and produces an answer at temperature=0 with the derived seed. The answer is a property assertion, not source reproduction.

4. The **response governor** classifies each response by exfiltration risk (general / statistical / specific / verbatim) and applies differentiated limits. Verbatim source reproduction is refused outright. A verbatim detector compares the proposed response against the actual source and suppresses any match over a threshold. Drift from general queries toward incremental extraction is detected and blocked.

5. The **verification record** accompanies every response: template hash (with placeholders unresolved), file digests (showing which files were read), model/runtime/tokenizer hashes, the seed, the output hash (the cryptographic commitment), and the attestation quote. The auditor verifies digests against the published manifest — they learn which files were consulted without receiving a line of source.

## Spot-check verification (the Solana VDF/PoH analogy)

A verifier — which may be running in its own Safebox or using one — can replay any verification query at any time: same template, same model, same seed → same output hash. The verifier doesn't need to check every query; it spot-checks a random sample. If any spot-check produces a different output hash, the Safebox that produced the original is provably dishonest.

This is the same economic argument as Solana's Proof of History: verification is cheaper than production, so a small number of spot-checks makes dishonesty unprofitable. The Safebox produces verification records continuously; verifiers spot-check asynchronously; a mismatch is a provable violation. The deterministic seed commitment forecloses outcome shopping — the operator cannot run the query repeatedly and publish only the favorable result, because the seed is derived from the query and committed before execution.

For diffusion models (image, audio, video), the same mechanism applies: same prompt + same model + same seed → same output (within hardware floating-point tolerance). Even at 95%+ similarity (the cross-architecture threshold), producing that level of agreement from a *different* model is computationally infeasible. The output hash is a binding commitment to the model, prompt, and seed — a Merkle-like property where one hash verifies the entire computation.

## RNG seed support across runners

Every Safebox runner already accepts a `seed` field in the inference protocol. The verification service sets it; the runner uses it. Determinism is achievable across all modalities: LLM text output (temperature=0 + seed), image generation (diffusion seed), audio synthesis (denoising seed), video generation (flow seed). The U runtime offers the strongest guarantee: because it controls the entire sampling path at the C level (no PyTorch, no CUDA kernel selection variance), CPU inference produces bit-exact outputs across runs with the same seed.

## Files

- `resolver.py` — Component 1: template resolver with digest checking and manifest chaining
- `verification_record.py` — Components 2-3: the verification record format and the response governor
- `service.py` — Component 4: the end-to-end verification service
- `test-verification-service.py` — 20-case test proving all properties
