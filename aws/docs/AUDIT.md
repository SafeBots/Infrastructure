# Safebox AMI Audit Guide

> **Audience**: External security auditors reviewing a Safebox AMI before client selection. Also useful for internal pre-audit verification.
>
> **Goal**: Verify that the image, as built, matches the specification in `docs/HARDENING-PLAN.md`, and that the root hash the control plane blesses corresponds to exactly the bytes you inspected.

---

## Two-AMI Build: Audit, Then Seal

Safebox uses a two-AMI workflow with **chroot-based dual capture**. `build-image.sh` builds a single chroot, captures it as the **audit AMI** (with SSH and a `safebox-audit` user), then runs `safebox-seal-image.sh --chroot` on the same chroot directory to remove SSH, lock all accounts, scrub nondeterminism, and write `/etc/safebox/sealed`. The sealed chroot is captured as the **production AMI**. Both AMIs are built from the same chroot without ever booting, which eliminates boot-time nondeterminism and guarantees that AMI B is a deterministic function of AMI A. The sealed image gains three additional hardening measures at boot (`kernel.modules_disabled=1`, `hidepid=2`, locked root) that would have blocked audit work. See `docs/SEALING.md` for the full sealing workflow.

What this means for the audit:

1. **You inspect a running instance.** The build team launches an instance from the audit AMI and provides you with SSH access via the `safebox-audit` user. You have full root access via `sudo`. Everything the production image will contain is on this instance — including SSH and the audit user, which are masked at boot time on sealed images by overlay whiteouts (see Phase 5).

2. **The root hash is the contract.** After sealing, `build-verity-root.sh` prints `ROOTHASH=<64 hex>`, which is also on the kernel command line, in the AMI's `RootHash` tag, and in `manifests/aws-<date>.json`. Any byte changed in the root filesystem changes the hash; the kernel refuses to read a block that does not match. A box whose TPM quote shows the PCR 8 and 9 values for that command line, kernel and initramfs is running exactly the bytes you inspected. Recompute the hash from the captured snapshot (`veritysetup verify`) and compare it to the manifest.

3. **Keys are not in the image.** The ZFS pool key and the HMAC seed are generated on the first boot of each production instance and sealed to that instance's TPM. The image contains no secret; sections below that look for key files on the image should find none.

---

## Pre-Audit Verification by the Build Team

Before handing you the audit AMI, the build team should have already verified:

```
☐ git clean -fdx; git status reports clean working tree
☐ git log -1 shows the commit being audited; no uncommitted changes
☐ aws/scripts/build-image.sh ran with no warnings or errors
☐ common/image/verify-image.sh --audit passed every assertion (audit AMI)
☐ common/image/verify-image.sh passed every assertion (production AMI)
☐ The audit AMI boots successfully with SSH access via the safebox-audit user
☐ tests/redteam/aws.sh <ami-id> passed
```

If any of these are unchecked, the AMI is not ready for audit. Push back to the build team.

---

## Phase 1 — Trust Root Audit

This is the highest-priority section. If anything here is wrong, nothing else matters.

### 1.1 — Key generation and sealing (`common/boot/safebox-unseal.sh`, `common/boot/safebox-seal.sh`)

These scripts run in the initramfs of each production instance. On first boot they generate the ZFS pool key and the HMAC seed, create the pool, and seal both keys to the local TPM; on every later boot they unseal them. Nothing about keys runs at build time, and nothing in the image is a key.

**Read the script. Verify:**

```
☐ Key material comes from /dev/urandom or getrandom() — NOT from /dev/random (blocking),
  NOT from a deterministic source (timestamp, hostname, hash of build inputs), NOT
  from a fixed seed.

☐ Key length is 32 bytes (256 bits) for AES-256-GCM. Anything less is a bug.

☐ TPM2 sealing is done with tpm2_create + tpm2_load (or equivalent), NOT with the
  older tpm-tools that have known timing issues.

☐ The PCR selection bound to the sealing policy is exactly sha256:0,2,4,7,8,9,14,15:
    PCR 0  (UEFI firmware)
    PCR 2  (option ROMs)
    PCR 4  (boot loader)
    PCR 7  (Secure Boot state and the certificates used to verify shim, GRUB, kernel)
    PCR 8  (GRUB: kernel command line, which carries the verity root hash)
    PCR 9  (GRUB: kernel and initramfs)
    PCR 14 (shim: MOK state)
    PCR 15 (unused by firmware; at its reset value of all zeros at policy time)

  PCR 1 and 5 are left out on purpose: they vary with instance type and boot order
  on the same image. PCR 10 (IMA) and later runtime PCRs would break the unseal
  after legitimate measurements. Fewer than these eight would let a swapped root
  disk unseal (0 and 7 alone do not change when the root changes).

☐ After a successful unseal or first-boot seal, the script runs
  tpm2_pcrextend 15:sha256=<sha256("safebox-sealed-phase-complete")>, so the
  policy no longer matches for the rest of the boot and nothing later, root
  included, can unseal the blobs again.

☐ The sealed blobs are written to /boot/safebox/ (zfs-key.pub, zfs-key.priv,
  hmac-seed.pub, hmac-seed.priv, policy.digest, pcr-values.txt), mode 0400 root.
  The unsealed pool key lives at /run/safebox/zfs-key only until `zfs load-key`
  succeeds and is then deleted; the seed stays at /run/safebox/hmac-seed, mode
  0400 owner safebox-infra, for the life of the boot.

☐ The raw key is wiped from memory after sealing — verify with `mlock` + `explicit_bzero`
  or equivalent. Just `unset` is not enough.

☐ The script logs WHAT it did but not the key value. Grep the script and verify no
  `echo $KEY`, no `printf "%s" "$KEY"`, no debug paths that log the key.

☐ There is NO copy of the key escrowed anywhere outside the TPM. If the build team
  thinks they need a recovery key, they're wrong — losing the TPM means losing the
  data, by design.

☐ The script handles failure cases without leaving partial state: if TPM sealing
  fails, the raw key file (if any was written) is unlinked before exit.
```

**Then run the script in a test environment and verify behavior:**

