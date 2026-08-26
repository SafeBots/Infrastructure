# Pre-AMI runbook

Everything reachable in CI is green (`tests/run-all.sh` — 29 suites). This is the
ordered real-hardware sequence that converts the remaining items from
"validated structurally" to "actually works" and produces a shippable AMI.

Each step names the pending item it closes (see `E2E-TEST-RESULTS.md` for the
full boundary). Do them in order — later steps assume earlier ones passed.

**Target instance:** a GPU box that also supports your attestation root
(NitroTPM on the AWS build; SEV-SNP/TDX if you go that route). Needs: Nix, Docker
+ nvidia-container-toolkit, and the CPU TEE / vTPM available.

---

## Phase 0 — bring up the build host

```bash
# On a GPU instance (e.g. g5/g6 for the runners; must have the vTPM/TEE for later attest).
# Install Nix (multi-user).
sh <(curl -L https://nixos.org/nix/install) --daemon
. /etc/profile.d/nix.sh
nix --version                      # confirm >= 2.18, flakes available
mkdir -p ~/.config/nix && echo 'experimental-features = nix-command flakes' >> ~/.config/nix/nix.conf

# Unpack the repo.
unzip Infrastructure.zip && cd Infrastructure
```

---

## Phase 1 — pin nixpkgs and make the flake evaluate  ⟶ closes item 1

The flake input is deliberately unpinned: `nixos/flake.nix` line ~20 reads
`nixpkgs.url = "github:NixOS/nixpkgs/PIN_ME_TO_A_COMMIT_SHA";`. Pick the
nixpkgs commit your auditors bless, pin it, and generate the lock.

```bash
cd nixos
# Choose a commit (a nixos-25.05 release commit, or your blessed SHA).
NIXPKGS_SHA=<the-40-char-commit-sha>
sed -i "s#github:NixOS/nixpkgs/PIN_ME_TO_A_COMMIT_SHA#github:NixOS/nixpkgs/${NIXPKGS_SHA}#" flake.nix

# Generate flake.lock (this is what makes builds reproducible + attestable).
nix flake lock
git add flake.lock 2>/dev/null || true    # keep the lock in the repo

# THE gate that has never run in CI:
nix flake check          # evaluates every nixosConfiguration + checks
```

**Expected failures to work through here** (this is where real issues surface):
- Other `REPLACE_*` / placeholder digests referenced by modules — resolve each.
- Any module option typo that brace-balance couldn't catch — `nix flake check`
  is the first thing that actually type-checks the Nix.
Do not proceed until `nix flake check` is clean.

---

## Phase 2 — build and boot the image  ⟶ closes item 6 (sandboxes load)

### The two-AMI flow (why AMI-2, not the raw Nix image, is attested)

Nix is ~91% bit-reproducible, not 100%. A PCR needs 100%. So do NOT attest the
raw `nix build .#ami` output — attest **AMI-2**, produced like this:

```bash
# 1. Build + boot the SSH-ingress builder (AMI-1). SSH is its ONLY way in.
nix build .#ami1                 # (.#gce1 / .#azure1 / .#oci1 per cloud)
#    launch it, inject the builder SSH key, boot.

# 2. SSH in and run the seal — tears SSH back down, removes machine identity,
#    normalizes every enumerated nondeterminism source (mtimes, host keys,
#    machine-id, logs, seeds, leases, cloud-init, caches, tmp), EXCEPT /nix/store.
ssh builder@ami1-instance 'sudo /path/to/attestation/ami2-seal/seal-ami2.sh'

# 3. Image the sealed instance as AMI-2 — the attested production image, zero ingress.

# 4. PROVE it's deterministic before trusting the measurement:
attestation/ami2-seal/verify-ami2-reproduces.sh <ami1-build-A> <ami1-build-B>
#    diffoscope must report ZERO diff. A diff names a nondeterminism source that
#    escaped the scrub — add it to seal-ami2.sh + the checklist, re-run.
```

Only AMI-2's measurement enters the M-of-N-blessed approved set. AMI-1 is a
throwaway builder; never attested, never in production.


### The two-AMI flow (why AMI-2, not the raw Nix image, is attested)

