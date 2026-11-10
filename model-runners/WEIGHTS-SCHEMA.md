# Model weights: hashes + multi-source mirrors (the `weights[]` schema)

Every manifest's `weights[]` array was a stub (`"weights": []`). This defines it.
Each weight file carries its integrity hash AND a list of places to fetch it —
so a model is pinned by content and resilient to any single source going down.

## Schema

```json
"weights": [
  {
    "file":   "model-00001-of-00030.safetensors",
    "bytes":  4980736123,
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "cid":    "bafybeih...",              // IPFS content id (optional but preferred)
    "sources": [                          // tried in order; all must match sha256
      "ipfs://bafybeih...",              // resolved via our pinning node / gateway
      "https://mirror.safecloud.example/models/<manifestHash>/model-00001-of-00030.safetensors",
      "https://huggingface.co/<repo>/resolve/<gitRevision>/model-00001-of-00030.safetensors"
    ]
  }
]
```

## Rules (inductive security, applied to weights)

1. **`sha256` is authoritative.** Whatever source a file comes from, it is
   verified against `sha256` before use. A mismatch = rejected, try next source.
   This is the guarantee the system component already enforces; `sources[]` only
   changes WHERE bytes come from, never WHETHER they're checked.

2. **`cid` and `sha256` verify the SAME bytes two ways.** An IPFS CID is itself a
   content hash, so an `ipfs://` fetch is self-verifying on retrieval; we STILL
   re-check `sha256` so one code path verifies every source uniformly. Carrying
   both is a deliberate cross-check, not redundancy to trim.

3. **`sources[]` is ordered by trust+availability**, not preference for speed:
   our own pinning node / Safecloud mirror first (always-available, we control
   it), then the upstream origin (authoritative but may rate-limit or vanish).

4. **Pin the git REVISION, not a branch**, in any HF/Git source URL — a moving
   ref breaks the induction exactly like `:latest` does.

5. **The whole `weights[]` array feeds `manifestHash`.** The manifest's own hash
   (what M-of-N signs) is computed over the canonical manifest INCLUDING these
   entries, so the hash list and sources are themselves blessed.

## Mirrors & IPFS (the "host our own just in case" design)

- An IPFS **CID is the hash** — content-addressed, so an IPFS mirror needs no
  separate integrity metadata. But content only stays retrievable if a node
  **pins** it. So "use IPFS for mirrors" REQUIRES running a pinning node.
- **We run our own pinning node** as the first, always-available source. That IS
  the "our own mirror." Upstream (HuggingFace) is the fallback origin, not the
  thing we depend on for availability.
- **Safecloud (future):** the natural home for this pinning node — a
  content-addressed mirror of every weight our boxes depend on, so a safebox can
  always fetch a blessed model from infrastructure we control, verified by the
  same sha256 the manifest already carries. IPFS gives Safecloud the
  content-addressing for free.

## Fetch order (system component)

```
for each weight w in manifest.weights:
    for src in w.sources:            # our pin -> mirror -> origin
        bytes = fetch(src)           # ipfs:// via our node/gateway, or https://
        if sha256(bytes) == w.sha256:
            place at /srv/safebox/models/<manifestHash>/w.file
            break
        else: try next source
    else: FAIL CLOSED (no source produced verified bytes)
```