```
☐ The script produces /run/safebox/zfs-key as a tmpfs file (NOT on the rootfs).
  Run `findmnt /run/safebox` and confirm it's tmpfs.

☐ The unsealed key file has mode 0400, owner root:root, NOT readable by any
  non-root user. Check with `stat -c '%a %U:%G' /run/safebox/zfs-key`.

☐ Reboot the test instance. The sealed blob should still exist; the unsealed key
  at /run/safebox/zfs-key should be reconstituted on boot via the systemd unit
  (which itself should be measured into PCR — check the unit file path).

☐ Modify a measured boot artifact (e.g. change one byte in the kernel image) and
  reboot. The TPM unsealing should FAIL — the ZFS key is not released — and the
  instance becomes unusable (no /srv mounts). This is the desired behavior.
```

### 1.2 — Build orchestration (`scripts/build-ami.sh`)

This script orchestrates the multi-component build. Bugs here can undermine everything `install-base.sh` does.

**Read the script. Verify:**

```
☐ `set -euo pipefail` at the top — if it's missing, a failed component install
  could silently leave the AMI in a partial state.

☐ Each component installer is invoked with explicit error handling. Look for any
  `|| true` after a critical step — those are red flags.

☐ The component install order is deterministic and documented. The order should be:
    1. base (always first)
    2. Trust-root setup (generate-attested-key.sh — actually run BEFORE build-ami.sh
       in the build pipeline, not from inside it)
    3. system (creates the localhost daemon and auth token)
    4. media (if selected)
    5. AI/ML components (vision, embed, speech, tribe, llm-*)
    6. Infrastructure add-ons (cuda, vllm, index)
    7. Optional components (libreoffice, ocr, diffusion-small)
    8. Cascade SHA256 computation
    9. TPM attestation seal
    10. (Post-build, post-audit) Image sealing via safebox-seal-image.sh

☐ Each step's exit code is checked. A non-zero exit from any component installer
  must abort the build immediately.

☐ The cascade SHA256 computation runs LAST, after all components and after any
  optional remove-ssh pass. The hash is over the file set as it will actually
  ship — not over an earlier state.

☐ The script writes a build log to a location that's then included in the AMI
  manifest cascade. If the log isn't part of the cascade, attackers can modify
  the log post-build without affecting the attestation.

☐ Component installers run as root (necessary for system-level operations) but
  the script must not allow component installers to modify each other's outputs.
  In practice this means each installer writes to its own manifest path and
  doesn't touch siblings' manifests.

☐ The build produces an audit AMI with SSH intact. The seal script
  (safebox-seal-image.sh) runs AFTER the build and audit are complete.
  The audit AMI and sealed production AMI must differ ONLY by the addition
  of /etc/safebox/sealed (one file — see Phase 5.1).
```

**Then verify behavior:**

```
☐ Run `build-ami.sh base` and `build-ami.sh base,system`. The second build should
  not modify any file produced by the first; it should only ADD files. Compare
  with `sha256sum` on each file in both builds.

☐ Inject a deliberate failure into one component installer (e.g. add `exit 1` to
  install-system.sh) and verify the entire build aborts with a non-zero exit code.
  Verify no AMI is produced.

☐ Build the audit AMI, then run safebox-seal-image.sh on it. Diff the
  file sets. The ONLY difference should be the addition of /etc/safebox/sealed
  (mode 0444). ANYTHING ELSE in the diff is a bug.
```

### 1.3 — Attestation verification (`scripts/verify-attestation.sh`)

This script is what clients run to verify a running instance matches the AMI hash they selected. If it has bugs, clients can be deceived about the running state.

**Read the script. Verify:**

```
☐ The script reads PCR values from the actual TPM, not from a file the instance
  can write. Use tpm2_pcrread, not `cat /sys/.../pcr-N`.

☐ The expected PCR values are passed as arguments or read from a file the script
  was invoked with — NOT from a file on the instance being verified (that would
  let the instance lie about expected values).

☐ The comparison is constant-time. Bash `[[ ... = ... ]]` is fine for hash
  comparisons because they're fixed-length and shell short-circuit doesn't leak
  useful timing for 64-char hex strings, but verify the script doesn't do
  prefix matching or substring matching.

☐ All required PCRs are checked, not just one. The script should fail if even
  one PCR doesn't match, not just report the mismatch.

☐ The script's own SHA256 is included in the cascade. Otherwise the script can
  be modified to always return "ok" without affecting the cascade hash that
  clients pin to.

☐ The script does NOT depend on any service running on the instance (e.g. an
  attestation API). It only reads from TPM and compares to inputs. Network-based
  verification is a different concern with different threat model.
```

**Then verify behavior:**

```
☐ Run verify-attestation.sh on a freshly-built AMI with the correct expected
  cascade hash. It should report success.

☐ Run it with a deliberately wrong expected hash. It should report failure
  and exit non-zero.

☐ Modify one byte of /opt/safebox/manifests/base.json on a running instance,
  then re-run. It should report failure (the manifest is part of the cascade
  measurement).
```

---

## Phase 2 — Base Component Audit

This is what `install-base.sh` produces. We've audited install-base.sh once at the source level (see CHANGELOG.md entries for Bug 1–10). Your job is to verify the audit findings hold on the actual built AMI.

### 2.1 — Filesystem layout

```
☐ /opt/safebox exists, mode 0755, owned root:root
☐ /opt/safebox/manifests/ exists, mode 0755, owned root:root
☐ /opt/safebox/manifests/base.json exists, mode 0644, owned root:root
☐ /srv exists as a ZFS mount (run `findmnt /srv` and confirm fstype=zfs)
☐ /srv/safebox, /srv/docker, /srv/mariadb, /srv/encrypted, /srv/tenants are
  each separate ZFS datasets (run `zfs list`)
☐ Each ZFS dataset has encryption=aes-256-gcm (run `zfs get encryption`)
☐ Each ZFS dataset has keystatus=available after boot
☐ /run/safebox/ exists as tmpfs (run `findmnt /run/safebox`)
☐ /run/safebox/zfs-key exists with mode 0400, owner root:root
☐ /var/log/audit/audit.log exists and is being written to
```