Nix is ~91% bit-reproducible, not 100%. A PCR needs 100%. So do NOT attest the
raw `nix build .#ami` output — attest **AMI-2**, produced like this:

```bash
# 1. Build + boot the SSH-ingress builder (AMI-1). SSH is its ONLY way in.
nix build .#ami1                 # (.#gce1 / .#azure1 / .#oci1 per cloud)
#    launch it, inject the builder SSH key, boot.

# 2. SSH in and run the seal — tears SSH back down, removes machine identity,
#    normalizes every enumerated nondeterminism source (mtimes, host keys,
#    machine-id, logs, seeds, leases, cloud-init, caches, tmp), EXCEPT /nix/store.
ssh builder@ami1-instance 'sudo /path/to/attestation/ami2-seal/seal-ami2.sh'

# 3. Image the sealed instance as AMI-2 — the attested production image, zero ingress.
#    (aws ec2 create-image / gcloud compute images create / az image create / oci ...)

# 4. PROVE it's deterministic before trusting the measurement:
attestation/ami2-seal/verify-ami2-reproduces.sh <ami1-build-A> <ami1-build-B>
#    diffoscope must report ZERO diff. A diff names a nondeterminism source that
#    escaped the scrub — add it to seal-ami2.sh + the checklist, re-run.
```

Only AMI-2's measurement goes into the M-of-N-blessed approved set. AMI-1 is a
throwaway builder; it is never attested and never in production.



```bash
# Build the host closure.
nixos-rebuild build --flake .#safebox        # attribute is nixosConfigurations.safebox

# On the target: switch (or build an AMI via your image path) and boot.
sudo nixos-rebuild switch --flake .#safebox

# --- Confirm the sandboxes actually LOAD (not just parse) ---
systemctl status phpfpm-safebox              # must be active (running), NOT failed
journalctl -u phpfpm-safebox | grep -i "seccomp\|denied\|failed" || echo "no sandbox denials"
# If php-fpm failed to start: a SystemCallFilter is too tight. The two we already
# calibrated (@resources kept, no MemoryDenyWriteExecute) are the usual culprits;
# check journal for the exact syscall and add it back. See docker/security/README.md.

# AppArmor profile loaded?
sudo aa-status | grep safebox-runner         # must be listed/loaded
systemctl status safebox-apparmor-load       # must be active (exited) success

# Container tier came up under the profiles?
sudo docker compose -f /opt/safebox/docker/docker-compose.yml ps
sudo docker inspect safebox-node-exec --format '{{.HostConfig.SecurityOpt}}'  # shows seccomp+apparmor
```

**Confirm nothing is over-tight:** each hardened container should be `Up`, not
restarting. A crash-looping `node-exec` or `ffmpeg` means the base seccomp
profile is missing a syscall the workload needs — capture it from
`journalctl` / `dmesg | grep SECCOMP` and add it to
`docker/security/seccomp/safebox-runner.json`.

---

## Phase 3 — pin real digests + weights  ⟶ closes item 3

```bash
# Container image digests in docker-compose.yml (the REPLACE_WITH_REAL_DIGEST_* ones).
# For each image, resolve the digest and substitute:
sudo docker pull node:20-alpine && sudo docker inspect --format '{{index .RepoDigests 0}}' node:20-alpine
# ... repeat for llama.cpp, ffmpeg, typesense, browserless/chrome, then sed into the compose file.

# Model weights: pull one real model per runner family, capture per-shard SHA-256,
# then fill the manifest placeholders. Example for a vLLM model:
python3 - <<'PY'
import hashlib, sys, glob
for f in glob.glob("/safebox/models/<model>/*.safetensors"):
    h=hashlib.sha256(open(f,'rb').read()).hexdigest()
    print(f, h)
PY
# Put those into model-runners/vllm/manifests/<model>.json (the sha256 placeholders),
# pin the HF revision, and (if using IPFS) `ipfs add` and record the CID.
```

The digest-pinning helper `resolve-digests.sh` (if present in your build tooling)
automates the image side; weights are captured from the real files as above.

---

## Phase 4 — real hardware attestation  ⟶ closes item 4

The Ed25519 trust logic is already tested (`attestation/test/e2e-attestation-test.sh`).
This step confirms the **hardware quote** half that CI cannot.

