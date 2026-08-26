# Safebox AMI Audit Guide

> **Audience**: External security auditors reviewing a Safebox AMI before client selection. Also useful for internal pre-audit verification.
>
> **Goal**: Verify that the AMI, as built, behaves identically before and after SSH removal — so the post-removal AMI can be byte-identically attested while the pre-removal AMI is what auditors actually inspect.

---

## The Two-AMI Model

Safebox attestation depends on a specific workflow that this audit must validate:

1. **AMI-A (audit AMI)** — built by `build-ami.sh` with SSH and an audit user, otherwise identical to the production AMI. This is what you, the auditor, log into and inspect.

2. **AMI-B (production AMI)** — built by the same `build-ami.sh` with the `--remove-ssh` flag. After SSH and SSM-agent removal, the cascade SHA256 changes (because the file set changes). Clients select AMI-B by its cascade hash; that's the immutable contract they pin.

3. **The byte-identity claim**: every file in AMI-B that exists in AMI-A is byte-identical to its AMI-A counterpart. The only differences are file REMOVALS (sshd, ssh client, ssm-agent, getty units) and the resulting manifest hash changes. No file is silently modified between the two.

Your job is to verify that claim holds and that AMI-A — which is what you can actually inspect via SSH — is a faithful proxy for AMI-B.

If at the end of this audit you sign off on AMI-A, the build system rebuilds AMI-B from the same inputs, removes the audit-only files, and ships AMI-B to clients with a cascade hash they can independently verify against your sign-off.

---

## Pre-Audit Verification by the Build Team

Before handing you AMI-A, the build team should have already verified:

```
☐ git clean -fdx; git status reports clean working tree
☐ git log -1 shows the commit being audited; no uncommitted changes
☐ scripts/build-ami.sh ran with no warnings or errors
☐ scripts/verify-build.sh passed all gates
☐ scripts/diff-amis.sh AMI-A AMI-B confirms only EXPECTED differences
☐ The cascade SHA256 for AMI-B is computed and recorded
☐ AMI-A is launched and reachable via SSH using audit credentials
```

If any of these are unchecked, the AMI is not ready for audit. Push back to the build team.

---

## Phase 1 — Trust Root Audit

This is the highest-priority section. If anything here is wrong, nothing else matters.

### 1.1 — Attested key generation (`scripts/generate-attested-key.sh`)

This script generates the ZFS encryption key sealed to TPM PCRs. It runs ONCE during the build process, before `install-base.sh`.

**Read the script. Verify:**

```
☐ Key material comes from /dev/urandom or getrandom() — NOT from /dev/random (blocking),
  NOT from a deterministic source (timestamp, hostname, hash of build inputs), NOT
  from a fixed seed.

☐ Key length is 32 bytes (256 bits) for AES-256-GCM. Anything less is a bug.

☐ TPM2 sealing is done with tpm2_create + tpm2_load (or equivalent), NOT with the
  older tpm-tools that have known timing issues.

☐ The PCR selection bound to the sealing policy includes at minimum:
    PCR 0  (UEFI firmware)
    PCR 1  (UEFI configuration)
    PCR 2-3 (option ROMs)
    PCR 4  (boot loader)
    PCR 5  (boot loader configuration)
    PCR 7  (Secure Boot state, if SB is enabled)
    PCR 8-9 (bootloader stages)
    PCR 14 (initramfs / kernel command line)

  If the selection includes fewer PCRs, the key will be released too easily (less
  binding to the boot state). If it includes MORE PCRs (e.g. PCR 10 which is IMA),
  the key may fail to release after legitimate runtime measurements, breaking the
  AMI in production.

☐ The sealed blob is written to a deterministic location (/srv/safebox/runtimes/
  tpm-sealed-zfs-key.blob or similar) with mode 0400 owned by root.

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
    8. Final hardening pass (remove-ssh.sh if --remove-ssh flag)
    9. Cascade SHA256 computation
    10. TPM attestation seal

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

☐ The `--remove-ssh` flag, when present, runs a specific script (e.g.
  remove-ssh.sh) AFTER all other components. The pre-removal AMI (without the
  flag) and post-removal AMI (with the flag) must produce file sets that differ
  ONLY by the removed files — no other file changes between AMI-A and AMI-B.
```

**Then verify behavior:**

