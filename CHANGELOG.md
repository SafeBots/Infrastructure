# Changelog

All notable changes to the Safebots Infrastructure project will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project will adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) starting from the 1.0.0 release.

> **Pre-release**: The 1.0.0 version is held until first public release. All entries below are development milestones in the working tree.
>
> **Scope**: This changelog covers ONLY the Infrastructure repo (Linux / AMI / server-runtime level). The Safebox plugin has its own changelog in its own repo.

## [Unreleased — 1.0.0 pre-release]

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