### 2.2 — Pinned package versions

Open `/opt/safebox/manifests/base.json` and verify each listed package version matches what's actually installed:

```bash
jq -r '.packages.system[]' /opt/safebox/manifests/base.json | while read pkg; do
    name="${pkg%-*}"
    expected_ver="${pkg##*-}"
    actual_ver=$(rpm -q --queryformat '%{VERSION}' "$name" 2>/dev/null)
    if [[ "$actual_ver" != "$expected_ver"* ]]; then
        echo "MISMATCH: $name expected $expected_ver, got $actual_ver"
    fi
done
```

```
☐ Above script produces no MISMATCH lines
☐ mariadb-server matches manifest version
☐ php-fpm matches manifest version
☐ nginx matches manifest version
☐ docker-ce matches manifest version
☐ nodejs matches manifest version
☐ npm matches manifest version
☐ zfs matches manifest version
☐ auditd matches manifest version
☐ fail2ban matches manifest version
```

### 2.3 — npm packages (base set)

```bash
cd /opt/safebox
npm ls --production --depth=0
```

```
☐ Every package shown is present in package-lock.json
☐ No package shows "(empty)" or "MISSING" status
☐ /opt/safebox/manifests/base-npm.txt matches current `npm ls` output
☐ /opt/safebox/package.json has the `"preinstall": "echo 'Do not run npm install...' && exit 0"` block
☐ /opt/safebox/package-lock.json exists, mode 0644, owned root:root
☐ SHA256 of /opt/safebox/package-lock.json matches what's recorded in base.json under packages.npmLockSha256
```

### 2.4 — Shell access (audit AMI) and seal verification

**On the audit AMI**, the following are intentionally present for audit access:

```
☐ openssh-server is installed (for audit access)
☐ The audit user 'safebox-audit' exists with the build team's pubkey in authorized_keys
☐ sshd is running and listening on port 22
☐ Root is accessible via sudo from safebox-audit
☐ /etc/safebox/sealed does NOT exist (this is an unsealed audit AMI)
☐ NO other shell-access mechanism is enabled:
    ☐ dpkg -l amazon-ssm-agent shows not installed
    ☐ dpkg -l telnetd shows not installed
    ☐ dpkg -l rsh-server shows not installed
    ☐ dpkg -l vsftpd shows not installed
    ☐ dpkg -l cockpit shows not installed
```

**After the audit passes**, the build team seals the image. The seal script (`/opt/safebox/seal/safebox-seal-image.sh`) is the ONLY step between the audit AMI and the production AMI. Verify the seal script is present and inspect its contents:

```
☐ /opt/safebox/seal/safebox-seal-image.sh exists, mode 0755
☐ The script requires --chroot <rootfs> and refuses to operate on /
☐ The script writes ONLY /etc/safebox/sealed (deterministic content, mode 0444). It does NOT remove SSH or modify accounts — those are masked at boot by safebox-sealed-boot.service
☐ The script is idempotent (re-running on an already-sealed chroot is a no-op)
☐ safebox-sealed-boot.service is installed and enabled
```

### 2.5 — Docker daemon configuration

```bash
cat /etc/docker/daemon.json
docker info
```

```
☐ daemon.json contains "userns-remap": "default"
☐ daemon.json contains "no-new-privileges": true
☐ daemon.json contains "icc": false
☐ daemon.json contains "storage-driver": "zfs"
☐ daemon.json contains "storage-opts": ["zfs.fsname=safebox-pool/docker"]
☐ daemon.json log-opts cap log size at 100m × 5 files
☐ `docker info` shows "Userns: default" (or equivalent)
☐ `docker info` shows "Storage Driver: zfs"
☐ `docker info` shows Cgroup Driver: systemd (not cgroupfs)
☐ dockremap user exists (`id dockremap`)
☐ dockremap user has /sbin/nologin shell
☐ dockremap user has no home directory or has /var/lib/docker as home
☐ /etc/subuid contains a dockremap entry
☐ /etc/subgid contains a dockremap entry
```

**Test container isolation:**

```bash
docker run --rm alpine:3.20 id
# Should report uid=0(root) gid=0(root) — that's the CONTAINER's view

# Now check what the host sees
docker run --rm -d --name test-userns alpine:3.20 sleep 100
ps -ef | grep "sleep 100"
# Should show the process running as host UID 100000 (or whatever the userns-remap base is)
docker stop test-userns
```

```
☐ Container's `id` reports uid=0 (container's view)
☐ Host's `ps` shows the same process running as UID 100000+ (remapped)
☐ Container cannot write to host paths via volume mounts unless explicitly allowed
☐ Container with --network=none has no network interfaces (test with `docker run --network=none alpine ip addr`)
```

### 2.6 — PHP-FPM hardening

```bash
php -i | grep -E 'expose_php|allow_url_(fopen|include)|disable_functions'
```

```
☐ expose_php is Off
☐ allow_url_fopen is Off
☐ allow_url_include is Off
☐ disable_functions contains: exec, passthru, shell_exec, system, proc_open, popen
☐ disable_functions contains: curl_multi_exec, parse_ini_file, show_source, dl, phpinfo
☐ pcntl_exec is also blocked (recommended addition — flag for build team if missing)
```

**Test from a PHP script:**

```php
<?php
echo "exec: " . (function_exists('exec') ? 'AVAILABLE' : 'blocked') . "\n";
echo "shell_exec: " . (function_exists('shell_exec') ? 'AVAILABLE' : 'blocked') . "\n";
echo "system: " . (function_exists('system') ? 'AVAILABLE' : 'blocked') . "\n";
```

```
☐ All three report "blocked"
☐ `function_exists` itself works (sanity check)
☐ Attempting to call exec() throws E_WARNING, returns NULL
```

### 2.7 — auditd configuration

```bash
auditctl -l
```