```bash
# 1. Take a real measurement on the booted instance.
python3 attestation/measure/precompute-measurement.py > /tmp/measurement.json

# 2. Run the per-cloud hardware validator against the REAL quote/cert chain.
#    This is what sets _hardware_verified — the thing CI had to stub.
python3 attestation/verify/hardware/validate-quote.py \
    --attestation /tmp/attestation.json   # must return hardware-verified: true

# 3. Full verify against a real quote — expect KOSHER on a blessed measurement,
#    and confirm it FAILS CLOSED without the validator (the property we tested stubbed).
python3 attestation/verify/verify-attestation.py \
    --attestation /tmp/attestation.json \
    --approved-entry /path/to/blessed-entry.json \
    --trust-policy /path/to/policy.json
# -> "KOSHER" on a genuine quote; "has not passed hardware-root verification"
#    if you skip step 2. Both behaviors must hold on real hardware.
```

---

## Phase 5 — runner smoke tests  ⟶ closes item 2

No runner has served a token in CI. Bring one up per family and confirm real
inference, especially the two never-executed TTS runners.

```bash
# Launch a runner (dynamic path) or via compose; then hit /health and one real request.
# Per family, at minimum:
#   vllm            — one chat/embedding completion returns tokens
#   whisper         — transcribe a short wav
#   kokoro-tts      — synthesize a sentence -> wav plays
#   chatterbox-tts  — NEVER RUN: synth a sentence; confirm generate() path + PerTh watermark note
#   orpheus-tts     — NEVER RUN: synth with MODEL_NAME=orpheus-3b AND =higgs-audio-v2-3b
#   privacy-filter  — one filter call
#   (comfyui/ltx/wan/stable-audio/triposr/mineru/onnx — one representative job each)

# Each runner, with HMAC ON, signed the LocalRunner way:
SAFEBOX_REQUIRE_HMAC=true   # confirm a signed request succeeds and an unsigned one 401s
```

The two TTS runners are the highest-risk smoke test — their `generate()` call
shapes were written against each library's documented API but never executed.
If a call signature is off, fix it in `model-runners/<runner>/runner.py`.

---

## Phase 6 — confirm HMAC env forwarding  ⟶ closes item 5

```bash
# The attested profile sets SAFEBOX_REQUIRE_HMAC=true with a build assertion.
# Confirm the launch unit actually forwards it to the runner container:
sudo docker exec safebox-<runner> printenv SAFEBOX_REQUIRE_HMAC   # must print: true
# If empty, the launch unit isn't forwarding env -> add `-e SAFEBOX_REQUIRE_HMAC`
# at the docker run site (see model-runners/HMAC-CANONICAL-FORM-FIX.md).
```

---

## Phase 7 — re-run the full suite ON the box, then cut

```bash
# Everything CI ran, now against the real environment (deps present, kernel real):
pip install --break-system-packages pynacl fastapi uvicorn pydantic numpy httpx
tests/run-all.sh                       # expect the same 29/29, now on real hardware

# The one CI skips — the live integration smoke — should now run:
node aws/scripts/components/system/test/smoke.js   # needs the system component up on :7799
```

**Cut the AMI only when:** `nix flake check` clean (1), image boots with all
sandboxes loaded and no crash-loops (6), digests+weights pinned (3), a genuine
quote returns KOSHER and fails closed without the validator (4), one smoke test
per runner family passes incl. both TTS runners (2), HMAC env forwarding
confirmed (5), and `tests/run-all.sh` + `smoke.js` green on the box.

---

## Still-open follow-ups (not AMI blockers, but track them)

- **chromium dedicated seccomp profile** — currently Docker-default + SYS_ADMIN.
  Write `docker/security/seccomp/chrome.json` allowing Chrome's namespace
  syscalls over a deny-default base, then drop SYS_ADMIN.
- **php-fpm `MemoryDenyWriteExecute`** — add it once you confirm `opcache.jit`
  is off in the app (see `docker/security/README.md`).
- **Per-runner microVM (Cloud Hypervisor)** — only if you move to
  multi-tenant-per-box; not needed for one-tenant-per-box on the attested
  substrate. (Firecracker is out — no GPU passthrough.)