```
☐ Run `build-ami.sh base` and `build-ami.sh base,system`. The second build should
  not modify any file produced by the first; it should only ADD files. Compare
  with `sha256sum` on each file in both builds.

☐ Inject a deliberate failure into one component installer (e.g. add `exit 1` to
  install-system.sh) and verify the entire build aborts with a non-zero exit code.
  Verify no AMI is produced.

☐ Run `build-ami.sh base,system --remove-ssh` and `build-ami.sh base,system`
  (no flag). Diff the file sets. The ONLY differences should be:
    - /usr/sbin/sshd removed
    - /usr/bin/ssh, /usr/bin/scp, /usr/bin/ssh-* removed
    - /usr/sbin/amazon-ssm-agent removed
    - /etc/ssh/* removed
    - getty@.service and serial-getty@*.service masked (symlinks to /dev/null)
    - /opt/safebox/manifests/base.json updated (different sshdRemoved/ssmAgentRemoved values)
    - Cascade SHA256 different
  ANYTHING ELSE in the diff is a bug.
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

### 2.4 — Shell-access removal (AMI-A pre-check / AMI-B verification)

**On AMI-A (with audit SSH still present)**, the following packages are intentionally retained for audit access:

```
☐ openssh-server is installed (for audit access)
☐ The audit user 'safebox-audit' exists with the build team's pubkey in authorized_keys
☐ sshd is running and listening on port 22
☐ NO other shell-access mechanism is enabled:
    ☐ rpm -q amazon-ssm-agent returns "not installed"
    ☐ rpm -q telnet-server returns "not installed"
    ☐ rpm -q rsh-server returns "not installed"
    ☐ rpm -q vsftpd returns "not installed"
    ☐ rpm -q proftpd returns "not installed"
    ☐ rpm -q cockpit returns "not installed"
```

**These are the ONLY differences between AMI-A and AMI-B.** Verify by inspecting the build output diff:

```bash
diff <(rpm -qa | sort) <(cat /opt/safebox/expected-AMI-B-rpms.txt)
```

```
☐ Diff shows EXACTLY these removals: openssh-server, openssh-clients, openssh
☐ Diff shows NO additions or modifications
☐ /etc/ssh/ exists on AMI-A but is absent in AMI-B's expected file list
☐ /etc/systemd/system/multi-user.target.wants/sshd.service exists on AMI-A,
  absent on AMI-B
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
☐ Port 22 (SSH) is listening on 0.0.0.0 — AMI-A only (audit access)
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

For AMI-B verification (this can be done by the build team running the verify-build.sh script on the post-removal AMI):

```
☐ Port 22 is NOT listening on AMI-B
☐ amazon-ssm-agent process is not running on AMI-B
☐ All other listeners are identical to AMI-A
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
  (Note: on AMI-A, the policy is "audit-mode" or similar; on AMI-B it's "zero-interactive-access".
   The values WILL differ between A and B — that's expected and is part of the documented diff.)
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
ls -la /etc/safebox/managed-containers.json
ls -la /etc/safebox/system.hmac
ls -la /etc/safebox/containers/
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
☐ /etc/safebox/managed-containers.json exists, mode 0644 (or 0640), root:root
☐ /etc/safebox/system.hmac exists, mode 0640, root:safebox-infra-readers, length exactly 32 bytes
☐ /etc/safebox/containers/ exists, mode 0750, owner safebox-infra:safebox-infra
☐ /etc/safebox/containers/<name>.hmac files exist for every managed container,
    mode 0640, owner safebox-infra, length exactly 32 bytes each
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
☐ CONFIG_PATH defaults to /etc/safebox/managed-containers.json
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
SECRET_HEX=$(xxd -p /etc/safebox/system.hmac | tr -d "\n")
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
☐ /etc/safebox/system.hmac is mode 0640, group safebox-infra-readers
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

## Phase 5 — Diff Verification (Critical for the Two-AMI Model)

This phase is THE most important from the byte-identity standpoint. The build team's `scripts/diff-amis.sh` (if it exists, otherwise reproduce manually) should produce a verifiable diff between AMI-A and AMI-B.

### 5.1 — Allowed differences

Only these differences are expected between AMI-A and AMI-B:

```
☐ Removed: /usr/sbin/sshd
☐ Removed: /usr/bin/ssh, /usr/bin/scp, /usr/bin/sftp, /usr/bin/ssh-keygen, /usr/bin/ssh-add, /usr/bin/ssh-agent
☐ Removed: /etc/ssh/ (entire directory)
☐ Removed: /etc/pam.d/sshd
☐ Removed: /etc/systemd/system/multi-user.target.wants/sshd.service
☐ Removed: /var/lib/sss/pubconf/known_hosts (if SSSD integration is used)
☐ Removed: amazon-ssm-agent files (if installed on AMI-A — typically not, since
  ssm-agent is removed in install-base.sh, not the remove-ssh step)