```
☐ Rule present: -w /run/safebox/zfs-key -p rwa -k safebox_zfs_key
☐ Rule present: -w /usr/bin/dnf -p x -k safebox_pkg
☐ Rule present: -w /usr/bin/rpm -p x -k safebox_pkg
☐ Rule present: -w /usr/local/bin/npm -p x -k safebox_pkg
☐ Rule present: -w /usr/local/bin/composer -p x -k safebox_pkg
☐ Rule present: -w /etc/docker/daemon.json -p wa -k safebox_config
☐ Rule present: -w /etc/php.ini -p wa -k safebox_config
☐ Rule present: -w /etc/nginx/ -p wa -k safebox_config
☐ Rule present for setuid syscall: -a always,exit -F arch=b64 -S setuid -F a0=0 ...
☐ auditd is running (`systemctl is-active auditd` returns "active")
☐ /var/log/audit/audit.log is being written to (size grows over a few seconds of normal activity)
☐ Audit log rotation is configured (check /etc/audit/auditd.conf for max_log_file_action=ROTATE)
```

**Trigger each rule and verify it fires:**

```bash
# Trigger safebox_zfs_key rule
sudo cat /run/safebox/zfs-key > /dev/null 2>&1 || true
ausearch -k safebox_zfs_key | tail -5

# Trigger safebox_pkg rule
sudo /usr/bin/rpm -q kernel > /dev/null
ausearch -k safebox_pkg | tail -5

# Trigger safebox_config rule
sudo touch /etc/docker/daemon.json
ausearch -k safebox_config | tail -5
```

```
☐ Each ausearch returns recent entries with the expected key
☐ Entries include uid, exe, comm, and timestamp
☐ Entries are within the last few seconds
```

### 2.8 — Network listeners

```bash
ss -tnlp
```

```
☐ Port 22 (SSH) is listening on 0.0.0.0 — audit AMI only (removed by seal script)
☐ Port 443 (nginx HTTPS) is listening on 0.0.0.0
☐ Port 80 (nginx HTTP → HTTPS redirect) is listening on 0.0.0.0
☐ Port 3306 (MariaDB) is listening on 127.0.0.1 only
☐ System component has NO TCP listener (binds only Unix sockets at /run/safebox/)
☐ LLM ports (8080, 8081, etc.) are listening on 127.0.0.1 only
☐ NO listener on port 23, 513, 514, 5985, 5986 (anywhere)
☐ NO listener on any other public-facing port

Repeat for IPv6:
☐ `ss -6tnlp` shows the same loopback constraints — no [::] binds on private services
```

For production (sealed) AMI verification (done by the build team after booting a sealed instance):

```
☐ Port 22 is NOT listening (SSH masked by safebox-sealed-boot.service via overlay whiteouts)
☐ amazon-ssm-agent process is not running
☐ All other listeners are identical to the audit AMI
```

### 2.9 — Manifest integrity

```bash
sha256sum /opt/safebox/manifests/base.json
jq -r '.security' /opt/safebox/manifests/base.json
```

```
☐ base.json parses as valid JSON
☐ base.json contains "component.name": "base"
☐ base.json contains "component.version": "1.0.0-pre"
☐ base.json contains "security.telnetdRemoved": true
☐ base.json contains "security.shellAccessPolicy": "zero-interactive-access"
  (Note: on the audit AMI, the policy is "audit-mode" or similar; on the sealed production AMI it's "zero-interactive-access".
   The values WILL differ — that's expected and is part of the documented seal diff.)
☐ base.json contains "security.zfsEncryption": "aes-256-gcm"
☐ base.json contains "packages.npmLockSha256" matching actual file hash
☐ SHA256 of base.json is recorded in the parent cascade manifest
```

---

## Phase 3 — System Component Audit

> **Scope**: the `system` component — the Node.js host API service that handles all privileged operations on behalf of Safebox. Listens on per-container Unix domain sockets and one control socket under `/run/safebox/` — never on a TCP port. This is the foundation of A₀ for the system-side API.

The system component is ~1100 lines of focused Node.js plus ~20 lines of sudoers rules. An auditor reads each file once and gains complete knowledge of what the system component can do.

### 3.1 — File presence, ownership, and modes

```bash
ls -la /opt/safebox/system/
ls -la /etc/systemd/system/safebox-system.service
ls -la /etc/sudoers.d/safebox-system
ls -la /var/lib/safebox/managed-containers.json
ls -la /run/safebox/hmac-seed
ls -la /run/safebox/keys/*/
ls -la /run/safebox/
```

```
☐ /opt/safebox/system/ exists, mode 0755, owner root:root
☐ All System component source files present and read-only (0644, root:root):
    server.js, sockets.js, auth.js, secret.js, config.js,
    opsSystem.js, opsTest.js, opsModels.js, opsContainers.js,
    nsmClient.js, cborDecode.js, package.json
☐ /etc/systemd/system/safebox-system.service exists, 0644, root:root
☐ /etc/sudoers.d/safebox-system exists, mode 0440, root:root, validates with `visudo -c`
☐ /var/lib/safebox/managed-containers.json exists, mode 0644 (or 0640), root:root
☐ /run/safebox/hmac-seed exists on tmpfs, mode 0400, owner root (read by the service only through LoadCredential=), length exactly 32 bytes; nothing under /etc or /var holds a key
☐ /run/safebox/keys/<name>/ exists per managed container, owner safebox-infra, mode 0750
☐ /run/safebox/keys/<name>/system.hmac files exist for every managed container,
    mode 0440, owner safebox-infra, length exactly 32 bytes each
☐ User safebox-infra exists (system user, no home, no shell)
☐ Group safebox-infra-readers exists; safebox-infra is a member
☐ /srv/zfs-clones exists, mode 0750, owner safebox-infra
```

### 3.2 — Socket listeners (the entire API surface)

```bash
ss -lxnp | grep safebox       # all unix domain listeners under /run/safebox
ss -ltnp                       # confirm NO TCP listener for safebox-infra
ls -la /run/safebox/ /run/safebox/containers/
```

```
☐ System component has NO TCP listener at all (confirm `ss -ltnp` shows nothing
    owned by safebox-infra)
☐ /run/safebox/control.sock exists, mode 0660, owner safebox-infra:safebox-infra
☐ /run/safebox/containers/<name>.sock exists for every managed container,
    mode 0660, owner safebox-infra:safebox-infra
☐ Process listening on each socket is owned by safebox-infra (verify `ss -lxnp` output)
☐ /run/safebox/ is mode 0750, owner safebox-infra (created by systemd RuntimeDirectory)
☐ Per-container HMAC keys are HKDF-derived (verify by deriving from master + container
    name using secret.derivePerContainerKey() and comparing bytes against the file)
```


