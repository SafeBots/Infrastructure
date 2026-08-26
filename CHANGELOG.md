# Changelog

All notable changes to the Safebots Infrastructure project will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project will adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) starting from the 1.0.0 release.

> **Pre-release**: The 1.0.0 version is held until first public release. All entries below are development milestones in the working tree.
>
> **Scope**: This changelog covers ONLY the Infrastructure repo (Linux / AMI / server-runtime level). The Safebox plugin has its own changelog in its own repo.

## [Unreleased — 1.0.0 pre-release]

### CRITICAL: ZFS encryption was being bypassed (July 16, 2026)

`install-base.sh` created its encrypted datasets with no explicit mountpoint, so ZFS mounted them at the default `/safebox-pool/{safebox,docker,mariadb,tenants}`. But every `docker-compose.yml` bind mount sources from `/safebox/...`, and **no script created `/safebox/*`** — so Docker would have silently created those paths as empty directories on the **unencrypted root volume**. MariaDB data, nginx TLS material, model weights, and the Typesense index would all have landed outside the aes-256-gcm/TPM-sealed datasets, with everything appearing to work.

The same mismatch made the MariaDB tuning inert: `recordsize=16k` / `primarycache=metadata` / `logbias=throughput` were set on `safebox-pool/mariadb`, which nothing wrote to.

- **Datasets now get explicit mountpoints**: `safebox → /safebox`, `mariadb → /safebox/mariadb` (nested, keeps its own tuning), `tenants → /safebox/tenants`, `docker → /var/lib/docker` (matching `storage-opts zfs.fsname`). A pre-existing dataset at the wrong mountpoint is **corrected**, not skipped, so a box built before this fix is repaired on re-run.
- **Post-create verification**: the installer asserts every dataset landed where asked and that `/safebox` is genuinely a ZFS mount (`stat -f`), and **fails the install** otherwise. A silent mountpoint mismatch is exactly the failure being guarded against, so it must not be survivable.
- **All 14 bind-mount directories are created** on the datasets before the stack starts, so Docker never auto-creates them on `/`. `nginx/ssl` is 0710 and `mariadb/data` is 0700.
- **MariaDB tuning now also installs to `/safebox/mariadb/conf/safebox.cnf`**, the path the container actually reads (`/etc/mysql/conf.d`), in addition to `/etc/my.cnf.d/safebox.cnf` for a host MariaDB. Both come from one source; the duplication collapses once the host-vs-container question (inconsistencies.md F3) is settled.

### Inconsistency fixes — backup docs, mineru tests, installer rename (July 14, 2026)

Fixed four items from the inconsistencies audit that were safe to fix without a design decision:

- **Backup docs reconciled with reality.** `XTRABACKUP-PRIMARY.md` and `BACKUP-STRATEGY.md` (both README-linked) described an XtraBackup + borg-style pipeline that was never built — no script installs or invokes `xtrabackup`/`mariabackup` or `borg`. Added status banners (matching the existing `FLUSH-TABLES-UPDATE.md` correction) clarifying the implemented path is `FLUSH TABLES WITH READ LOCK` around an atomic ZFS snapshot (`flush-and-snapshot.sh`) plus `zfs send | ssh | zfs receive` replication. Annotated the README link as design-history.
- **mineru runner now has `test_runner.py`.** It was the only runner without in-process tests. Added 16 tests covering source resolution, the markdown→HTML converter, and HMAC verification (including the verify-before-record nonce ordering). Orchestrator now runs 14 suites (was 13); every runner has tests.
- **Renamed `scripts/install.sh` → `scripts/install-system-api-host.sh`.** Its generic name caused the earlier "AMI installed almost nothing" confusion — it only does `system-protocol-api` broker host-side setup. Updated the two live callers (`provision-safebox-ami.sh`, `docs/AWS-NITRO-SETUP.md`); left historical CHANGELOG references under the old name intact.

Remaining audit items (bootstrap broker asymmetry, ACME contact email, proxyTarget, CLI install-manifests, Autohost env prefix) need a decision or a deployment fact and are tracked in `inconsistencies.md`.

### Consistency sweep — broker-setup gap + stale doc references (July 9, 2026)

A consistency pass across both repos after the AMI-path reconciliation caught a gap that the reconciliation itself introduced, plus stale references:

- **Broker host-side setup was orphaned.** Reconciling the AMI path to call the four component installers (instead of the broker-only `scripts/install.sh`) meant nothing set up the `system-protocol-api` container's host-side prerequisites — the `safebox-api` user, the HMAC key at `/etc/safebox/system-api.key`, and the `system-registry.json` M-of-N registry, all of which live only in `scripts/install.sh`. The docker-compose stack would have brought the broker container up with no key or registry. Fixed by calling `scripts/install.sh` in the reconciled sequence after the components and before `docker compose up`, and relabeled `scripts/install.sh`'s header to make clear it does ONLY broker host-side setup despite its generic name.
- **`docs/AWS-NITRO-SETUP.md` told operators to run the broker-only `scripts/install.sh`** as the whole install — the same half-install the provisioning script used to do. Updated to the full component sequence + preflight + broker setup + stack, matching `provision-safebox-ami.sh`.
- **Stale `autovhost` comment** in `dnsclient.js` updated to `autohost`.

### AMI provisioning path reconciled + preflight added (July 9, 2026)

Fixed two things that would each break a production AMI build:

- **ZFS pool name mismatch.** `provision-safebox-ami.sh` created a pool named `zpool`, but `install-base.sh` hard-fails unless the pool is named `safebox-pool` (and creates all datasets under it). The provisioning script now creates `safebox-pool` with the canonical flags (`ashift=12`, `compression=lz4`, `atime=off`) and no longer pre-creates a stray `qbix-platform` dataset the installer doesn't expect.
- **AMI path installed almost nothing.** The AMI provisioning path called `scripts/install.sh`, which installs *only* the `system-protocol-api` docker broker — it skipped base, system, dnsclient, and autohost entirely, producing a box with the broker and nothing else. The path now runs the full sequence in dependency order (base → system → dnsclient → autohost) and brings up the docker-compose stack. base runs first because it verifies the pool, creates datasets, tunes MariaDB, and configures the docker daemon everything else needs.
- **Added `scripts/preflight.sh`.** Fail-fast prerequisite check run before install: verifies required binaries, node >= 20, the `safebox-pool` ZFS pool, the HMAC key, and Nitro attestation prerequisites (`/dev/nsm`, AWS Nitro root cert, `nsm-cli`). Fatal vs warning split is sensible (missing pool is fatal; missing-but-generatable key is a warning; off-Nitro is a warning unless `--strict`, which production AMI builds should use). Turns a half-installed mystery box into one clear error at second zero.

### Converged `autovhost` onto vendored Autohost (July 9, 2026)