☐ Modified: /opt/safebox/manifests/base.json — fields sshdRemoved, ssmAgentRemoved,
  ttyLoginsDisabled, shellAccessPolicy will differ
☐ Modified: /opt/safebox/manifests/cascade.json — cascade hash differs
☐ Removed: the audit user account 'safebox-audit' from /etc/passwd, /etc/shadow, /etc/group
☐ Removed: /home/safebox-audit/ (entire home directory)
☐ Added: getty@.service, serial-getty@*.service masked (symlinks to /dev/null in
  /etc/systemd/system/) — these may already be masked on AMI-A; verify
```

### 5.2 — Forbidden differences

The following must be IDENTICAL between AMI-A and AMI-B. If any differ, the byte-identity claim is broken and the audit must restart:

```
☐ All package versions in rpm -qa output (except openssh-* removed on AMI-B)
☐ All file contents in /opt/safebox/ (except manifest files which are explicitly noted above)
☐ All file contents in /srv/safebox/ (except auth.token which is regenerated per build — flag below)
☐ All systemd unit files in /etc/systemd/system/ (except sshd.service and ssh.service)
☐ All sysctl values
☐ All auditd rules
☐ All php.ini settings
☐ All Docker daemon settings
☐ ZFS dataset layout and properties
☐ User accounts (except safebox-audit which is removed on AMI-B)
☐ All kernel command-line parameters (`/proc/cmdline`)
☐ Kernel version and modules
☐ Initramfs contents
```

### 5.3 — The auth token regeneration concern

The auth token at `/srv/safebox/runtimes/system/auth.token` is generated from `/dev/urandom` at build time. This means **AMI-A and AMI-B will have different auth tokens**, and that token contents will be part of the cascade hash.

This is a problem for byte-identity. The build team must handle it one of two ways:

```
☐ EITHER: The auth token is generated at FIRST BOOT, not build time. The AMI ships
  with a placeholder or empty token file; the first boot generates and seals the
  real token to TPM. Both AMI-A and AMI-B then have the same placeholder content,
  preserving byte-identity. (Recommended approach.)
☐ OR: The auth token is generated from a deterministic source bound to the
  cascade hash, so AMI-A and AMI-B both compute the same token. (Not recommended
  because it leaks the token through the cascade hash itself.)
☐ OR: The auth token is excluded from the cascade hash entirely. (Acceptable if
  there's a separate runtime attestation of the token's provenance.)
```

The auditor must determine which approach the build team uses and verify it works. If the build team has a fourth approach not listed here, document it and verify the byte-identity claim holds under it.

### 5.4 — Cascade hash verification

```
☐ Build AMI-A. Record its cascade hash.
☐ Build AMI-B from the same input + --remove-ssh flag. Record its cascade hash.
☐ The two hashes MUST differ (they cover different file sets).
☐ Rebuild AMI-B from the same source tree, hours later, on a different builder.
  The new AMI-B's cascade hash MUST be byte-identical to the first AMI-B.
  (If not, the build has nondeterministic inputs somewhere — bug for build team.)
☐ Same test for AMI-A: rebuild later, hash must match.
☐ Reproducibility: a third party (not the build team) checks out the same git
  commit, runs build-ami.sh with the same flags, and produces a cascade hash
  byte-identical to what the build team published. This is the gold standard.
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
☐ Read scripts/remove-ssh.sh end to end (the script that produces AMI-B from AMI-A's intermediate state)
☐ Read scripts/diff-amis.sh (or reproduce it manually)
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

1. **Cascade hash** of AMI-B (the production AMI) — this is what clients will pin to
2. **Confirmation** that AMI-A is a faithful proxy for AMI-B except for the documented differences
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
- Any of the trust-root scripts (generate-attested-key, build-ami, verify-attestation, remove-ssh) are modified
- The M-of-N signer set is modified
- A CVE is discovered affecting any installed package (a new build incorporates the fix)

The audit need NOT cover everything from scratch each time, but the diff from the last audited cascade hash must be reviewed and explicitly approved.

---

## Glossary

- **AMI-A**: The audit AMI — has SSH and an audit user. What the auditor logs into.
- **AMI-B**: The production AMI — built from same source with `--remove-ssh` flag. What clients deploy.
- **Cascade hash**: SHA256 over the concatenation of all component manifest hashes. The single hash that represents the AMI's entire content.
- **Byte-identity claim**: That AMI-B's files (excluding documented removals) are byte-for-byte identical to AMI-A's. Verified by `diff-amis.sh`.
- **M-of-N**: A threshold signature scheme. M signatures from a set of N signers are required to authorize an operation.
- **Cascade**: The chain of measurements from boot loader → kernel → initramfs → rootfs → installed components → final attestation.
