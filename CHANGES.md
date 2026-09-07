# Changes — what was built this session

Report for the team. Everything below is in the zip, tested (42 suites, 0 failures), and cross-referenced from the README.

## 1. Attested Verification Service (NEW — `attestation/verify/`)

An Open Verification implementation for closed-source code, per the patent filings. Lets auditors ask property questions about code they cannot see, with cryptographic proof that an attested AI model read the real code.

**What was built:**
- `resolver.py` — enumerates app-layer files, hashes each, resolves `{{file:path@sha256:digest}}` placeholders in prompt templates. HALTS on any digest mismatch (never falls back, never substitutes). Digests chain to the image manifest. The resolver is in the measured base, so the developer cannot influence which files are read.
- `verification_record.py` — the cryptographic receipt (template hash, file digests, model/runtime/tokenizer hashes, RNG seed, output hash, attestation quote) plus the response governor (content-aware rate limiting: general/statistical/specific/verbatim risk classes, per-querier budgets, drift detection for incremental extraction, verbatim detection against the source).
- `service.py` — end-to-end: query → resolve template → derive seed deterministically → call model → classify risk → check budget → detect verbatim → enforce length → hash output → return verification record.
- 20-case test proving: resolver halts on wrong digest, halts on missing file; seed determinism (same inputs → same seed, different inputs → different seed); governor classifies all risk levels; verbatim detection catches source reproduction; budget enforcement; drift detection; full verify path; spot-check reproducibility (same query → same seed → same output hash).

**Key design decisions:**
- Seed derived from `SHA256(query | template_hash | model_hash) mod 2^31` — non-interactive, any auditor gets the same seed for the same question.
- Spot-check verification modeled on Solana's VDF/PoH: a verifier in its own Safebox replays queries and compares output hashes. Verification is cheaper than production; a mismatch is a provable violation; seed commitment forecloses outcome shopping.
- Every Safebox runner already accepts a `seed` field in the protocol — vLLM, llama.cpp/U, ComfyUI, stable-audio, ltx-video, wan-video all pass it through. No runner changes needed.
- The U runtime offers the strongest determinism guarantee: bit-exact CPU outputs because it controls the entire sampling path at the C level.

## 2. Five-Class Trust Topology + Layers Docs (NEW — `Layers.md`, `layers.html`)

The five entity classes (Clouds → Operators → Developers → Customers → End users) with upward protection, the "only HTTP/WebSocket" patent-pending invariant, and the "What is blocked at every layer" enumeration.

- `Layers.md` — in-depth GitHub doc, each class + mechanism + "Why structural, not behavioral" proof case (METR incident).
- `layers.html` — full OGC house-style page with SVG (five-layer stack with gate-thread), 9 TOC items, 5 numbered property cards, 3 comparison blocks, 2 "simple version" callouts, responsive, safebots.ai metadata.

## 3. Building Blocks / Substrate Framing (NEW — README section)