The in-repo `autovhost` provisioner and the public [Autohost](https://github.com/Safebots/Autohost) project were two diverging forks of one tool. Converged them: Safebox now consumes Autohost as a submodule (`vendor/autohost/`, unmodified), and the one feature `autovhost` had that Autohost lacked — the registrable-domain issuance limiter — was moved upstream into Autohost where it's generic. Full write-up in [`aws/scripts/components/autohost/MIGRATION-autovhost-to-autohost.md`](aws/scripts/components/autohost/MIGRATION-autovhost-to-autohost.md).

- **Registrable-domain limiter moved upstream.** Now a third additive sliding-window limit in Autohost's `src/rateLimit.js` (`allowPerDomain`, keyed on eTLD+1) alongside per-IP and global. `perDomainLimitPerHour` default 10, 0 to disable. Shipped to the public Autohost repo with 17 tests. This is the wildcard-DNS abuse defense (`*.evil.com` → our IP can't exhaust the ACME account quota).
- **New thin `autohost` component** at `aws/scripts/components/autohost/` replaces `autovhost/`. Supplies only Safebox config (`autohost.safebox.json`, mapping Safebox paths/socket onto Autohost's config surface), the installer (`install-autohost.sh`, installs from the submodule), the systemd unit, nginx templates, and the Safebox splash test. The provisioner code is Autohost's, via the submodule.
- **Safebox governance plugs in through Autohost's `authorizeHook`** — no fork. Null for 1.0 (DNS + rate-limit only); the seam is ready for the projects/quota/token control plane.
- **Deleted `aws/scripts/components/autovhost/`.** Redundant tests dropped (handler/reload/unit are covered by Autohost's own suite); the Safebox-specific splash test was ported to `test/testAutohostSplash.js`.
- Updated `bootstrap-safebox.sh`, `run-all-tests.sh`, and the README to reference the new component.

### Deploy-readiness fixes — three startup-crash bugs (July 9, 2026)

A deploy-readiness pass (loading each component with only the files its installer actually copies) caught three bugs that every test suite missed, because tests run from the repo where all files are present:

- **`autovhost` would crash on startup: `issuanceLimiter.js` was never deployed.** `autovhost.js` does `require('./issuanceLimiter')`, but `install-autovhost.sh` copied only `autovhost.js config.js package.json`. On a real box the service would fail immediately with `Cannot find module './issuanceLimiter'`. Added it to the installer's copy list.
- **`autovhost` had a temporal-dead-zone crash.** The issuance limiter was instantiated at module top with `(cfg && cfg.acmePerDomainMax)`, but `cfg` (a `const`) isn't declared until ~90 lines later — so referencing it at load time threw `ReferenceError: Cannot access 'cfg' before initialization`, crashing the module before it could serve anything. Moved the instantiation to just after `cfg = config.load()`.
- **`system-protocol-api` container would crash: `stmValidators.js` was never mounted.** `docker-compose.yml` mounts `system-protocol-api.js` as `/app/server.js`, but the extracted `stmValidators.js` it now requires wasn't mounted, so the container would fail with `Cannot find module './stmValidators'`. Added the mount.

Verified by simulating each deploy — copying only the installer-/compose-specified files into a clean dir and loading — so these are checked against the actual deploy manifest, not the repo tree.

### Git supply-chain: pinned-commit mismatch is now a hard failure (July 9, 2026)

All three git operations in `system-protocol-api.js` (`git-clone`, `git-pull`, `git-checkout`) pin a 40-char commit SHA, then run `git rev-parse HEAD` to check the checkout landed on it — but they returned `verified: false` as part of a **successful** result rather than failing. A caller that didn't inspect that field would treat a tampered mirror or a moved ref (a checkout that landed on a *different* tree than the pin names) as a clean pull. Since the whole point of pinning a commit is that the SHA is a content-address of the tree, a mismatch has to be a hard failure or the pin means nothing.

- Extracted the check into a pure, testable `verifyCommit(rawOutput, pinnedCommit, label)` in `stmValidators.js`: takes the last non-empty line of the `rev-parse` output as HEAD, returns `{ ok, head }` on an exact match, throws on any mismatch or empty output. All three git ops now call it and `reject()` on throw.
- This matters for the transitive-signing model: M-of-N approval of a parent commit pins its submodule/dependency commits by SHA, so "pull dependency at commit X" is only trustworthy if landing on a different commit is a hard error. It now is, at both the top-level clone and the update paths.
- `docker/test/testStmValidators.js` gains 5 assertions covering exact match, HEAD extraction from noisy output, and hard-throw on mismatch / different-HEAD / empty output.

### ACME issuance rate limiter — wildcard-DNS abuse defense (July 9, 2026)

On-demand cert issuance was an unauthenticated, amplifying, quota-exhausting primitive exposed to the whole internet. The existing per-host defenses (`installedHosts`, `negativeCache`, `inflight`) are all keyed on the exact hostname, so a wildcard DNS record — `*.evil.com` → our IP — defeats all of them: every unique name (`a.evil.com`, `<guid>.evil.com`) passes `isValidHostname`, misses every cache, and PASSES the `dnsPointsAtUs` check because the wildcard genuinely resolves to us. Each one then drives a real ACME order. The damage isn't DoSing Let's Encrypt (they just refuse us) — it's that LE's limits are per-registered-domain and per-account, so an attacker burning the account quota on junk certs causes *legitimate customer onboarding to fail*.

- **`issuanceLimiter.js`** (new, standalone, zero-dep) — two sliding-window limits keyed on the axis LE itself limits: per-registrable-domain (eTLD+1, default 10/window — a real customer needs ~2 for `id.` + `chat.`) and a global account budget (default 100/window) so a spread-out attack across many domains can't exhaust the account. Both successful and failed attempts count, since LE rate-limits failed validations too and a wildcard attacker mostly produces failures. Registrable-domain resolution uses a compact built-in public-suffix heuristic (no new dependency); a too-coarse grouping only ever makes the limit stricter, never weaker.
- **Wired into `tryProvision`** after the DNS check passes and before the ACME order. A rate-limited host is not negative-cached (it may be legitimate and simply over budget momentarily), and the rejection audits with reason + scope so operators can alert on account-wide exhaustion. Limits are config-overridable (`acmePerDomainMax`, `acmeGlobalMax`, `acmeWindowMs`). A periodic `sweep()` (unref'd timer) keeps the per-domain map from growing unbounded.
- **`testIssuanceLimiter.js`** (34 assertions) — proves the wildcard attack is capped at the per-domain limit, the global budget protects the account across many attacker domains, legitimate `id.`/`chat.` onboarding passes, the sliding window frees budget on expiry, failures count, and `check()` doesn't consume while `tryAcquire()` does. Uses an injectable clock for deterministic window testing.

### Test coverage for the security-hardening pass (July 9, 2026)

The hardening work landed without tests; this closes that gap and, in doing so, found one more bug.

- **STM injection validators extracted and tested.** The `V` table + `must()` from `system-protocol-api.js` moved into a standalone, side-effect-free `docker/stmValidators.js` (the API file couldn't be imported for testing — it starts a server and reads config on load). New `docker/test/testStmValidators.js` runs 65 assertions: every shell-injection payload (`; rm -rf /`, `$(...)`, backticks, `&&`, newlines, `..` traversal) rejected across every field, plus non-string/edge inputs, plus legitimate values accepted.
- **Found and fixed a real hole while writing the test:** the `gitUrl` validator accepted `https://x.com/$(id)` because `$`, `(`, `)` are valid URL characters — but that URL is interpolated into `git clone ${url}` in a shell string, so it would have executed. Tightened the charset to exclude shell metacharacters; legitimate URLs (including query strings) still pass.
- **`auth.js` now has direct coverage.** New `testAuth.js` (15 assertions, auto-discovered by the system test runner): sign/verify round trip, wrong-key/tampered-body/tampered-method/tampered-path rejection, all malformed-header paths, timestamp skew, nonce replay, and a regression guard that a bad-signature request does not burn a nonce. (`auth.js` already had the correct ordering — the bug was only in the Python runners — so this locks in good behavior.)
- **`privacy-filter` now has a test at all.** It previously had none (its top-level `import torch` made the module unimportable without the ML stack). Refactored to lazy-load torch/transformers inside `load()`/`redact()` like the other nine runners, then added `test_runner.py` covering the HMAC path that was entirely absent before the hardening pass — including the nonce-ordering regression.
- **Nonce-ordering regression added to all runner tests.** The eight runners with a `test_runner.py` now assert the specific fix (bad-sig doesn't burn the nonce; overflow half-evicts instead of clearing), not just old accept/reject behavior. (`mineru` has no `test_runner.py` yet — noted for follow-up.)
- **Top-level `run-all-tests.sh`** orchestrates every suite — system component, STM validators, CLI, and all ten runner suites — with a summary table and non-zero exit on any failure. Previously each suite had to be run by hand. Current result: 12/12 suites green.

### MariaDB ⇄ ZFS tuning wired into the base install (July 9, 2026)

The architecture doc described InnoDB/ZFS alignment that the install scripts never actually applied — it worked in dev on defaults and would have wasted RAM and IOPS in production. Now wired in `install-base.sh`:

- **`recordsize=16k` on `safebox-pool/mariadb`** — matches the InnoDB page size so one InnoDB page is one ZFS record. Without it, every 16 KiB write became a 128 KiB read-modify-write (8× amplification). Inherited by per-tenant/per-project child datasets.
- **`primarycache=metadata`** — stops the ZFS ARC from double-buffering InnoDB data pages that the buffer pool already caches. The same bytes cached twice was silently halving effective RAM.
- **`logbias=throughput`** — routes InnoDB's large sequential writes appropriately rather than through the ZIL as latency-sensitive syncs.
- **`/etc/my.cnf.d/safebox.cnf`** now written at build time with `innodb_file_per_table=1` (explicit, not relying on the 10.5 default), `innodb_flush_method=O_DIRECT` (the InnoDB side of the double-buffer fix), `innodb_doublewrite=0` (redundant on ZFS's copy-on-write — no torn pages to guard against), and `innodb_flush_log_at_trx_commit=1` + `sync_binlog=1` for clean snapshots.
- **Operator-selectable compression** via `MARIADB_COMPRESSION` (default `lz4`, validated allowlist including `zstd`/`zstd-N`). zstd is native to OpenZFS and compresses the repetitive `publisherId, streamName` row shape harder than lz4 for boxes with CPU headroom. Compression sits below MariaDB and above ZFS encryption — the only order where both work, since encrypted bytes don't compress.

**Encryption at rest is ZFS-only by design** — MariaDB-level encryption is deliberately NOT enabled, because encrypting in InnoDB would hand ZFS high-entropy bytes and defeat compression. One encryption layer (AES-256-GCM, key sealed to TPM/Nitro), below compression.

### Clean-snapshot helper for cross-Safebox replication

`/opt/safebox/bin/flush-and-snapshot.sh` wraps `FLUSH TABLES WITH READ LOCK` around an atomic ZFS snapshot (lock held across the snapshot in a single MariaDB session, since the lock releases when its session closes), producing a *clean* rather than merely crash-consistent image. Feeds the `zfs send | ssh | zfs receive` ship path — the actual cross-Safebox replication mechanism, used instead of SQL replication.

### Documentation correction — replication is `zfs send`, not borg

`FLUSH-TABLES-UPDATE.md` described a `borg-chunk.py` (600+ lines) and `backup-safebox.sh` that **do not exist in the repo** — a "borg-like" content-defined chunker that was documented as built but never committed. Added a status banner distinguishing what's built (`FLUSH TABLES` → `zfs send`, no borg, no rsync) from what's designed-but-unbuilt (the content-defined chunking layer). The dedup that layer would add is marginal over ZFS's own block-delta send; revisit only if it becomes a bottleneck.

### Security hardening pass — HMAC, model supply chain, orchestrator injection (June 29, 2026)

A focused audit of the trust-critical paths turned up several serious bugs. All fixed, all covered by tests.

**Runner HMAC verification (all ten model runners + privacy-filter).**
- **Nonce consumed before signature check.** Every runner's `verify_hmac` recorded the request nonce *before* verifying the signature. An attacker who could reach the socket could send a stream of bad-signature requests carrying guessed or replayed nonces, burning them into the seen-set — and, worse, driving the set to its overflow threshold. Fixed: the signature is now verified first; the nonce is recorded only on a valid signature.
- **`seen_nonces.clear()` opened a replay window.** On overflow the runners cleared the *entire* nonce set, so every nonce seen in the preceding 5-minute skew window became replayable at once. Replaced the `set` with an insertion-ordered `OrderedDict` and switched to half-eviction (drop the oldest 25 000 entries), so recently-seen nonces are never forgotten while they're still inside the timestamp window.
- **`privacy-filter` had no HMAC enforcement at all.** It loaded the key and allocated a nonce set but never called a verify function — the `/v1/redact` endpoint accepted any request. Added the full `verify_hmac` (matching the other runners, with the ordering fix above) and a `SAFEBOX_REQUIRE_HMAC` gate, and wired it into the endpoint.

**Model supply chain (`aws/.../system/opsModels.js`).**
- **`verifyInstalledModel` read entire weight files into memory.** It used `fs.readFileSync` on every file to hash it — a 30-55 GB safetensors shard would OOM the System process. Replaced with a streaming `sha256File` (1 MiB chunks) plus `statSync` for the size check; memory stays flat regardless of model size.
- **Concurrent install of the same model returned 500.** Two racing `/models/install` calls for the same manifest hash both download to separate staging dirs; the loser's `renameSync` onto the winner's populated directory throws `ENOTEMPTY`, which was surfaced as `INSTALL_FAILED`. Now caught and reported as idempotent `alreadyInstalled` success.
- **Download state machine could run concurrent attempts.** In `downloadWithFallback`, the oversize-response path and the `req.destroy()`-triggered `error` event could each schedule `tryNext()` for the same slot, running two download attempts against one `.partial` path and skipping sources. Added a per-attempt `attemptSettled` guard so exactly one terminal event advances.

**Orchestrator command injection (`docker/system-protocol-api.js`).**
- The Docker-orchestration API builds `sh -c` command strings for npm / composer / dnf / git / nginx operations and interpolated STM values (`package`, `version`, `workdir`, `url`, `repo`, `dest`, submodule paths, `domain`, `app`, `certPath`, `keyPath`) straight into them. The endpoint is UID- and HMAC-gated so the caller is trusted, but a bug in Safebox's STM construction would have become container RCE. Added a shared validator table with tight allowlists (package names, semver-ish versions, absolute no-traversal paths, https/ssh git URLs, domains, ZFS dataset/snapshot names) applied at every builder. Verified against a suite of injection payloads (`; rm -rf /`, `$(...)`, `&&`, `..` traversal) — all rejected, all legitimate values accepted.
- Guarded the dynamic `require(\`${pkg}/package.json\`)` in the dependency checker against path traversal from a tampered `system-registry.json`.
- Added a 1 MiB request-body cap (the STM control messages are tiny; the cap prevents a memory-exhaustion vector), with the 413 response sent before `req.destroy()` rather than deferred to an `end` event that won't fire.

**Video runner temp-file cleanup (`ltx-video`).** When the audio mux step failed (e.g. ffmpeg missing), the intermediate `.video-only.mp4` was orphaned and the request 500'd. Now degrades gracefully to a video-only result and cleans up.

**Container runtime direction.** Added a README section documenting the Docker-for-1.0 / Podman-later plan — the "rootless cosmopolitan" target, why `dockerode`-against-Podman and rootless GPU passthrough keep us on Docker for launch, and the honest caveat that runtime choice narrows the tenant-escape blast radius but not the control-plane one.

### Wan 2.2 runner shipped (June 29, 2026) — `model-runners/wan-video/`

Second video runner. `model-runners/wan-video/` wraps Alibaba's [Wan 2.2](https://github.com/Wan-Video/Wan2.2) (Apache 2.0, Tongyi Wanxiang team) as a Safebox-canonical text-to-video and image-to-video service. Sister to `ltx-video/` — same `/v1/video/generate` protocol, complementary model. Operators run both side-by-side: LTX-Video for fast iteration drafts (8-step distilled inference with synchronized audio), Wan 2.2 for high-quality hero finals (MoE A14B variants).

**Why a second video runner.** LTX-Video is the right default for most generation — fast, includes audio, runs on 16 GB consumer cards. Wan 2.2 climbs higher on quality at the cost of inference time and (for the A14B variants) VRAM. The MoE architecture in particular gives Wan a quality ceiling that LTX doesn't reach: separate denoising experts for the high-noise (composition) and low-noise (texture) stages, totaling 27 B parameters but with only 14 B active per step. Sharper textures, cleaner motion, better prompt adherence. The two runners together give Safebox tenants a draft/final workflow that closed cloud APIs can't match — fast iteration on local hardware, then final-quality renders also on local hardware.

**Component layout:**

```
model-runners/wan-video/
├── README.md                       (~310 lines — architecture, deployment, draft/final workflow examples)
├── Dockerfile                      (CUDA base, optional PREFETCH for weight baking)
├── requirements.txt                (diffusers ≥0.33 for Wan integration, torch ≥2.4)
├── runner.py                       (616 lines — FastAPI + diffusers WanPipeline)
├── test_runner.py                  (38 in-process tests, all passing)
└── manifests/
    ├── README.md                   (picking guide, MoE explanation, LTX vs Wan comparison)
    ├── wan-2-2-ti2v-5b.json        (5B combined T+I2V, 16 GB VRAM minimum)
    ├── wan-2-2-t2v-a14b.json       (MoE A14B T2V, 24 GB+ VRAM)
    └── wan-2-2-i2v-a14b.json       (MoE A14B I2V, 24 GB+ VRAM)
```

**MoE dual guidance scales.** Because Wan 2.2 A14B has two experts, classifier-free guidance has two scales — one per expert. The runner exposes `guidance` (high-noise expert, default 4.0 for T2V) and `guidanceLowNoise` (low-noise expert, default 3.0) as separate request fields. Wan-AI's recommended defaults are used out of the box; operators rarely need to tune. The 5B TI2V variant is single-stream and ignores `guidanceLowNoise` (uses guidance=5.0).

**Scheduler tuning.** The UniPC scheduler's `flow_shift` parameter affects the noise schedule — 5.0 for 720p output, 3.0 for 480p. The runner sets it automatically based on the requested resolution band. Manual override via the `flowShift` request field.

**Dimensions divisible by 16.** Wan's VAE downsamples by 16, so width and height are clamped to multiples of 16 (vs LTX-Video's multiple-of-32 requirement). More flexible aspect ratios.

**No native audio.** Base Wan 2.2 is video-only. For synchronized audio+video, operators use the `ltx-video` runner. For background music, they chain `stable-audio-3`. Wan 2.2-S2V (speech-to-video) is a separate Wan variant that would warrant its own runner — post-1.0.

**Cost positioning vs closed APIs:**

| Provider | Per 5s clip | Quality | Data exposure |
|---|---|:---:|---|
| Sora Pro | ~$1.00 | ★★★★★ | ✗ |
| Runway Gen-4.5 | ~$0.60 | ★★★★½ | ✗ |
| **Wan 2.2 A14B self-hosted** | **GPU power only** | **★★★★** | **✓** |

For high-volume production with strict data-residency requirements, the math becomes obvious past a few dozen clips per month.

**Wire format identical to ltx-video.** Same response envelope, same `video` block, same `sourceSha256` / `outputSha256` audit trail. Wan-specific MoE settings (`guidance`, `guidanceLowNoise`, `flowShift`) reported in the `usage` block. Full interchangeability at the Safebox plugin layer — switching from LTX-Video to Wan 2.2 in a call site is a one-token model-name change.

### LTX-2.3 audio path wired (June 29, 2026) — `model-runners/ltx-video/`

The note in the v1.0 LTX-Video shipping entry called out the audio path as "post-1.0" — the model can produce synchronized audio in one forward pass, the wrapper just didn't wire it up. That's now done.

**What changed.** `runner.py` grew from 562 → 710 lines. New helpers `audio_to_wav_bytes()` (encode LTX-2.3's stereo float audio output as 16-bit PCM WAV) and `mux_video_audio()` (combine the rendered MP4 with the AAC-encoded audio in a second ffmpeg pass — preserves the video stream via `-c:v copy`, no re-encode). The pipeline class resolution chain prefers `diffusers.pipelines.ltx2.LTX2Pipeline` (returns `(video, audio)` tuple when `return_dict=False`), falls back to the upstream `ltx_video` library, then to the LTX-1 single-stream `LTXPipeline` as a last resort. The `_supports_audio` flag is set per pipeline class so the runner gracefully degrades on older installations.

**New request fields:**
- `enableAudio` (default true if CAP_AUDIO and pipeline supports it)
- `audioPrompt` (optional separate text prompt for the sonic character — falls back to the main prompt)
- `modalityScale` (default 3.0 — Wan-recommended; controls how tightly audio is synced to visual motion; 1.0 loose, 3.0+ tight)

**Manifest changes:** both `ltx-2-3-distilled.json` and `ltx-2-3-dev.json` now have `capabilities.audio: true` and a new `audio` block reporting `sampleRate: 44100`, `channels: 2`, `codec: "aac"`, `defaultModalityScale: 3.0`. The "wrapper doesn't yet wire it up" disclaimer is removed from both manifest notes.

**Behavior.** LTX-2.3 generates audio jointly with video from a shared latent representation — not a bolt-on audio model. Audio quality is best for ambient sound and foley (rain, wind, footsteps, environmental textures). For music generation, use `stable-audio-3`. For voice synthesis, use `kokoro-tts`. The capabilities endpoint reports `audio: CAP_AUDIO and video_runner._supports_audio` — only true when both the env flag and the installed library version support the dual-stream pipeline.

**Tests:** 35 → 49 unit tests. New coverage for `audio_to_wav_bytes()` (mono float, stereo [channels, samples] from LTX, clipped float values), `VideoGenerateRequest` with audio fields, and the `CAP_AUDIO=true` default.

**Cost lever.** Audio generation adds ~10-15% inference time over video-only. No additional VRAM cost (the audio stream shares 48 transformer blocks with the video stream via bidirectional cross-modal attention). On a 5-second clip from the distilled variant, the audio mux step itself is sub-second.

### `wanVideo.huggingfaceModel` recognized by `safebox-models fetch-install-manifest`

The CLI's HuggingFace repo resolution chain in `cli/safebox-models/commands.js` now recognizes the `wanVideo` runner-specific block alongside `stableAudio`, `ltxVideo`, `triposr`, `vllm`, `whisper`, `comfyui`, and `kokoro`. `safebox-models fetch-install-manifest --runner wan-video wan-2-2-ti2v-5b` calls HuggingFace's API at `https://huggingface.co/api/models/Wan-AI/Wan2.2-TI2V-5B-Diffusers/tree/main?expand=true`, extracts LFS oid SHA-256s, and writes a sibling `.install.json`. Same one-command UX as every other runner.

### LTX-Video runner shipped (June 29, 2026) — `model-runners/ltx-video/`

Video generation is no longer a catalog entry with no runner. `model-runners/ltx-video/` wraps Lightricks' [LTX-Video 2.3](https://github.com/Lightricks/LTX-Video) (Apache 2.0, March 2026 release, 22B-parameter base + 8B distilled variant) as a Safebox-canonical text-to-video and image-to-video service. Same architectural pattern as Kokoro and Stable Audio — single Python process, FastAPI on Unix socket, lazy library import.

**Why LTX-Video over alternatives.** In the 2026 open-source video landscape, LTX-Video is the only top-tier model that combines clean Apache 2.0 licensing (no Tencent Community License caveats), 16 GB VRAM minimum (fits on consumer GPUs), and fast inference (~20-40 seconds per 5-second clip on RTX 4090 with the distilled variant). HunyuanVideo has better facial detail but the license has restrictions; Wan 2.2 has higher quality but needs 24 GB+; CogVideoX has stronger prompt adherence but the 5B variant has license complications. For Safebox's "ships with the box, no licensing drama" pitch, LTX-Video wins.

**Component layout:**

```
model-runners/ltx-video/
├── README.md                      (~330 lines — architecture, deployment, illustrated explainer composition example)
├── Dockerfile                     (CUDA base, optional PREFETCH for ~24GB weight baking)
├── requirements.txt
├── runner.py                      (562 lines — FastAPI + LTX-Video library or Diffusers fallback)
├── test_runner.py                 (35 in-process tests, all passing)
└── manifests/
    ├── README.md                  (manifest schema + picking guide)
    ├── ltx-2-3-distilled.json     (8B distilled, 16GB VRAM, ~20-40s per 5s clip)
    └── ltx-2-3-dev.json           (22B base, 24GB+ VRAM, higher quality)
```

**Endpoint:** `POST /v1/video/generate` accepting `{ model, prompt, negativePrompt?, inputImage?, width?, height?, numFrames?, fps?, steps?, guidance?, seed?, outputMode? }`. Dimensions clamped to multiples of 32 (LTX requirement); frame counts clamped to form 8k+1. Text-to-video AND image-to-video — the `inputImage` field accepts a file path or a `data:` URL base64. Output is MP4 (h264 + yuv420p) via ffmpeg.

**Production discipline.** HMAC verification with timestamp + nonce + 5-minute replay window. Audit hashes on every response — `sourceSha256` over the canonical request (prompt + parameters + seed + whether an input image was used) and `outputSha256` over the MP4 bytes. `MAX_QUEUE_DEPTH=1` because video inference is slow enough (15-180 seconds) that queuing more requests creates pathological wait times — operators who need higher throughput run multiple containers behind a load balancer.

**What's deliberately deferred.** LTX-2.3's native audio path (the model can produce synchronized audio in one forward pass; the wrapper doesn't yet wire it up — `CAP_AUDIO=false`). Video-to-video (style transfer, editing). Frame-level progress events via SSE (would require pipeline modifications). MAX_QUEUE_DEPTH > 1 will be re-evaluated post-1.0 once the audio path lands and overall request times come down.

**Tests.** 35 in-process assertions covering model matching, input-image resolution (file path AND data: URL paths), HMAC sign/verify with replay protection, capacity hints (with the `MAX_QUEUE_DEPTH=1` edge case), Safebox header generation, Pydantic request defaults including the optional `inputImage` field, and configuration plumbing including the dimension/frame-count constraints. All passing.


### TripoSR runner shipped (June 29, 2026) — `model-runners/triposr/`

3D mesh generation is also no longer aspirational. `model-runners/triposr/` wraps [TripoSR](https://github.com/VAST-AI-Research/TripoSR) (Stability AI + Tripo AI, MIT) as a Safebox-canonical image-to-3D-mesh service. Single image in, textured 3D mesh out in under a second on a consumer GPU after a ~60-second cold start.

**Why TripoSR for v1.** Smallest disk footprint (~2 GB), smallest VRAM requirement (6 GB), fastest inference, and the cleanest MIT license among 2026's open-source 3D options. The output is vertex-colored meshes — fine for prototypes, game props, AR previews, and concept assets. For production game/film assets that need PBR materials (albedo/normal/roughness/metallic maps), a future runner directory for Hunyuan3D 2.1 is the right addition; that's a different library with a different inference shape, so it deserves its own runner. The Tencent Community License on Hunyuan3D also has commercial caveats that TripoSR's MIT avoids.

**Component layout:**

```
model-runners/triposr/
├── README.md                      (~220 lines — deployment, performance, text-to-3D via composition)
├── Dockerfile                     (CUDA base, build-essential for tsr's CUDA kernels)
├── requirements.txt
├── runner.py                      (~470 lines — FastAPI + tsr library)
├── test_runner.py                 (36 in-process tests, all passing)
└── manifests/
    ├── README.md                  (manifest schema + 2026 3D landscape comparison)
    └── triposr.json               (stabilityai/TripoSR, MIT, 6GB VRAM)
```

**Endpoint:** `POST /v1/3d/generate` accepting `{ model, inputImage, foregroundRatio?, meshResolution?, removeBackground?, format?, outputMode? }`. `inputImage` accepts file path or `data:` URL base64. `format` is `glb` (default, single binary file, ready for web/AR/game engines), `obj` (geometry + sibling MTL, broadly DCC-compatible), or `ply` (point-cloud-friendly, useful for further processing). Optional background removal via rembg is on by default.

**Production discipline.** Same HMAC + audit-hash plumbing as the other runners. `MAX_QUEUE_DEPTH=4` (much higher than the video runner because TripoSR inference is fast — ~1 second per mesh on a consumer GPU). Response includes vertex count, face count, and the file path or base64 of the exported mesh.

**Text-to-3D via composition.** TripoSR is image-only, but the runner README walks through chaining ComfyUI (text → image) → TripoSR (image → mesh) to get effective text-to-3D. Three runners in a chain, every step hash-attested. This pattern — "compose the protocol surface rather than build every variant" — is what makes the seven-runner ecosystem scale to ten use cases without ten more runners.

**Tests.** 36 in-process assertions covering model matching, input-image resolution from both file paths and data: URLs, HMAC sign/verify, capacity hints, Safebox headers, Pydantic request validation including the required `inputImage` field, and configuration plumbing. All passing.


### `fetch-install-manifest` CLI subcommand shipped (June 29, 2026) — `cli/safebox-models/`

Adds a new CLI verb that materializes a real install manifest from HuggingFace's API on demand:

```
safebox-models fetch-install-manifest whisper-large-v3-turbo
safebox-models fetch-install-manifest qwen-3-32b --revision main
safebox-models fetch-install-manifest custom-model --huggingface acme/custom-llm
```

**Why this is the right architecture.** Install manifests are the JSON files the System component validates against when downloading model weights — they list every file, every SHA-256, every source URL. Earlier in this project we considered shipping pre-baked install manifests for the catalog's 17 manifests, but those manifests would go stale within months (upstream repos add files, revise weights, get re-uploaded). The right design is: ship the runner manifests in the repo, materialize the install manifests at deploy time from the live HuggingFace API. The CLI now does both halves of that workflow:

```
safebox-models catalog                    → enumerate runner manifests in the repo
safebox-models fetch-install-manifest X   → pull HF tree, build install manifest with real SHA-256s
safebox-models install X                  → System verifies against the materialized manifest, installs
```

**Mechanism.** Uses Node's built-in `https` module (zero npm deps, consistent with the rest of the CLI) to call `https://huggingface.co/api/models/<repo>/tree/<rev>?expand=true`. The HF API returns file metadata including `lfs.oid` for LFS files — which is the SHA-256 of the actual file content. The CLI walks the tree, extracts those SHA-256s, fills in `sources` with the `https://huggingface.co/<repo>/resolve/<rev>/<path>` download URLs, and writes a sibling `.install.json` file next to the runner manifest. For non-LFS files (small JSON configs, READMEs) the SHA-256 isn't exposed by the API — those entries get a `__NEEDS_DOWNLOAD_AND_HASH__` placeholder which the operator can populate by running `make-install-manifest` against staged weights, or which the CLI's install path will refuse to accept (so a placeholder can never accidentally ship).

**HF repo resolution.** The CLI checks for the HF repo identifier in order: `--huggingface` CLI flag, the runner manifest's top-level `huggingfaceRepo` field, runner-specific blocks (`kokoro.huggingfaceRepo`, `stableAudio.huggingfaceModel`, `ltxVideo.huggingfaceModel`, `triposr.huggingfaceModel`, etc.), or a best-effort guess from the manifest's `homepage` URL if it points at huggingface.co. The lookup is robust without requiring a uniform field name across the 17 existing manifests.

**Same correctness story.** The `computeManifestHash()` over the materialized install manifest matches the System component byte-for-byte (the cross-check tests already in place still pass). M-of-N signers approve the manifest hash before production install, just as before. The materialization step doesn't bypass any safety check — it just removes the need to commit install manifests that would otherwise go stale.

This closes the loop on the third standing infrastructure item alongside the two new runners.

---

After this pass, the production protocol surface is **nine**: Privacy (`/v1/redact`), Documents (`/v1/extract`), LLM (`/v1/chat`, `/v1/complete`, `/v1/embed`), Transcription (`/v1/transcribe`), Image (`/v1/image/generate`), Speech (`/v1/speech`), Audio (`/v1/audio/generate`), Video (`/v1/video/generate`), and 3D (`/v1/3d/generate`). Every media type now has a working runner — text, image, audio, speech, transcription, video, 3D, documents, privacy — with a single consistent wire format, HMAC auth, audit-trail SHA-256 hashes, and a single CLI to install and manage them all. The Safebox 1.0 protocol surface is feature-complete.


### Stable Audio runner promoted from stub to production (June 29, 2026) — `model-runners/stable-audio-3/`

The Audio protocol now has a working runner. `model-runners/stable-audio-3/` was a stub through Week 5 — it had the runner contract, config loading, and weight-verification path but returned silent WAV placeholders. This pass replaces the stub with a full implementation wrapping [stable-audio-tools](https://github.com/Stability-AI/stable-audio-tools) (Stability AI's upstream library) to serve [Stable Audio Open](https://huggingface.co/stabilityai/stable-audio-open-1.0) — the Apache 2.0 open-weights release (distinct from the closed Stable Audio 3 / Stable Audio Pro commercial products despite the runner directory name).

**What replaced what.** Old stub preserved as `runner.py.stub-pre-v1.0`, `Dockerfile.stub-pre-v1.0`, `README.md.stub-pre-v1.0`, `requirements.txt.stub-pre-v1.0` so the diff is inspectable. New production files at the regular names.

**Component layout:**

```
model-runners/stable-audio-3/
├── README.md                      (~310 lines — architecture, deployment, "illustrated podcast" example)
├── Dockerfile                     (CPU + GPU base, optional PREFETCH for weight baking, ffmpeg installed)
├── requirements.txt
├── runner.py                      (544 lines — FastAPI + stable-audio-tools)
├── test_runner.py                 (35 in-process tests, all passing)
├── *.stub-pre-v1.0                (old stub files, kept for diff/history)
└── manifests/
    ├── README.md                  (manifest schema + picking guide)
    ├── stable-audio-open-small.json   (341M, 8-step pingpong, 11s clips)
    └── stable-audio-open-1.0.json     (1.21B, 100-step DPM++ 3M-SDE, 47s clips)
```

**Endpoints (Safebox canonical):** `POST /v1/audio/generate`, `GET /v1/capabilities`, `GET /v1/capacity`, `GET /v1/models`, `GET /health`. No streaming — diffusion is one-shot, so SSE wouldn't help. `CAP_STREAMING=False` advertised through `/v1/capabilities`.

**Two manifests, two use cases.** `stable-audio-open-small` is the fast variant: 341M parameters, 8 diffusion steps with pingpong sampler, clips up to 11 seconds, runs in ~3-5 seconds on consumer GPU. Right for voice-agent UI sounds and short SFX loops. `stable-audio-open-1.0` is the quality variant: 1.21B parameters, 100 steps with DPM++ 3M-SDE, clips up to 47 seconds, runs in ~15-90 seconds. Right for podcast intros, background music, longer ambient soundscapes.

**Apache 2.0, no commercial restrictions.** Both manifests serve Stable Audio Open variants released by Stability AI under Apache 2.0. Commercial use is unrestricted by the license — distinct from Stable Audio 3 / Stable Audio Pro (the closed commercial products which have no downloadable weights and aren't available through this runner regardless of directory name). The manifest README spells this out so no operator is confused by the historical naming.

**Production discipline.** Same HMAC verification with timestamp + nonce + 5-minute replay window as the other Safebox runners. Audit hashes on every response: `sourceSha256` over the canonical request (prompt + parameters + seed) and `outputSha256` over the audio bytes. With a fixed seed and deterministic sampler, regeneration produces byte-identical audio — hash-verifiable provenance from prompt to file. Capability flags advertised through `/v1/capabilities`: `text2audio` enabled, `audio2audio` and `inpaint` gated off (v1.0), `streaming` off (diffusion is one-shot).

**Tests.** 35 in-process assertions covering model matching (canonical name, upstream HF id, basename match), WAV header correctness (both mono fallback and stereo paths — Stable Audio outputs stereo `[channels, samples]`), audio format dispatch with ffmpeg fallback, HMAC sign/verify with replay protection, capacity hints (with the `MAX_QUEUE_DEPTH=2` edge case handled explicitly since audio gen is slower than the other runners), Safebox header generation, Pydantic request defaults, and configuration plumbing from environment variables. All passing.

**Composing example.** README walks through an "illustrated podcast" pipeline: vLLM writes a script, Kokoro narrates it, Stable Audio generates a 45-second background music bed. Six runners chained through `Protocol.X.Local()`, every step hash-attested, the whole pipeline runnable end-to-end on a single Safebox box with zero data leaving.

This brings the production protocol surface to **seven**: Privacy (`/v1/redact`), Documents (`/v1/extract`), LLM (`/v1/chat`, `/v1/complete`, `/v1/embed`), Transcription (`/v1/transcribe`), Image (`/v1/image/generate`), Speech (`/v1/speech`), Audio (`/v1/audio/generate`). The two remaining protocols in the catalog (video, 3D) are 1.1 territory — meaningfully larger efforts than what shipped here.


### Speech-TTS runner: Kokoro (June 28, 2026) — `model-runners/kokoro-tts/`

The Speech protocol now has a working runner. `model-runners/kokoro-tts/` wraps [Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache 2.0, the open-source TTS default for 2026 — see TTS Arena rankings) as a Safebox-canonical FastAPI service. Single-process design (no supervisord) since Kokoro is small enough to load in-process via lazy import.

**Why Kokoro.** Apache 2.0 with no commercial restrictions (unlike Fish Audio S2 Pro which is open-weights-paid-commercial, or VibeVoice which is research-grade with watermarks). 82M parameters means it runs on CPU at ~5-15× real-time on an 8-core laptop and ~80-210× on a consumer GPU. Bundles ~28 American/British English voices in the default manifest; a multilingual variant covers Japanese, Mandarin, French, Hindi, Italian, Portuguese (BR) with ~23 more voices. The right v1.0 default — adding Chatterbox-Turbo (for voice cloning) or Dia2 (for dialogue) as separate runners is clean post-1.0 work.

**Component layout:**

```
model-runners/kokoro-tts/
├── README.md             (~340 lines — architecture, deployment, voice-agent pipeline example)
├── Dockerfile            (CPU and GPU base, optional PREFETCH for weight baking, espeak-ng + ffmpeg installed)
├── requirements.txt
├── runner.py             (~600 lines — FastAPI + Kokoro wrapper, streaming SSE)
├── test_runner.py        (in-process tests — 41 assertions, all passing)
└── manifests/
    ├── README.md         (manifest schema; Kokoro = one model with many voices)
    ├── kokoro-82m.json   (American + British English, ~28 voices)
    └── kokoro-82m-multilingual.json   (Japanese/Mandarin/French/Hindi/Italian/Portuguese-BR, ~23 voices)
```

**Endpoints (Safebox canonical):** `POST /v1/speech`, `GET /v1/voices`, `GET /v1/capabilities`, `GET /v1/capacity`, `GET /v1/models`, `GET /health`. `/v1/speech` supports `stream: true` for SSE — Kokoro splits text on punctuation internally, so streaming sentences arrive as audio chunks for early playback in long-form scenarios (audiobook narration, agent responses).

**Output modes.** WAV (always), MP3 and OGG via ffmpeg in the container. Audio either written to `/data/output/<prefix>-<hash>.wav` (default — Safebox plugin creates `Streams/audio` from the path) or returned inline as base64.

**Production discipline.** Same HMAC verification with timestamp + nonce + 5-minute replay window as the other Safebox runners. Audit hashes on every response: `sourceSha256` of the input text bytes, `outputSha256` of the audio bytes. Kokoro is deterministic given fixed (text, voice, speed) — same inputs reproduce byte-identical audio, making the hashes useful for proving what audio came from what text on a specific date. Capability flags advertised through `/v1/capabilities`: `voiceClone` is gated off (Kokoro is fixed-voice), `emotion` gated off (Kokoro doesn't expose style controls), `streaming` enabled.

**Voice-agent pipeline.** With Kokoro added, the four-runner composition (Whisper → privacy-filter → vLLM → ComfyUI) becomes a five-runner voice-agent loop: user audio → Whisper transcription → privacy-filter redaction → vLLM response → Kokoro speech back. The README has a full code example showing the round-trip with audit-log integration; every step records `sourceSha256` + `outputSha256` for compliance review. End-to-end conversational AI on a single Safebox box, zero data leaving.

**Tests.** 41 in-process assertions covering model matching, WAV header correctness (validates the byte layout: RIFF magic, WAVE identifier, fmt chunk, sample rate, channel count, sample width, frame count), audio format dispatch with ffmpeg fallback to WAV, HMAC sign/verify with replay protection, capacity hints, Safebox header generation, Pydantic request defaults, voice fallback list population (American + British male + female), and configuration plumbing from environment variables. All passing.

This brings the production protocol surface to **six**: Privacy (`/v1/redact`), Documents (`/v1/extract`), LLM (`/v1/chat`, `/v1/complete`, `/v1/embed`), Transcription (`/v1/transcribe`), Image (`/v1/image/generate`), Speech (`/v1/speech`). The five remaining protocols in the catalog (audio music/SFX, video, 3D) are 1.1 territory. Week 5 of the runner roadmap complete.


### Operator CLI: safebox-models — production ready (June 28, 2026) — `cli/safebox-models/`

The "dnf-like" experience layer Greg asked about. Wraps the System component's HMAC-gated `/models/install`, `/models/list`, `/models/<hash>/verify`, `/models/<hash>/remove` endpoints with a one-command-per-action operator UX. Also supports `--local` mode for development / single-operator deployments where the System component isn't running and weights are pre-staged.

**Component layout:**

```
cli/safebox-models/
├── README.md             (~280 lines — operator-facing guide, every command + option)
├── safebox-models        (executable Node.js script; the entrypoint)
├── commands.js           (subcommand handlers: catalog, show, list, install, verify, remove, doctor, make-install-manifest)
├── lib/
│   ├── util.js           (canonicalize, computeManifestHash, HMAC signing, fmt helpers, prompts)
│   ├── catalog.js        (scans model-runners/*/manifests/ for runner manifests + sibling .install.json)
│   └── api.js            (HTTP client for the System component, handles HMAC headers)
└── test/
    └── test-cli.js       (52 assertions, all passing)
```

**Commands.** `catalog` lists every manifest the CLI can see, grouped by runner, flagged for install-manifest availability. `show <name>` prints details. `list` lists installed models (talks to System component, or to `/srv/safebox/models/` with `--local`). `install <name>` is the headline: reads the install manifest, computes the canonical hash, HMAC-signs the request, POSTs to System component, stages the runner config. `verify <name>` re-hashes installed weights. `remove <name>` uninstalls. `doctor` diagnoses common setup issues (Infrastructure repo location, HMAC key presence, System component reachability, models dir state). `make-install-manifest <name> <weights-dir>` walks a directory of staged weights and emits a skeleton install manifest with computed SHA-256s.

**Critical correctness check.** The CLI's `canonicalize()` and `computeManifestHash()` must produce byte-identical output to the System component's at `aws/scripts/components/system/opsModels.js`. If they diverge, every install fails with `MANIFEST_HASH_MISMATCH`. The unit test loads both modules and cross-checks 20 canonicalization cases (null, bools, ints, strings with unicode and escapes, arrays, nested objects, full manifest shapes) plus a realistic manifest hash agreement. All 20 produce the same output; the manifest hash matches to the byte. **The install path is wire-compatible.**

**Zero external dependencies.** Node.js 18+ built-in modules only — `crypto` for hashing and HMAC, `http` for the System component calls, `fs` for catalog scanning, `readline` for prompts, `path` for paths. No npm install, no package.json. The CLI directory can be symlinked into `/usr/local/bin/` and works.

**Operator UX wins.** Before: hand-roll HTTP requests with `openssl dgst` for HMAC, compute manifest hashes via raw Node one-liners against the System component's source, construct the install body in `cat <<EOF` blocks. After: `safebox-models install qwen-3-32b`. Confirmation prompts before destructive actions, `--yes` for scripts, `--json` for machine consumers, `--local` for dev, helpful errors that name the next step.

**Tests.** 52 in-process assertions covering canonicalize() cross-check against the System component (20 cases), HMAC header format, byte formatting, type rejection, catalog scanning against the live repo (13 manifests across vllm/whisper/comfyui/mineru), and walkAndHash on temp directories. All passing.

This completes the operator surface for Weeks 1-3. The five production runners (privacy-filter, mineru, vllm, whisper, comfyui) plus the CLI mean a tenant can deploy a Safebox, discover available models with `safebox-models catalog`, install them with `safebox-models install`, and start serving with a single `docker run`. Week 4 of the runner roadmap complete.


### ComfyUI image generation runner — production ready (June 28, 2026) — `model-runners/comfyui/`

The Image protocol now has a working runner. `model-runners/comfyui/` wraps [ComfyUI](https://github.com/comfyanonymous/ComfyUI) as a Safebox-canonical FastAPI service. The wrapper translates simple Safebox text-to-image requests into ComfyUI workflow graphs (loaded from per-family JSON templates), submits to ComfyUI's `/prompt` endpoint, polls `/history` for completion, fetches the resulting images via `/view`, and returns either a file path (default) or inline base64.

**Component layout:**

```
model-runners/comfyui/
├── README.md             (~440 lines — architecture, deployment, licensing rules)
├── Dockerfile            (CPU and GPU base, ComfyUI cloned at build time, ARG-pinned)
├── requirements.txt
├── runner.py             (~675 lines — FastAPI + workflow translation + polling)
├── start.sh              (manifest resolver + supervisord launcher)
├── supervisord.conf      (ComfyUI + wrapper as managed processes)
├── test_runner.py        (in-process tests — 53 assertions, all passing)
├── workflows/
│   ├── sdxl-text2image.json    (SDXL workflow: KSampler + CheckpointLoaderSimple)
│   └── flux-text2image.json    (FLUX workflow: KSampler + UNETLoader + VAELoader + DualCLIPLoader + FluxGuidance)
└── manifests/
    ├── README.md         (manifest schema + commercial-license reference table)
    ├── sdxl-base-1.0.json      (OpenRAIL++-M, commercial OK)
    ├── flux-1-schnell.json     (Apache 2.0, commercial OK, 4-step distilled)
    └── flux-1-dev.json         (Non-Commercial — flagged with paid BFL license requirement)
```

**Endpoints (Safebox canonical):** `POST /v1/image/generate`, `GET /v1/capabilities`, `GET /v1/capacity`, `GET /v1/models`, `GET /health`. Output as file path (default — image written to `/data/output/` for the Safebox plugin to consume) or base64 inline.

**Per-family workflow templates.** SDXL uses a single `CheckpointLoaderSimple` (one self-contained `.safetensors`). FLUX uses separate `UNETLoader` + `VAELoader` + `DualCLIPLoader` (multiple files in different ComfyUI subdirectories) plus a `FluxGuidance` node for distilled guidance. The wrapper loads the template, substitutes user values at known node IDs, and submits. Adding a new architecture (Wan, HiDream, Sana) means adding a new template + a `populate_<family>_workflow` function.

**License-aware manifests.** Image-generation models have wildly inconsistent licenses. The shipped manifests flag this explicitly: SDXL Base 1.0 is OpenRAIL++-M (commercial OK), FLUX.1 schnell is Apache 2.0 (commercial OK), FLUX.1 dev is Non-Commercial (requires a paid Black Forest Labs license for production use, with the URL referenced in the manifest). The runner does not enforce license terms; the operator does. The manifest README includes a reference table covering SD 1.5/SDXL/SD 3.5/FLUX.1/FLUX.2 with commercial-use status.

**Production discipline.** Same HMAC verification with timestamp + nonce + 5-minute replay window as the other Safebox runners. Audit hashes on every response (`sourceSha256` of the JSON body — covers prompt + parameters + seed; `outputSha256` of the concatenated image bytes). Capability enforcement: only `text2img` is implemented for v1.0; `img2img`, `inpaint`, `controlnet`, and `lora` flags exist in the protocol but return 400. Capability flags advertised through `/v1/capabilities` so clients learn what's available.

**Tests.** 53 in-process assertions covering model matching, workflow template loading (SDXL and FLUX, with deep-copy cache verification), SDXL workflow population (CFG, steps, seed, checkpoint, prompts), FLUX workflow population (UNET/VAE/CLIP names from env, FluxGuidance node, defaults when omitted, random seed generation), output extraction from history responses, HMAC verification with replay protection, capacity hints, Safebox header generation, and Pydantic request defaults. All passing.

This brings the production protocol surface to five: Privacy (`/v1/redact`), Documents (`/v1/extract`), LLM (`/v1/chat`, `/v1/complete`, `/v1/embed`), Transcription (`/v1/transcribe`), Image (`/v1/image/generate`). The five-runner composition pattern is now end-to-end: a tenant can extract a PDF, transcribe its audio attachments, redact PII, generate a summary, and generate an illustrative cover image — all locally on a Safebox box with zero data leaving. Week 3 of the runner roadmap complete.


### Whisper transcription runner — production ready (June 28, 2026) — `model-runners/whisper/`

The Transcription protocol now has a working runner. `model-runners/whisper/` wraps [Faster-Whisper](https://github.com/SYSTRAN/faster-whisper) (CTranslate2-based, ~4× faster than the reference Whisper implementation) as a Safebox-canonical FastAPI service. Faster-Whisper runs in-process — no separate inference server, no supervisord — because Whisper models are small enough to load in seconds rather than minutes. Closer to the `mineru` pattern than the `vllm` one.

**Component layout:**

```
model-runners/whisper/
├── README.md             (~440 lines — architecture, deployment, meeting-summary pipeline example)
├── Dockerfile            (CPU and GPU base both supported via BASE build-arg, optional PREFETCH for weight baking)
├── requirements.txt
├── runner.py             (~650 lines — FastAPI + Faster-Whisper wrapper, streaming via SSE)
├── test_runner.py        (in-process tests — 33 assertions, all passing)
└── manifests/
    ├── README.md         (manifest schema for the Whisper variants)
    ├── whisper-large-v3-turbo.json    (the production default — multilingual, ~4-8x RTF)
    ├── whisper-large-v3.json          (full accuracy; the only one that supports translation)
    ├── whisper-medium.json            (laptop-friendly, int8_float16)
    ├── whisper-small.json             (CPU-only, int8)
    └── distil-whisper-large-v3.json   (English-only, fastest English throughput)
```

**Endpoints (Safebox canonical):** `POST /v1/transcribe`, `POST /v1/transcribe/batch`, `GET /v1/capabilities`, `GET /v1/capacity`, `GET /v1/models`, `GET /health`. `/v1/transcribe` supports `stream: true` for SSE — segments arrive as Faster-Whisper produces them, useful for long audio (meetings, podcasts) where the UI displays progress.

**Manifest-driven model loading.** Same "one container, one manifest, one model" pattern as the vLLM runner. The five included manifests cover the size/speed spectrum: large-v3-turbo as the production default (multilingual, 4-8× realtime on consumer GPU), large-v3 when you need audio→English translation (Turbo was distilled without translation data), medium for laptops without GPUs, small for pure CPU deployment, distil-large-v3 for English-only at maximum throughput.

**Production discipline.** HMAC verification with timestamp + nonce + 5-minute replay window (gated on `SAFEBOX_REQUIRE_HMAC=true`, off by default for local dev). Audit hashes on every response — `sourceSha256` of the input audio bytes and `outputSha256` of the transcript text. Capability enforcement: `task=translate` returns 400 if the manifest sets `capabilities.translate=false`. Diarization gated off entirely (post-1.0 — would need pyannote.audio or NVIDIA Parakeet).

**Privacy.** Source audio mounted read-only into the container at `/data/`. Network sources (`s3://`, `http://`, `https://`, `gs://`) refused explicitly — stage the file into the Safebox first. Local files only for v1.

**Tests.** 33 in-process assertions covering model matching, source resolution (file:// URLs, absolute paths, network URL rejection, missing file rejection), SHA-256 hashing, HMAC sign/verify with replay protection, capacity hints, Safebox header generation, and Pydantic request validation. All passing.

This brings the production protocol surface to four: Privacy (`/v1/redact`), Documents (`/v1/extract`), LLM (`/v1/chat`, `/v1/complete`, `/v1/embed`), Transcription (`/v1/transcribe`). The three-runner document-Q&A pipeline (MinerU → privacy-filter → vLLM) now extends to a four-runner meeting-summary pipeline (Whisper → privacy-filter → vLLM). Week 2 of the runner roadmap complete.


### vLLM runner — production ready (June 28, 2026) — `model-runners/vllm/`

The LLM protocol now has a working runner. `model-runners/vllm/` is a single-container Docker image that runs vLLM and a Safebox-canonical protocol wrapper side-by-side under supervisord. The wrapper translates between Safebox's camelCase / Unix-socket / HMAC-signed wire format and vLLM's OpenAI-compatible HTTP server, adding streaming SSE support, audit-trail SHA-256 hashes on every response, and capability enforcement driven by the per-model manifest.

**Component layout:**

```
model-runners/vllm/
├── README.md             (~380 lines — architecture, deployment patterns, comparison to cloud APIs)
├── Dockerfile            (CPU and GPU base both supported via BASE build-arg)
├── requirements.txt
├── runner.py             (~770 lines — FastAPI wrapper, Safebox ↔ OpenAI translation)
├── start.sh              (manifest resolver + supervisord launcher)
├── supervisord.conf      (vLLM + wrapper as managed processes)
├── test_runner.py        (in-process tests — 41 assertions, all passing)
└── manifests/
    ├── README.md         (manifest schema and walk-through)
    ├── llama-3.3-70b-instruct.json
    ├── qwen-3-32b.json
    ├── mistral-small-3.json
    ├── gemma-3-12b-it.json
    └── deepseek-v3.json
```

**Endpoints (Safebox canonical):** `POST /v1/chat`, `POST /v1/complete`, `POST /v1/embed`, `GET /v1/capabilities`, `GET /v1/capacity`, `GET /v1/models`, `GET /health`. Chat and complete support streaming via `stream: true` (SSE response with re-translated chunks).

**Manifest-driven model loading.** The deployment unit is "one container, one manifest, one model." A manifest is a single JSON file describing the model name, vLLM launch args (tensor-parallel size, max context length, dtype, quantization, gpu memory utilization, trustRemoteCode), capability flags, and resource hints. The five included manifests cover the main open-source families: Llama 3.3 70B, Qwen 3 32B, Mistral Small 3, Gemma 3 12B, DeepSeek V3. Adding GLM 5.2, Kimi K2, MiniMax M3 etc. is a one-file addition once a deployment picks specific TP size and quantization.

**Production discipline.** HMAC verification with timestamp + nonce + 5-minute replay window (gated on `SAFEBOX_REQUIRE_HMAC=true`, off by default for local dev). Audit hashes on every non-streaming response (sourceSha256 of the request body, outputSha256 of the response content). Capability enforcement at the wrapper layer — `/v1/embed` returns 400 if the manifest's `capabilities.embed` is false, even if vLLM itself supports it on the loaded model. Three Safebox runners (privacy-filter, mineru, vllm) now compose through `Protocol.X.Local()` for end-to-end document-Q&A pipelines.

**Tests.** 41 in-process assertions covering Safebox→OpenAI translation, OpenAI→Safebox translation, HMAC sign/verify with replay protection, capacity hint calculation, and Safebox header generation. All passing.

This brings the production protocol surface to three: Privacy (`/v1/redact`), Documents (`/v1/extract`), LLM (`/v1/chat`, `/v1/complete`, `/v1/embed`). Week 1 of the runner roadmap complete.

### Spelling refresh — Safecloud (June 22, 2026)

Renamed `SafeCloud` to `Safecloud` throughout the Infrastructure repo to match the `Safebox` capitalization convention (one capital, not CamelCase). Affects: README.md, docs/ZFS-BACKUP-ARCHITECTURE.md, docs/WHY-ZFS-IS-AMAZING.md, docs/COMPLETE-ARCHITECTURE.md. Same change applied to the pitch HTML in the safebox-stack repo.


### Model catalog refresh — GLM 5.2 (June 22, 2026)

Replaced the GLM-5.1 entry in `docs/MODEL-CATALOG.md` Tier 1 with the GLM 5.2 release from June 13. Verified architecture and benchmark numbers against Z.ai's official GitHub (`zai-org/GLM-5`), VentureBeat coverage, Fireworks' model listing, Artificial Analysis, and the multiple independent reviews that landed in the week after release.

Key facts captured:

- **Architecture:** Mixture-of-Experts, ~753B total parameters, ~40B active per token. New **IndexShare** sparse-attention technique reuses one indexer across every four layers, cutting per-token FLOPs by ~2.9× at the full 1M-token context. Improved Multi-Token Prediction layer for speculative decoding (~20% longer accepted chains). Selectable "Thinking Modes" (Max default, High).
- **Context:** 1,000,000 tokens — a 5× jump from GLM-5.1's 200K, with 131,072 max output.
- **License:** MIT. Weights on HuggingFace under the `zai-org` organization.
- **Self-hosting:** Full precision is ~1.5 TB of GPU memory (reference: 8× H200 with tensor parallelism). Unsloth's 1-bit GGUF runs ~21.6 tok/s on a Mac Studio M3 Ultra 256 GB — viable on consumer hardware for the smallest quantization.
- **Benchmarks:** SWE-bench Pro 62.1 (beats GPT-5.5's 58.6, behind Opus 4.8's 69.2). Terminal-Bench 2.1 at 81.0 vs Opus 85.0. FrontierSWE 74.4% vs Opus 75.1%. Design Arena #1 with 1360 ELO, edging Claude Fable 5.
- **Pricing (Z.ai cloud, not used by Safebox):** $1.40 / $4.40 per million input/output tokens — roughly one-sixth of GPT-5.5's blended cost. GLM Coding Plan from $10/$30/$80 per month tiers.

**Entity List note.** Zhipu AI was added to the US BIS Entity List in January 2025. The MIT-licensed weights are still fully usable — self-hosted GLM 5.2 on a Safebox has no data flow to Z.ai's infrastructure. The cloud API does and carries the data-jurisdiction considerations of any Chinese AI service. Safebox's local-execution stance sidesteps this; the catalog entry flags both routes explicitly so a tenant chooses with full information.

This is in addition to the existing roster pointer on `safebox-stack.html` slide 12, where GLM 5.2 has been listed alongside DeepSeek V4-Pro, Kimi K2.6, MiniMax M3, and Gemma 4 since the Vicki Boykis / Gemma 4 update.

### Documents protocol (June 22, 2026) — `model-runners/mineru/`

New model runner for the Documents protocol: PDF / DOCX / PPTX / XLSX / scanned images into LLM-ready Markdown and JSON. Wraps [opendatalab/MinerU 2.5](https://github.com/opendatalab/MinerU) (Shanghai AI Laboratory / OpenDataLab, Apache 2.0) as a Safebox-canonical FastAPI service.

**Why it's in the roster.** Document extraction has been a per-vendor mess for decades — Adobe Acrobat Pro at $239.88/yr still loses merged table cells, ABBYY FineReader at $165/yr can't handle equations, and the cloud OCR services (Mistral at $2 per 1,000 pages, Azure / Google) all charge per page forever AND ship every document offsite. MinerU is the first open-source extractor that matches commercial quality on tables, formulas, multi-column reading order, and scanned input across 109 languages, with two technical reports backing it on arXiv (the v1 paper, and the September 2025 MinerU 2.5 paper introducing the decoupled vision-language backend).

**Two backends.** `pipeline` (default) — modular: layout detection, OCR, formula recognition, table parsing — fast, ~6 GB GPU. `vlm` — single end-to-end vision-language model, ~16 GB GPU, higher fidelity on hard documents. Switch at container start via `MINERU_BACKEND`.

**Component layout.**

```
model-runners/mineru/
├── README.md          (~320 lines — Safebox integration patterns, comparison)
├── Dockerfile         (CPU and GPU base both supported via BASE build arg)
├── requirements.txt
└── runner.py          (~460 lines: FastAPI on Unix socket, HMAC verify, audit-trail SHA-256)
```

**Endpoints (Safebox-canonical).** `POST /v1/extract`, `POST /v1/extract/batch`, `GET /v1/capabilities`, `GET /v1/capacity`, `GET /health`.

**Audit semantics.** Every extraction request hashes the source file's bytes and the output Markdown / JSON. Both SHA-256s are returned in the response and logged. The pipeline backend is deterministic: same input bytes + same model version → same output bytes, so the audit trail re-runs cleanly from cold input months later.

**Privacy.** Documents are mounted read-only into the container; no network egress except the Unix socket; cloud `mineru.net` SDK explicitly not wired in. Adds a Documents protocol row to `docs/MODEL-CATALOG.md`.

### Compression levers (June 22, 2026) — `levers/compression/`

New `levers/` directory holding operational toggles that change Safebox runtime behavior without forking the AMI build. The first set covers database compression in two independently togglable layers.

**Layer 1 — ZFS zstd-3** (`lever-zfs-compression.sh`):
Switches the MariaDB data dataset from the LZ4 default to ZSTD-3. Truly transparent — no application code changes, no SQL changes. Expected ~3-4x compression on the mix of JSON, indexes, undo, redo, and binlogs. New writes are compressed immediately; existing pages compress lazily as InnoDB rewrites them. Reversible via `apply --level=lz4` or `revert`.

**Layer 2 — zstd dictionary compression** (`lever-zstd-dict.sh`):
Installs the toolchain for trained-dictionary compression of `streams_message.instructions` specifically. Three components ship together:

- A MariaDB UDF (`udf/streams_compress.c`, ~330 lines C) exposing `streams_zcompress(text, version)` and `streams_zuncompress(blob)` so ad-hoc SQL can decode without going through the framework.
- A Qbix PHP hook (`qbix/Streams_Message_Compression.php`) that wraps `Streams_Message::save()` and `::retrieve()` so the application sees plain JSON in and out.
- A dictionary directory layout (`/safebox/dicts/streams_instructions-vN.zdict`) with version-tagged blobs so old rows decode against the dictionary that produced them, forever.

The installer (`lever-zstd-dict.sh apply`) handles libzstd, php-zstd via pecl, builds the UDF against the local MariaDB headers, registers the functions, creates the dict directory with mysql ownership, and stages the hook to `/opt/safebox/hooks/`. Training a dictionary is a userland step documented in `qbix/README.md`.

**Expected ratios** on Qbix `streams_message.instructions` blobs (heavy JSON repetition): 8-12x in production typical, 15-17x on tight clusters with low entropy. Roundtrip-verified against synthetic Hebrews-pattern data at 17.35x with a 32KB dictionary trained on 500 samples.

Both layers ship with `status.sh` for read-only inspection of what's active.

### System component (May 20, 2026) — Node.js HTTP API with HMAC

The privileged-operations interface for Safebox is now a small Node.js HTTP API listening on `127.0.0.1:7780`. Safebox Node sends HMAC-signed JSON; the System component validates, dispatches to `child_process.execFile`, and returns the result.

This replaces both (a) the 1577-line Node daemon that existed at the start of this sprint AND (b) the ~1000-line shell-and-systemd component we briefly built as an alternative. The System component is smaller than either, and the shape matches what Safebox actually wants on the client side.

**Component layout:**

```
aws/scripts/components/system/
├── install-system.sh             (~124 lines)
├── server.js                      (~239 lines, HTTP routing + HMAC verify + audit)
├── auth.js                        (~105 lines, HMAC sign/verify + nonce LRU)
├── secret.js                      (~115 lines, TPM-derived or random fallback)
├── config.js                      (~105 lines, managed-containers.json loader)
├── opsSystem.js                  (~309 lines, /system handler — execFile for 9 tools)
├── opsTest.js                    (~372 lines, /test handlers + keepalive + yields)
├── package.json                   (zero npm dependencies)
├── units/safebox-system.service
└── sudoers/safebox-system        (the entire privileged surface — ~20 lines of rules)
```

~1100 lines of Node + ~50 lines of sudoers. The System component itself runs as unprivileged `safebox-infra` user. Privileged ops (dnf, zfs, docker) elevate via sudo against the tight allowlist in `/etc/sudoers.d/safebox-system`. That sudoers file is what an auditor reads to know exactly what the System component can do.

**What changed for Safebox:**

- The wire is HTTP on `127.0.0.1:7780` with HMAC-SHA-256 over a canonical envelope. No more request-files-in-/run/safebox/jobs, no systemctl invocation, no polkit.
- Two endpoint families: `POST /system` (synchronous: blocks until npm/git/dnf/etc. finish) and `POST /test/*` (async lifecycle with keepalive every 30s, ring-buffered yields, aggressive 60s teardown by default).
- `managed-containers.json` (already in the repo) is the authorization config. Each container declares `allowedActions` and an `imagePattern`. The System component enforces both.
- Field validation regexes are unchanged from the prior shell-component spec.
- See `aws/docs/SYSTEM-PROTOCOL.md` for the full protocol Safebox programs against.

**HMAC secret:** stored at `/etc/safebox/system.hmac` (mode 0640, group `safebox-infra-readers`). The System component derives the secret from the TPM event log via HKDF-SHA-256 on first boot (bound to measured boot state), falling back to existing on-disk bytes or random 32 bytes if TPM isn't available. The fallback path logs WARN loudly so operators notice if attestation isn't binding the key.

**Smoke tests passing:**
- HMAC verify on every request (T1 valid, T2 invalid → 401)
- Routing (T4 unknown endpoint → 404)
- Container authorization (T5 unknown container, T6 action not in allowedActions → 403)
- Argument injection defense (T7 `--registry=evil.com` package name rejected)
- Workspace prefix enforcement (T9 `/etc` rejected)
- Image pattern enforcement (T10 wrong-pattern image → IMAGE_NOT_ALLOWED)
- Test lifecycle (T11 unknown test → 404)
- Happy-path execFile reaches the underlying tool (T8 npm list)

**Why this shape:**

The earlier shell-and-systemd component was correct but ate too much auditor time: ~1000 lines of bash that someone has to read in detail. The Node System component is denser (~1100 lines of focused Node) but uses idioms most reviewers already know, and the privileged-surface check collapses to one sudoers file plus one Node file (`opsSystem.js`). The HMAC layer adds defense in depth against in-PHP application bugs that don't escalate to full apache RCE — a SQL injection in a Safebox PHP plugin can't forge a System component request because the HMAC key lives in Safebox Node's process memory, not in PHP's.

The trust boundary is explicit and documented in `SYSTEM-PROTOCOL.md` § "Out of scope for 1.0": if Safebox Node itself is compromised, the System component will execute what it's asked. M-of-N governance is inside Safebox and runs before the call. Per-request governance signatures (Ed25519) are the documented upgrade path for 1.1.

### Earlier in this sprint (May 20, 2026)

A shell-and-systemd system component was built and then replaced by the Node System component above. The shell version is preserved in git history (commits `3f67cc9`, `acc5ebe`, `35e6f99`) for anyone evaluating the alternatives.

### Security audit (May 13, 2026) — `install-base.sh`

Pre-release security pass on the base AMI installer identified ten issues. All fixed in the current `install-base.sh`.

- **Infrastructure Bug 1** — Missing directory creation. The script ran `cd /opt/safebox` and `cat > /opt/safebox/manifests/base.json` without ever creating `/opt/safebox` or `/opt/safebox/manifests/`. On a clean install, the script failed partway through. Now creates `/opt/safebox`, `/opt/safebox/manifests`, `/opt/safebox/lib`, and `/srv/safebox/runtimes/system/` with explicit `mkdir -p` and proper permissions before anything tries to write into them.

- **Infrastructure Bug 2** — ZFS pool assumed to exist. The script created datasets on `safebox-pool` without verifying the pool itself was provisioned. Now fails fast with a clear error message and pool-creation instructions if `zpool list safebox-pool` doesn't find it.

- **Infrastructure Bug 3** — Unpinned npm install. The previous version ran `npm install --production <packages>` which pulls the latest version of each, making the build non-reproducible and exposing it to supply chain attacks (e.g. the TanStack / "Mini Shai-Hulud" campaign of May 2025). Now uses `npm ci --production --ignore-scripts` against a checked-in `package-lock.json` with integrity hashes for every tarball. `--ignore-scripts` blocks lifecycle scripts (the specific TanStack attack vector — postinstall hooks that modified `.claude/settings.json` and `.vscode/tasks.json`).

- **Infrastructure Bug 4** — Unpinned dnf packages. The previous version ran `dnf install -y mariadb105-server php-fpm nginx docker-ce nodejs npm zfs` without version pins, so the build was non-reproducible. Now uses an explicit `SYSTEM_PACKAGES` array with versioned package specs, plus a post-install verification loop that fails the build if any package's installed version doesn't match the pin.

- **Infrastructure Bug 5** — Interactive shell access defeats the attestation model, but the prior installer permitted it. The docs claimed telnetd was removed via `finalize-ami3.sh`, but no such script existed in the repo, and even the docs only addressed telnetd while leaving SSH and the AWS SSM agent in place. SSH and SSM Session Manager are both remote-shell mechanisms; once any human has a shell, they can read `/run/safebox/zfs-key` from memory, `kexec` a new kernel, or modify a running binary — and TPM attestation says nothing about what processes do after boot. The installer now removes ALL interactive-shell paths in four tiers:
  - **Tier 1** — Legacy daemons: `telnet`, `telnet-server` (CVE-2026-32746), `rsh`, `rsh-server`, `rlogin`, `vsftpd`, `proftpd`, `tftp`, `tftp-server`, `cockpit`, `cockpit-ws`, `cockpit-bridge`, `webmin`
  - **Tier 2** — SSH: `openssh-server`, `openssh-clients`, `openssh`
  - **Tier 3** — AWS SSM: `amazon-ssm-agent` (the agent is a shell-spawning mechanism just like sshd; removing it does NOT remove IAM-role-based AWS API access, which goes through instance metadata, not the SSM agent)
  - **Tier 4** — TTY/console getty: `getty@.service`, `serial-getty@ttyS0.service`, `debug-shell.service` masked
  Plus socket-unit masking for tiers 1–3 to prevent reactivation by future package updates, plus a post-removal verification gate that checks `command -v sshd`, `rpm -q amazon-ssm-agent`, and that no process is listening on ports 22, 23, 513, 514, 5985, or 5986. If any verification fails, the AMI build aborts. Operationally this means diagnostics happen against an offline ZFS snapshot of a terminated instance, not on a live shell — see `docs/SECURITY-HARDENING.md` for the full operational model.

- **Infrastructure Bug 6** — Node.js version unpinned. `dnf install nodejs` could install Node 18, 20, or 22 depending on mirror state at build time. Now pinned to `nodejs-20.18.0` as part of the `SYSTEM_PACKAGES` array. Updates documented inline.

- **Infrastructure Bug 7** — Docker daemon defaults. Containers run as host root by default without explicit user-namespace remapping. Now writes `/etc/docker/daemon.json` with:
  - `userns-remap=default` (containers run as host UID 100000+ instead of UID 0)
  - `no-new-privileges=true`
  - `icc=false` (containers can't talk to each other on the default bridge)
  - `storage-driver=zfs` with explicit fsname
  - Log rotation caps (100 MB × 5 files)
  - Creates the required `dockremap` user/group

- **Infrastructure Bug 8** — PHP-FPM defaults. `php-fpm` installed with `expose_php=On` (PHP version leaked in HTTP headers) and `allow_url_fopen=On` (PHP could `file_get_contents('http://attacker.com/...')` directly, bypassing the Safebox Protocol.HTTP layer's SSRF protections). Also no `disable_functions`. Now:
  - `expose_php=Off`
  - `allow_url_fopen=Off`
  - `allow_url_include=Off` (defense in depth)
  - `disable_functions = exec, passthru, shell_exec, system, proc_open, popen, curl_multi_exec, parse_ini_file, show_source, dl, phpinfo`

- **Infrastructure Bug 9** — ZFS encryption misconfiguration. `zfs create -o encryption=on` without `keyformat` or `keylocation` either fails or falls back to interactive passphrase mode that breaks unattended builds. Now uses `encryption=aes-256-gcm`, `keyformat=raw`, and `keylocation=file:///run/safebox/zfs-key`. The key file is generated by `scripts/generate-attested-key.sh` (sealed to TPM PCRs) BEFORE `install-base.sh` runs. The installer fails fast if the key file is missing.

- **Infrastructure Bug 10** — No auditd configuration. The base installer didn't enable kernel-level audit logging for security-sensitive events. Now writes `/etc/audit/rules.d/safebox.rules` covering:
  - ZFS key file access (`safebox_zfs_key`)
  - Package manager invocations (`safebox_pkg`)
  - Sensitive config file writes (`safebox_config`)
  - setuid privilege escalation attempts (`safebox_priv_esc`)

### Added (pre-release development)

#### Component: `system` — the Safebox-facing API

A new component exposing a localhost-only HTTP API at `127.0.0.1:7780` for the Safebox plugin. Implements package management, version control, database migrations, dnf, ZFS operations, and ZFS-based test environments. See the top-level "System component (May 20, 2026)" entry above for the full description.

> Historical note: earlier iterations of this work were called "Component #20: system" and described an auth-token API, then a shell-and-systemd dispatcher. Both predate the current Node System component. The history is in git (commits `3f67cc9`, `acc5ebe`, `35e6f99`) for anyone reviewing the design evolution.

#### Package Manager Version Pinning

All 15+ package managers (npm, yarn, pnpm, composer, pip, pipenv, poetry, cargo, gem, bundle, go, mvn, gradle, dnf, apt, apk) pinned to specific versions with **SHA256 checksum verification** before execution.

- Manifest at `/srv/safebox/runtimes/system/package-versions/`
- Verification adds ~50ms per install but prevents trojan horse execution
- Mitigates supply chain attacks like the May 2025 TanStack/"Mini Shai-Hulud" campaign

#### ZFS Test Environment Cloning

- Pattern A — one operation per container (entrypoint IS the operation, container exits when done)
- Database state cloning (MySQL/Postgres data on ZFS datasets)
- Resource limits: 10 envs per user, 50 total, 10 GB per env (ZFS quota), 16 MB telemetry cap
- Manifest-driven telemetry collection — only files declared in `outputFiles` are returned
- Test containers run as `nobody` (UID 5000+), `network=none`, no production secrets

#### Image Manifest Contract

`/app/manifest.json` inside each code-runner image declares `envVars`, `outputFiles`, `exitCodes`, `resourceHints`, and (planned post-1.0) `cacheMounts`. Manifest is signed alongside image hash.

#### Component #19: `tribe` — TRIBE v2 Neuroscore

Brain-aligned context scoring using fMRI-derived embeddings to predict which document chunks a human brain would actually retain. Reduces hallucinations by ~31% on retrieval-augmented tasks.

#### Earlier audit passes

Pre-release audits resolved 22 additional infrastructure issues across:

1. ZFS encryption config — per-dataset encryption enforced
2. Path inconsistencies — `/srv/safebox` vs `/opt/safebox` unified
3. User creation — `safebox` user UID/GID pinned
4. Python server scope — request-scoped instances
5. Memory exhaustion — vLLM tensor cache respects `--gpu-memory-utilization`
6. Socket hangs — bounded retry with exponential backoff
7. Score validation — embeddings reject NaN/Inf before storage
8. Package verification — per-component SHA256 manifest at install
9. recv/send handling — partial reads reassembled correctly
10. Workflow error handling — failed steps propagate errors instead of silent success
11. ZFS quota enforcement — applied at dataset create
12. Whisper Turbo timeouts — raised from 30s to 120s for long audio
13. TRIBE embedding cache — bounded LRU instead of unbounded growth
14. MariaDB binlog — retention reduced from 30 days to 7
15. Nginx/PHP-FPM workers — calculated from cgroup CPU quota, not host CPU count
16. Docker overlay2 → zfs storage driver
17. Log rotation — `/var/log/safebox/` policy
18. Cascading manifest verification — race condition at component install
19. TPM PCR validation — empty PCR values rejected
20. Deterministic RNG seed handling — empty seed rejected explicitly
21. Component dependency check — circular dependencies detected at build time
22. Workflow ID validation — strict regex enforcement

#### 18-component baseline

- Initial 18-component composable architecture
- 70+ AI models across 5 LLM tiers (tiny to XL)
- Deterministic inference via LD_PRELOAD (AI-only RNG)
- ZFS + Docker + MariaDB storage architecture
- Cascading manifest system with auto-discovery
- Complete PDF and video ingestion pipelines
- GPL-free runtime guarantee
- Triple-layer encryption (Nitro + vTPM + ZFS)

#### April 2026 Model Updates

- OpenAI Privacy Filter 1.5B (Apache 2.0) — PII redaction
- Qwen 3.6 27B (Apache 2.0) — Coding specialist, 77.2% SWE-bench
- Gemma 4 31B Dense (Apache 2.0) — Math/reasoning, 89.2% AIME 2026
- Gemma 4 26B MoE (Apache 2.0) — Efficient, 3.8B active
- GLM-5.1 744B MoE (MIT) — #1 SWE-bench Pro, 8-hour autonomous coding

#### Performance

- Qwen 3.6 27B: 77.2% SWE-bench, matches Claude 4.5 Opus
- Gemma 4 31B: 89.2% AIME 2026
- GLM-5.1: #1 SWE-bench Pro (58.4%)
- PDF ingestion: 5-10 pages/sec
- Video ingestion: 1-2 scenes/sec
- Audio transcription: 10x realtime
- ZFS clone: <100ms
- Package install with pinning: +50ms verification overhead

## Post-1.0 Plans

**Phase A:**
- Cache mounts for test environments (per-workspace, tenant-language-version)
- Network namespaces with M-of-N-signed registry
- Multi-arch images (ARM64)
- Operator-configurable per-tenant resource caps
- HMAC + timestamp for remote executor wire protocol (not just localhost)
- GCP and Azure parity with AWS

**Phase B:**
- Llama 4 Scout integration (10M context)
- Real-time streaming inference
- Multi-modal unified embeddings
- Cross-lingual video search
- Edge optimization (Q3_K_M quantization)
- Kubernetes deployment support
- Network mode `bridge` (advanced)