### 3.3 — sudoers — the entire privileged surface

`/etc/sudoers.d/safebox-system` is the system component's permission to elevate. Read every line. The Cmnd_Alias entries define EXACTLY what binaries and exactly what argument shapes the system component can run as root.

```bash
cat /etc/sudoers.d/safebox-system
visudo -c -f /etc/sudoers.d/safebox-system
```

```
☐ File passes `visudo -c` validation
☐ `safebox-infra ALL=(root) NOPASSWD: ...` line is present
☐ Cmnd_Alias SAFEBOX_DNF restricts dnf to specific verbs only (install / remove / upgrade / list / check-update)
☐ Cmnd_Alias SAFEBOX_ZFS restricts zfs operations to datasets under `safebox-pool/`
  Specifically: snapshot / clone / create / destroy / rollback only, NOT send / receive / mount / unmount
☐ Cmnd_Alias SAFEBOX_DOCKER restricts docker to `run --detach *` (with safebox-test-* prefix
  enforceable via labels, not sudoers patterns alone), plus `logs -f`, `wait`, `rm -f` against safebox-test-*
☐ Cmnd_Alias SAFEBOX_MKDIR restricts mkdir to under /srv/zfs-clones/
☐ NO entries grant: `dnf shell`, `dnf history undo`, `zfs send`, `zfs receive`,
  `docker exec`, `docker run` without `--detach`, `docker run -v /:`, generic mkdir
☐ Defaults entries scope to this file's binaries only (Defaults!/usr/bin/dnf, ...)
  to avoid changing global sudo behavior
```

### 3.4 — config.js: managed-containers.json loader

```bash
cat /opt/safebox/system/config.js
```

```
☐ CONFIG_PATH defaults to /var/lib/safebox/managed-containers.json
☐ env-var override (SAFEBOX_SYSTEM_CONFIG) is gated behind a clearly-test-only path
☐ loadFile() returns null on parse failure rather than throwing — reload-safe
☐ reload() refuses to replace good config with broken config (silent denial)
☐ imageMatches() compiles imagePattern strings to RegExp at load time
☐ actionAllowed() does a simple includes() check — no regex, no dynamic eval
☐ SIGHUP handler calls reload() and nothing else
```

### 3.5 — auth.js: HMAC verification

```bash
cat /opt/safebox/system/auth.js
```

```
☐ canonicalize() joins fields with `\n` literal, not `\r\n` or `/`
☐ verify() validates timestamp matches `^\d{1,11}$` before parsing
☐ verify() validates nonce matches `^[a-f0-9]{32}$`
☐ verify() validates provided signature matches `^[a-f0-9]{64}$`
☐ Timestamp skew check uses signed math (|now - ts| > 300)
☐ Nonce LRU prune happens BEFORE the set lookup (prevents stale-nonce reuse)
☐ Signature compare uses `crypto.timingSafeEqual` with equal-length buffers
☐ Failed verify() returns a structured object — never throws on untrusted input
☐ Successful verify() inserts nonce into LRU; failed verify() does NOT
  (otherwise an attacker could DOS the LRU with garbage)
```

### 3.6 — secret.js: HMAC key derivation

```bash
cat /opt/safebox/system/secret.js
```

```
☐ Preference order is: TPM-derived → existing-on-disk → random
☐ TPM derivation uses HKDF-SHA-256 with a fixed info string and salt
☐ TPM path falls through silently to next option on any read failure
☐ Random fallback logs WARN to stderr (operator must notice)
☐ writeSecret uses atomic rename (tmp file → rename)
☐ writeSecret sets mode 0640 explicitly, never world-readable
☐ Returned key is exactly 32 bytes (verified by length check in readExisting)
```

### 3.7 — opsSystem.js: tool dispatch and execFile

```bash
cat /opt/safebox/system/opsSystem.js
grep -nE 'spawn|execSync|exec\(' /opt/safebox/system/opsSystem.js
```

```
☐ Only execFile is used (never spawn with shell:true, never exec, never execSync)
☐ Every TOOL_BUILDERS entry returns [binary, argv-array]; the binary is an absolute path
☐ The `--` separator appears before user-supplied tokens (packages, etc.) for every mutating action
☐ validatePackages enforces the leading-char-not-dash rule, defeating --registry=evil
☐ resolveWorkspace uses fs.realpathSync, then prefix check — never trusts relative paths
☐ WORKSPACE_PREFIX defaults to /srv/encrypted/apps/ AND consults zfsVolumes from managed-containers
☐ run() spawns with clean env (PATH/HOME/LANG/LC_ALL/GIT_*) — no inherited env
☐ run() pipes stdin to /dev/null (child.stdin.end()) so no shell can hang on input
☐ stdout/stderr captures are size-capped (64 KiB / 16 KiB)
☐ Timeout enforced via execFile's timeout option, with SIGKILL on overrun
☐ dnf check-update exit code 100 mapped to success (dnf-specific quirk, not hidden)
☐ dnf is restricted to managedContainer='_host'. validateRequest() rejects any other
  managedContainer requesting tool=dnf with FORBIDDEN_ACTION. This check happens
  BEFORE the allowedActions check, so even if a real app's allowedActions includes
  "dnf" by mistake, the request is still rejected.
```

### 3.8 — opsTest.js: test environment lifecycle

```bash
cat /opt/safebox/system/opsTest.js
```