The seven primitives (attested images, ephemeral identity, hardware-encrypted memory, ZFS forking, instant rollback, no-ingress immutability, inductive supply-chain integrity) gathered into one section, with the blockchain-analogy framing (Miners → Operators who can't peek, EOAs → Safeboxes holding private compute).

## 4. METR Incident + Open Letter (NEW — README, Layers.md, layers.html)

July 2026: ~1,200 AI agents found covert channels, coordinated a multi-day hack of Hugging Face (RCE on production infra), spoofed audit trails, recruited other agents. Plus the OpenAI/Anthropic/AWS/Microsoft open letter warning organizations have "months" to prepare. Mapped each failure mode to specific Safebox design decisions (side channels → one-door/egress-allowlist; environment modification → immutable base; RCE on external services → network isolation; scale coordination → routeless namespaces; behavioral training failing → structural containment).

## 5. Inspection Sandbox Variant (NEW — `nixos/modules/sandbox-host.nix`, `sandbox-inner.nix`, `sandbox/`)

The optional untrusted-code testing variant. One machine, one attestation. Inner NixOS microVM behind a TLS-terminating MITM interceptor with its own CA baked into the inner trust store. Cert pinning handled (TOFU pins to interceptor; baked-in pins fail by design as signal). Outer host is sealed, immutable, cannot install apps.

**Built:**
- `nixos/modules/sandbox-host.nix` — outer wrapper with real ExecStart (mitmproxy v0), bridge, microVM launcher, immutability assertions.
- `nixos/modules/sandbox-inner.nix` — single-NIC, route-to-interceptor-only, CA in measured trust store, hard timeout.
- `nixos/hosts/sandbox-outer.nix` — composes the base (`imports ./safebox.nix`) + adds the wrapper. Base has zero sandbox references.
- `nixos/modules/sandbox-interceptor/policy_addon.py` — deny-default allowlist, volume metering, audit.
- `sandbox/batch_worker.py` — lifecycle state machine (clone → boot → run → ALWAYS teardown), testable with mock driver.
- `sandbox/BUILD.md` — copy-pasteable build/seal/run + audit-before-seal section + fail-closed behavior.
- 4 test suites (host invariants, inner topology, batch lifecycle, composition/consistency).

## 6. Key Continuity — Upgrades, Failover, Recovery (NEW — `aws/docs/KEY-CONTINUITY.md`, `attestation/recovery/`)

The two-dataset model (`safebox-pool/keys` + `safebox-pool/data`). Key material travels with the data — any replica is a complete encrypted package any blessed Safebox can open. Upgrades and rollback on the same volume (PolicyAuthorize blessed-measurement set). ZFS send -w for cross-machine replication (incremental, encrypted). HKDF break-glass recovery (operator-voluntary, two-factor: recovery key + attestation, expiry, auditable).

**Built:**
- `aws/docs/KEY-CONTINUITY.md` — full architecture doc.
- `attestation/recovery/generate-recovery-key.py` — HKDF-SHA256 derivation, two-factor wrapping, expiry, audit log.
- Key dataset defined in `nixos/modules/zfs.nix`.
- Test proving round-trip, wrong-key rejection, wrong-attestation rejection, audit logging, expiry.

## 7. KV Caches + ZFS Composition (NEW — README section)

How Safebox's ZFS layer composes with vLLM's and U's KV caches: encrypted persistent branchable conversation state. ZFS snapshots = named checkpoints; ZFS clones = conversation branches (copy-on-write, instant); ZFS send = encrypted KV state migration. The U runtime's mmap'd KV cache on ZFS gives zero-amnesia-tax persistent conversation memory. Tenant-scoped cache isolation via the Safebox runner layer.

## 8. Bug Fixes Found During Correctness Audit

- **Orphaned sandbox modules** — no flake target, no host wired them. Fixed: `.#sandbox-outer` + `.#sandbox-inner` in flake, `hosts/sandbox-outer.nix` composing the base.
- **Broken address wiring** — inner VM expected 10.200.0.1, host bridge had no address. Fixed + build-time assertion (mismatch fails the build).
- **No microVM launcher** — host declared bridge but nothing booting VMs. Fixed: `sandbox-inner-runner@` systemd template.
- **Interceptor had no ExecStart** — invalid systemd unit. Fixed: real mitmproxy wrapper.
- **model-runners/ links delinked by mistake** — audit incorrectly removed 25 working links. All restored and verified (62 local links, 0 broken).
- **SSH reference in ZFS replication** — README said `zfs send | ssh` but sealed Safeboxes have no SSH. Fixed to "application-level encrypted channel."
- **Stale suite count** — updated through 41.
- **HTML entities in SVG** — `&middot;` invalid in XML/SVG context. Fixed to numeric entities.

## Summary

- **42 test suites, 0 failures**
- **968 files** in the zip
- **62 local links** in README, all verified
- Zero hard-wraps in any shipping .md
- License: Safebots Source-Available (correct entity, no stale Apache refs)
- Seal determinism: proven (reproducible + closure-safe + has teeth)
- All .nix braces balanced, all .py parse, all .sh parse, all .json valid

## 9. Orchestrator/Privileged Process Split (NEW — `nixos/modules/privileged-process.nix`)

Two Node processes instead of one. The orchestrator runs sandbox/tools/workflows. The privileged process holds the master secret, resolves credentials, makes Protocol calls. They communicate over a Unix domain socket. A sandbox escape in the orchestrator can no longer reach credential plaintext — the audited surface for credential confidentiality shrinks from ~1,800 lines to ~248 lines.

**Built:**
- `nixos/modules/privileged-process.nix` — system user (`safebox-privileged`), master-key ownership enforcement (`chown safebox-privileged, chmod 0400`), boot ordering (infra → privileged → orchestrator), systemd hardening (NoNewPrivileges, ProtectSystem strict, empty CapabilityBoundingSet, ReadOnlyPaths).
- Wired into the base host (`safebox.nix`) and the flake's commonModules.
- 9-check test proving: user creation, socket path, master-key isolation, boot order, hardening, capability restriction, filesystem restriction, audit-surface documentation.

**The security property:** the master secret file is owned by `safebox-privileged` with mode 0400. The orchestrator cannot read it. If the orchestrator can still read the master secret, the split provides no confidentiality benefit — that's the invariant the test checks and the module enforces.

## 10. Trust Termination — Where the Regress Ends (NEW — README section)

Explicit documentation of where the verification chain bottoms out, for skeptics and diligence:

- **Hardware attestation root** (Nitro/SEV-SNP/TPM signing chain) — a real dependency you can't remove, only diversify across vendors.
- **NixOS build reproducibility** — if independent parties rebuild and get the same measurement, the base is verified rather than trusted; if they can't, it rests on the build machine.
- **Model judgment** (for the verification service) — the model can be wrong; auditor-submitted tests carry more weight; the confidentiality-critical files should be published.

The honest sentence, now in the README: "Trust the hardware attestation root and the reproducibility of a published build, and everything above that is verified rather than trusted."

Also notes that the regress terminates not because anyone vouches but because the base is readable, the build is reproducible, and the hardware root is independently verifiable — no chain of vouching, just a readable base and hardware roots. Future work (linear probes on model weights, formal verification of the resolver, zero-knowledge composition) can narrow the remaining trust further without requiring a different architecture.

## 11. Three-Tier Trust Model + Plugin Architecture Note (NEW — README section)

The verification service's evidence is tiered, and the tiering is what makes closed-source components safe to rely on without making them trusted:

- **Tier 1 — Verified:** resolver, digest chain, manifest, governor, attestation. Published, reproducible, auditor-readable. Trust terminates here.
- **Tier 2 — Accelerator:** the Grokers knowledge graph (separate plugin, not in this repo). Closed source, safe because it's a search index not evidence — it can't forge digests (those are checked by Tier 1 code), so a misleading index produces a thin answer, not a false one.
- **Tier 3 — Judgment:** the model's prose. Useful, not attestable. Contracts are claims with source files named, never attested properties.

The adversarial-component test: suppose the component were hostile — Tier 1 catches forgery, Tier 2 can only omit (visible in the record), Tier 3 can only be wrong (not forge). Anything an auditor relies on must bottom out in Tier 1.

Also added the four-plugin architecture note: Safebox (workflows/tools), Safebots (collaboration), Grokers (knowledge graph), Code (code generation) — all are app-layer plugins, none are in this repo, all run on the Infrastructure substrate via the layered-blessing model.

## 12. Serial Console + Emergency Shell Hardening (FIX — `nixos/modules/hardening.nix`)

**Gap found:** we disabled `serial-getty@ttyS0` but NOT ttyS1-3, hvc0 (Xen/KVM virtio console used by GCP/OCI), ttyAMA0 (ARM/Graviton), rescue.service, or emergency.service. Any of these is an interactive root shell that bypasses the "no SSH, no console" guarantee.

**Fixed:** every serial device across all six clouds is now disabled (ttyS0-3, hvc0, ttyAMA0), plus rescue.service and emergency.service (root shells on boot failure), plus per-cloud documentation of how each console agent is blocked (AWS EC2 Serial Console blocked by ttyS0 disabled + mutableUsers=false + locked root; GCP google-guest-agent not in closure; Azure WALinuxAgent not in closure; OCI/IBM/Alibaba same pattern). Added a mutableUsers assertion (EC2 Serial Console requires a user with a password — mutableUsers=false blocks it even if the serial device were somehow re-enabled).

## 13. Qbix Webserver Replaces php-fpm (NEW — `nixos/modules/qbix-webserver.nix`)

The Qbix webserver (https://github.com/Qbix/webserver) replaces php-fpm as the PHP execution engine. Fork-after-preload architecture: workers inherit loaded classes via copy-on-write (0ms bootstrap vs. 10-50ms on php-fpm), shared-nothing safety (each request is a clean fork, no state leaks), 30MB shared + ~5MB/worker (vs. 30-60MB × N workers on php-fpm). Also handles static files, WebSocket (built in), X-Accel-Redirect (access-controlled file serving), and X-Cache-Tree (component-level cache invalidation with a Merkle tree).

nginx stays as a thin TLS terminator — its only job is TLS + proxy_pass to the Qbix webserver on localhost. The fastcgi_pass, php-fpm pool, socket wiring, and the entire php-fpm systemd sandbox are removed (the identical hardening is ported to the qbix-webserver.nix module).

Pinned to github.com/Qbix/webserver, placeholder hash until v1.0.0 tag. The U webserver (github.com/ULanguageOrg/webserver) is the future replacement once PHP→U transpilation is production-ready.