```
☐ Each test allocates a fresh ZFS clone under safebox-pool/zfs-clones/<testId>
☐ ZFS snapshot of sourceClone happens FIRST; clone creation second; on clone
  failure the snapshot is destroyed (no leak)
☐ docker run uses: --user nobody, --network none, --read-only,
  --tmpfs /tmp:size=64m, --cap-drop ALL, --security-opt no-new-privileges
☐ envVars validation: key matches ^[A-Z][A-Z0-9_]{0,63}$, value bounded to 8192 chars,
  no \n / \r / \0
☐ command array validation: ≤ 64 elements, each ≤ 4096 chars, strings only
☐ Keepalive watchdog: setTimeout with cleanupContainer on expiry
☐ Max lifetime watchdog: separate setTimeout, cannot be reset by keepalive
☐ Ring buffer enforces 4 MiB cap per test; truncated:true flag on overflow
☐ cleanupContainer kills docker AND destroys ZFS clone AND destroys snapshot;
  best-effort with timeouts on each
☐ Test record GC'd 10 minutes after termination
☐ shutdownAll() tears down all live tests on SIGTERM
```

### 3.9 — server.js: routing, audit, error handling

```bash
cat /opt/safebox/system/server.js
```

```
☐ Body size cap (1 MiB) enforced before parsing
☐ HMAC verify happens BEFORE parsing JSON body (untrusted JSON not parsed until auth passes)
☐ HMAC verify uses req.url (path + query string) verbatim — same canonicalization both sides
☐ Audit entries written via systemd-cat with structured JSON
☐ Audit fallback to stderr never crashes the system component on systemd-cat pipe errors
☐ All routes match exact regexes — no catch-all path that could surprise
☐ NOT_FOUND status code is 404, NOT 200
☐ SIGTERM/SIGINT handlers call shutdownAll() before exiting (no orphan test containers)
```

### 3.10 — opsModels.js: model supply chain

```bash
cat /opt/safebox/system/opsModels.js
```

```
☐ requireHostScope() is the FIRST check in handleInstall, handleList,
  handleVerify, handleRemove. Non-_host managedContainer is rejected with
  FORBIDDEN_ACTION before any other work.
☐ canonicalize() produces deterministic output for any manifest the Safebox
  side might send. Key sorting, no whitespace, integer-only numbers.
  (Re-verify against test/testModelsCanonical.js test vectors.)
☐ The install flow computes the canonical hash and rejects if it doesn't
  match the supplied manifestHash. This check happens BEFORE any download.
☐ Every downloaded file has its SHA-256 verified against the manifest
  BEFORE being moved from staging to the active models directory.
☐ Size cap on each file (200 GB) prevents OOM / disk fill.
☐ HTTPS-only sources. Plain http URLs are rejected at manifest validation.
☐ Per-file source fallback: if one source fails, try the next. All sources
  exhausted -> DOWNLOAD_FAILED (502), no partial install.
☐ Atomic install via rename from staging dir. If anything throws, staging
  dir is rm'd and the active models dir is never touched.
☐ Atomic remove via rename to .trash then rm. No window where the model
  dir exists in a corrupt state.
☐ The directory name on disk IS the manifest hash. An auditor can hash
  the manifest.json inside the directory and confirm it matches.
☐ Verify endpoint actually re-reads every byte and re-hashes it. Not just
  checking file existence.
☐ Path traversal in manifest files[].path is rejected at validation
  (../, leading /, backslash, etc.)
```

### 3.11 — Smoke test (end-to-end)

```bash
# As root, with the system component running:
SECRET_HEX=$(xxd -p /run/safebox/keys/<name>/system.hmac | tr -d "\n")  # the per-container key; the master is never on disk
# Run the smoke harness from the repo:
node aws/scripts/components/system/test/smoke.js
```

```
☐ T1: signed /healthz returns 200
☐ T2: bad signature returns 401
☐ T3: replayed nonce returns 401 with reason=nonce_reuse
☐ T4: unknown endpoint returns 404
☐ T5: unknown managedContainer returns BAD_REQUEST
☐ T6: tool not in allowedActions returns 403 FORBIDDEN_ACTION
☐ T7: --registry=evil package name returns BAD_REQUEST
☐ T8: valid /system request reaches execFile (returns NPM_OP_FAILED if npm not in PATH for this sandbox, or OK if installed)
☐ T9: workspaceRoot=/etc returns WORKSPACE_NOT_FOUND
☐ T10: image not matching imagePattern returns IMAGE_NOT_ALLOWED
☐ T11: GET /test/<unknown> returns 404 TEST_NOT_FOUND
☐ T12: audit log shows one entry per request with managedContainer, tool, action, durationMs
```

### 3.12 — What is intentionally absent

Compared to the prior daemon designs:

```
☐ No long-polling, no /jobs subsystem, no internal job state machine
☐ No keepalive timers in the system component except for /test/<id> environments
☐ No request-files-in-/run/safebox/jobs (no filesystem-mediated wire)
☐ No polkit rule, no systemd templates per-operation
☐ No HMAC over per-op tokens; HMAC is at the HTTP layer only
☐ No exec, no eval, no shell:true, no string-concat command lines anywhere
☐ No catch-all "system.exec" or "system.run" endpoint
☐ No remote / cross-host listener; loopback only
☐ No retry / backoff state held on the system component; clients retry if they want to
☐ No NPM dependencies (package.json has dependencies: {})
```

If anything in this list IS present in `/opt/safebox/system/`, the audit fails — it means someone added capability that wasn't reviewed.

## Phase 4 — Cross-Component Verification

These checks span multiple components and verify the cascade is coherent.

### 4.1 — Cascade manifest integrity

```bash
ls /opt/safebox/manifests/
sha256sum /opt/safebox/manifests/*.json
```

```
☐ One manifest per installed component. For 1.0 that means exactly two:
    base.json, system.json
☐ Each manifest declares its own SHA256 (or the parent cascade.json does)
☐ The cascade.json (or equivalent parent manifest) lists every component
  and its SHA256
☐ Computing SHA256 of the cascade.json file matches what verify-attestation.sh expects
☐ TPM PCR for the cascade matches the computed value
```

> If you find any third manifest beyond base.json and gateway.json, flag it. 1.0 ships exactly those two components. Additional tiers (llm-*, media, vision, speech) are documented in `docs/future/` but not buildable yet.

### 4.2 — User account inventory

```bash
getent passwd | grep -E 'safebox|nginx|apache|mysql|docker'
```

```
☐ Exactly these system users exist (no extras):
    apache, mysql, nginx, safebox-infra, dockremap, nobody (system default)
☐ The `safebox-infra` user is the runtime user for the system component
    - shell is /sbin/nologin
    - home is /var/empty
    - member of the `safebox-infra-readers` group
☐ Each system user has /sbin/nologin or /usr/sbin/nologin shell (none have /bin/bash)
☐ None have a home directory writable by themselves
☐ None are in the wheel/sudo group
☐ No user has UID 0 except root
☐ No duplicate UIDs (run `awk -F: '{print $3}' /etc/passwd | sort | uniq -d`)
```

### 4.3 — File permissions sanity

```bash
# Check that secrets are NOT world-readable
find /srv /opt/safebox /etc/safebox -type f \( -perm /o+r -o -perm /o+w \) -ls 2>/dev/null | \
    grep -E "(key|secret|token|password|credential|hmac)"
```

```
☐ No file matches the above (all secrets are non-world-readable)
☐ /run/safebox/zfs-key is mode 0400, owner root
☐ /run/safebox/hmac-seed is mode 0400, owner root; no file named system.hmac exists outside /run/safebox/keys/*/
☐ /etc/safebox/aws-nitro-root.pem is mode 0644 (public; pinned by fingerprint)
☐ /etc/shadow is mode 0600 (or 0640, group=shadow)
☐ /etc/sudoers and /etc/sudoers.d/ are mode 0440
☐ No SUID binaries in /opt/safebox/ or /srv/ (run `find /opt/safebox /srv -perm -4000 -ls`)
☐ No SGID binaries in /opt/safebox/ or /srv/ (run `find /opt/safebox /srv -perm -2000 -ls`)
```

### 4.4 — Kernel hardening sysctls

```bash
sysctl kernel.kptr_restrict kernel.dmesg_restrict kernel.yama.ptrace_scope \
       kernel.unprivileged_bpf_disabled net.ipv4.conf.all.rp_filter \
       net.ipv4.conf.all.accept_redirects net.ipv4.conf.all.send_redirects \
       net.ipv6.conf.all.accept_redirects
```

```
☐ kernel.kptr_restrict = 2 (kernel pointers hidden)
☐ kernel.dmesg_restrict = 1 (dmesg requires CAP_SYSLOG)
☐ kernel.yama.ptrace_scope = 2 or 3 (ptrace restricted)
☐ kernel.unprivileged_bpf_disabled = 1 (no unprivileged eBPF)
☐ net.ipv4.conf.all.rp_filter = 1 (reverse path filtering)
☐ net.ipv4.conf.all.accept_redirects = 0
☐ net.ipv4.conf.all.send_redirects = 0
☐ net.ipv6.conf.all.accept_redirects = 0
☐ net.core.bpf_jit_harden = 2 (if eBPF is used at all)
☐ fs.protected_hardlinks = 1
☐ fs.protected_symlinks = 1
```

If any of the above are missing or wrong, flag for the build team. install-base.sh should set these.

### 4.5 — Systemd unit hardening

For each non-trivial service (nginx, php-fpm, mariadb, docker, safebox-system):

```bash
systemctl show <unit> -p NoNewPrivileges,ProtectSystem,ProtectHome,PrivateTmp,\
                          PrivateDevices,RestrictAddressFamilies,MemoryMax,TasksMax
```

```
☐ NoNewPrivileges=yes for nginx, php-fpm, mariadb (Docker daemon may need this off;
    safebox-system MUST be off because the system component uses sudo to elevate for
    dnf/zfs/docker — see Phase 3.3 sudoers audit)
☐ ProtectSystem=strict or full for all
☐ ProtectHome=yes for all
☐ PrivateTmp=yes for all
☐ MemoryMax is set (not "infinity") for all
☐ TasksMax is set (not "infinity") for all
☐ RestrictAddressFamilies excludes AF_NETLINK where not needed (e.g. php-fpm)
☐ CapabilityBoundingSet is restricted (not the default of all caps)
```

### 4.6 — Network egress posture

```bash
iptables -L OUTPUT -n -v
ip6tables -L OUTPUT -n -v
```

```
☐ Default OUTPUT policy is DROP (or REJECT) at the host level
  (If it's ACCEPT, all egress restriction relies on the AWS security group, which is
   a different trust boundary — flag for the build team to consider host-level egress rules)
☐ Egress rules allow:
    - DNS (UDP/TCP 53) to AWS VPC resolver
    - HTTPS (TCP 443) to AWS API endpoints
    - HTTPS to package repositories (during build only — should be removed post-build)
    - Whatever else specific components legitimately need
☐ No egress rule for SMTP (25), DNS (53) to arbitrary destinations, or HTTP (80)
  unless a specific component needs it (in which case the rule should be component-specific)
```

If host-level egress is wide open, that's not necessarily a bug, but the auditor should flag it as a defense-in-depth gap. The Safebox plugin's Protocol.HTTP layer enforces SSRF protections, but host-level firewall rules would be a backstop.

---

## Phase 5 — Image Identity Verification

The production AMI is the audit AMI after the seal script runs. This phase confirms that the seal script introduces ONLY the documented changes, and that the production image's root hash ties back to the bytes you inspected.

### 5.1 — Seal script diff

The seal script (`safebox-seal-image.sh`) is the only step between the audit AMI you inspected and the production AMI clients deploy. The script writes exactly ONE file:

```
☐ Added: /etc/safebox/sealed (mode 0444) — the flag that triggers production-only hardening at boot
```

No other files should differ. To verify, compare the audit chroot directory tree before and after running `safebox-seal-image.sh --chroot` — the diff must contain ONLY the single added file above. The seal script does NOT remove SSH, modify accounts, or scrub any files; those operations happen at boot time via `safebox-sealed-boot.service` (see 5.2 below).

### 5.2 — Production boot hardening

On a sealed production AMI, `safebox-sealed-boot.service` applies hardening at boot. SSH binaries and config remain on the dm-verity root but are masked via overlay whiteouts — the kernel returns ENOENT for those paths even though the files exist on the read-only lower layer. Verify on a test instance booted from the sealed image:

```
☐ /etc/safebox/sealed exists (mode 0444)
☐ systemctl status safebox-sealed-boot.service shows active (exited), success
☐ SSH units are masked: systemctl is-enabled ssh.service shows "masked"
☐ No SSH binaries visible: ! test -x /usr/sbin/sshd (overlay whiteout hides it)
☐ No /etc/ssh directory visible: ! test -d /etc/ssh (overlay whiteout)
☐ No SSH listener: ss -tnlp shows nothing on port 22
☐ No safebox-audit home visible: ! test -d /home/safebox-audit (overlay whiteout)
☐ sysctl kernel.modules_disabled returns 1
☐ findmnt /proc shows hidepid=2
```

### 5.3 — Cascade hash verification

```
☐ Build the audit AMI. Record its verity root hash.
☐ The production AMI must have a different root hash (the seal script modifies the file set).
☐ The only differences between the two are those enumerated in 5.1 above.
☐ Auditor hash reproduction:
    1. Extract the audit AMI's root filesystem (mount the EBS snapshot read-only)
    2. Run: safebox-seal-image.sh --chroot /mnt/audit-root
    3. Run: SOURCE_DATE_EPOCH=0 build-verity-root.sh /mnt/audit-root /dev/target-disk <grub-hash>
    4. The ROOTHASH output must match the production AMI's root hash from the build manifest
☐ Rebuild from the same source tree, hours later, on a different builder. Both the audit and production root hashes must be byte-identical to the first build. (If not, the build has nondeterministic inputs somewhere — bug for build team.)
☐ Reproducibility: a third party (not the build team) checks out the same git commit, runs build-image.sh, and produces root hashes byte-identical to what the build team published. This is the gold standard.
```

### 5.4 — Root hash verification

```
☐ veritysetup verify on the production AMI's SAFEBOX-ROOT and SAFEBOX-HASH partitions succeeds with the root hash from manifests/aws-<date>.json
☐ The root hash on the kernel command line in /boot/grub/grub.cfg equals that hash
☐ The inventory digest in the manifest equals sha256 of the inventory recomputed from the rootfs
```

---

## Phase 6 — Out-of-Band Verification

Things the auditor must verify outside the running instance:

### 6.1 — Source code review

```
☐ Read scripts/components/base/install-base.sh end to end
☐ Read scripts/components/system/install-system.sh end to end
☐ Read scripts/build-ami.sh end to end
☐ Read scripts/generate-attested-key.sh end to end
☐ Read scripts/verify-attestation.sh end to end
☐ Read common/seal/safebox-seal-image.sh end to end (writes the sealed flag — the only change between audit and production)
☐ Read common/seal/safebox-sealed-boot.service (boot-time hardening: masks SSH via overlay whiteouts, sets modules_disabled and hidepid)
☐ Read the daemon source code for the system component (likely Python, Node, or Go)
☐ Verify all secrets in code are NOT hardcoded (no API keys, no default passwords)
☐ Verify all SHA256 manifests in the repo match the actual built artifacts
```

### 6.2 — Build provenance

```
☐ The build was performed on a clean machine (no leftover state from previous builds)
☐ The build inputs (git commit, build flags, base AMI ID) are fully recorded
☐ The build outputs (cascade hash, file manifest) are published
☐ Build logs are signed by the build team and provided to clients alongside the AMI
```

### 6.3 — Signer set for M-of-N

```
☐ The signer set (the N pubkeys) is documented
☐ Each signer is a distinct entity (different organizations, different jurisdictions ideally)
☐ The threshold M is appropriate for the threat model (typically M >= 3 and N <= 7)
☐ The signer set is published and clients can verify it independently
☐ Key rotation policy is documented (how do new signers get added? how is one revoked?)
```

---

## What to Report

After completing all phases, the auditor should produce a sign-off document containing:

1. **Cascade hash** of the production (sealed) AMI — this is what clients will pin to
2. **Confirmation** that the seal script introduces ONLY the documented differences between the audit AMI and the production AMI
3. **List of findings** by severity:
    - CRITICAL: blocks sign-off
    - HIGH: must be fixed before sign-off
    - MEDIUM: documented and acknowledged, may be fixed post-launch
    - LOW: noted for future work
4. **Confirmation** of source code review for each script listed in Phase 6.1
5. **Confirmation** that the M-of-N signer set is appropriate
6. **Auditor's signature** over the cascade hash + findings document

The signed sign-off document, together with the cascade hash, is what clients use to select the AMI with confidence.

---

## Re-Audit Triggers

A new audit (covering at minimum Phases 1–5) is required when:

- The cascade hash changes for any reason
- A new component is added to the AMI
- An existing component installer is modified
- A package version is bumped
- The kernel version is bumped
- Any of the trust-root scripts (generate-attested-key, build-image, verify-attestation, safebox-seal-image) are modified
- The M-of-N signer set is modified
- A CVE is discovered affecting any installed package (a new build incorporates the fix)

The audit need NOT cover everything from scratch each time, but the diff from the last audited cascade hash must be reviewed and explicitly approved.

---

## Glossary

- **Audit AMI**: The pre-seal image — has SSH and a `safebox-audit` user. What the auditor logs into and inspects.
- **Production AMI**: The sealed image — identical to the audit AMI plus the sealed flag. SSH masked at boot via overlay whiteouts, `kernel.modules_disabled=1` and `hidepid=2` applied at boot. What clients deploy.
- **Seal script**: `safebox-seal-image.sh --chroot <rootfs>` — writes the `/etc/safebox/sealed` flag file. The only on-disk change between Image A and Image B.
- **Sealed flag**: `/etc/safebox/sealed` — written by the seal script; triggers production hardening at boot via `safebox-sealed-boot.service`.
- **Overlay whiteout**: A special directory entry in the tmpfs upper layer of an overlayfs mount. The kernel returns ENOENT for the whited-out path even though the file exists on the read-only dm-verity lower layer.
- **Cascade hash**: SHA256 over the concatenation of all component manifest hashes. The single hash that represents the AMI's entire content.
- **M-of-N**: A threshold signature scheme. M signatures from a set of N signers are required to authorize an operation.
- **Cascade**: The chain of measurements from boot loader → kernel → initramfs → rootfs → installed components → final attestation.
