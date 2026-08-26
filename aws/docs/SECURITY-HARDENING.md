# Safebox AMI Security Hardening

> **Pre-release 1.0.0**: This document describes the security posture of the base AMI as built by `scripts/components/base/install-base.sh`. The previous version of this document described a hardening model that permitted SSH and AWS SSM Session Manager for "emergency access." That was wrong. This version describes the correct model — zero interactive access, ever.

---

## The Zero-Shell-Access Policy

The Safebox attestation model rests on a simple guarantee: **the running code is exactly the code that was attested at boot**. TPM 2.0 measures the boot chain, the kernel, the initrd, and the root filesystem hash; the ZFS encryption keys are sealed to those PCR values and only released when they match. A modified boot artifact produces different PCRs, the keys are not released, and the instance cannot mount its data.

That guarantee is broken the moment any human gets an interactive shell on the running instance, regardless of how that shell arrives.

| Access path | What attestation guarantees | What it does not guarantee |
|-------------|----------------------------|----------------------------|
| TPM measured boot | The kernel + initrd + rootfs hash matches | Any process can do whatever the kernel allows once running |

Once you have a shell, you can:

- `dd if=/dev/sda > exfil.img` — read the unencrypted boot partition
- `cat /run/safebox/zfs-key` — steal the in-memory ZFS key
- `nsenter` into a container, escape the namespace
- `kexec` a new kernel without rebooting (no new attestation cycle)
- Patch a running binary in memory — the on-disk image is unchanged, so the next attestation cycle still passes

This isn't theoretical. It's the difference between "the boot was clean" (which attestation can prove) and "everything happening on this machine since boot is clean" (which attestation can't prove for a system that allows shells).

So the policy is: **no human is ever inside an attested Safebox instance**. If something goes wrong, you don't fix it in place. You terminate the instance, snapshot the encrypted ZFS volume for offline forensic analysis, and replace the instance from an attested image.

---

## What the Installer Removes

`install-base.sh` removes every interactive-shell mechanism it can find, in four tiers, and verifies the removal succeeded.

### Tier 1 — Legacy remote-access daemons

```
telnet, telnet-server      (CVE-2026-32746)
rsh, rsh-server, rlogin
vsftpd, proftpd
tftp, tftp-server
cockpit, cockpit-ws, cockpit-bridge
webmin
```

These were never appropriate for an attested system. They're removed both because their security history is poor (telnetd's CVE-2026-32746 is the headline case, but the others have similar issues) and because they're shell-access mechanisms by design.

### Tier 2 — SSH

```
openssh-server, openssh-clients, openssh
```

Yes, even SSH. This is the one most ops teams push back on, because SSH is the universal expectation. The right response is: **you should not be operating an attested system if you need to log in to it.** If a service breaks, the instance is terminated and replaced. Diagnostics happen against an offline ZFS snapshot in a separate environment, not on the live instance.

If the absence of SSH is operationally infeasible for your team, the Safebox attestation guarantee is not the security model you actually want. There are perfectly reasonable architectures that allow SSH and use other defenses (network segmentation, jump hosts, just-in-time access, MFA). Those architectures don't promise what attestation promises — and Safebox is built around the promise that attestation can actually keep.

### Tier 3 — AWS SSM Session Manager

```
amazon-ssm-agent
```

This is the trap. The SSM agent IS a remote-shell mechanism. From the kernel's perspective, there's no meaningful difference between SSH (`sshd` accepts a TCP connection and spawns `/bin/bash` for an authenticated user) and SSM Session Manager (`amazon-ssm-agent` polls AWS, receives a session start, and spawns `/bin/bash` for an authenticated user). Both are interactive shells reachable by anyone with the right credentials.

People sometimes argue "SSM is safer than SSH because it goes through AWS IAM instead of an SSH key." That's the wrong frame. The threat model isn't "the SSH key leaked"; the threat model is "anyone, including the cloud provider, can get a shell on this box." SSM means AWS IAM credentials are sufficient. SSH means the SSH key is sufficient. Both are interactive-access channels that defeat the attestation model. Removing SSH while keeping SSM is moving the threat surface from one credential type to another — not eliminating it.

**Important distinction**: removing `amazon-ssm-agent` does NOT remove AWS API access from inside the instance. If your application needs to call S3, KMS, or any AWS API, attach an IAM role to the instance. The IAM role mechanism uses the instance metadata service (`169.254.169.254`); it is a credential-issuance mechanism, not a remote-shell mechanism. We block that endpoint from capability code via SSRF (see Safebox plugin Protocol.HTTP) but the legitimate IAM-role mechanism for application code keeps working.

What you lose with SSM agent removed:
- `aws ssm start-session` — no, you cannot use this
- `aws ssm send-command` — no, you cannot use this

What you keep:
- IAM-role-based AWS API calls from inside the instance — works normally
- Outbound HTTPS to AWS services — works normally
- CloudWatch metrics and logs via the regular API path — works normally

### Tier 4 — TTY/console getty

```
systemctl mask getty@.service
systemctl mask serial-getty@ttyS0.service
systemctl mask debug-shell.service
```

This prevents login prompts on TTYs and the serial console. Even if someone enables EC2 Serial Console access at the AWS account level, there's no login prompt to interact with — they'd see kernel output but couldn't authenticate.

Operators who want belt-and-suspenders should also disable EC2 Serial Console at the AWS account level. The setting is account-wide and is OFF by default; if you've never enabled it, you're already covered.

### Socket-unit masking

After uninstalling the packages, the installer also masks the socket and service units for each removed daemon. This prevents a future package update (or a misbehaving dependency pull) from reactivating any of them silently.

```
telnet.socket   rsh.socket   vsftpd.service   cockpit.socket
sshd.service    sshd.socket  ssh.service      ssh.socket
amazon-ssm-agent.service
```

### Verification gates

The installer doesn't trust that the removal worked. It verifies each tier:

```bash
# Telnetd
if command -v telnetd &>/dev/null || rpm -q telnet-server &>/dev/null 2>&1; then
    echo "ERROR: telnetd still present"
    exit 1
fi

# SSH
if command -v sshd &>/dev/null || rpm -q openssh-server &>/dev/null 2>&1; then
    echo "ERROR: sshd still present"
    exit 1
fi

# SSM
if rpm -q amazon-ssm-agent &>/dev/null 2>&1; then
    echo "ERROR: amazon-ssm-agent still present"
    exit 1
fi

# No process listening on common remote-shell ports
for port in 22 23 513 514 5985 5986; do
    if ss -tnl | awk '{print $4}' | grep -q ":${port}$"; then
        echo "ERROR: service listening on port $port"
        exit 1
    fi
done
```

If anything fails, the install aborts. We don't ship AMIs that retain shell-access mechanisms.

---

## What That Means Operationally

### "How do I debug a broken instance?"

You don't. You terminate it.

1. Take a ZFS snapshot of the encrypted dataset (this happens automatically on every shutdown, or you can trigger it via the AWS API).
2. Terminate the instance.
3. Mount the snapshot in a separate forensic environment (a dedicated debug AMI with the same ZFS key, running in an isolated VPC).
4. Analyze the snapshot offline. The original instance is gone; the encryption key for the snapshot is only available to the forensic environment for a limited time window.

This is more expensive than "SSH in and grep some logs." It's also fundamentally different from the operational model most teams are used to. The trade-off is that the attestation guarantee actually holds, because nothing about the production instance is mutable except via a new boot from a new attested image.

### "What if I need to push a config change?"

You don't push changes to a running instance. You rebuild an AMI with the new config (which produces a new cascade SHA256, which TPM measures), deploy that AMI, and roll the fleet. Old instances terminate; new instances boot with the new attested config.

This is sometimes called "immutable infrastructure" — but with attestation, it's not optional. Mutable infrastructure breaks the attestation guarantee by definition.

### "What about CloudWatch and observability?"

Observability doesn't require shells. The Safebox instance pushes logs and metrics outbound through normal APIs (CloudWatch Logs, CloudWatch Metrics, custom log shipping). All of that uses the IAM-role mechanism on the metadata endpoint, not SSM agent. You get full observability of the instance from the outside without any inbound access path.

### "What about installing security patches?"

You don't install patches on a running instance. You rebuild the AMI with the patched base, redeploy, and roll. This is the same pattern as config changes — and again, it's not optional under attestation.

---

## ZFS Encryption Setup

The base installer creates four encrypted ZFS datasets:

| Dataset | Quota | Used For |
|---------|-------|----------|
| `safebox-pool/safebox` | 20 GB | Binaries, models, runtime configs |
| `safebox-pool/docker` | 100 GB | Container images and layer cache |
| `safebox-pool/mariadb` | — | MariaDB datadir (per-tenant sub-datasets get their own quotas) |
| `safebox-pool/tenants` | — | Tenant file uploads (per-tenant sub-datasets) |

Each dataset uses:
- `encryption=aes-256-gcm` (FIPS-friendly, AES-NI accelerated)
- `keyformat=raw`
- `keylocation=file:///run/safebox/zfs-key`

The key file at `/run/safebox/zfs-key` is generated by `scripts/generate-attested-key.sh` (sealed to TPM PCRs) BEFORE `install-base.sh` runs. The key is only available after a measured boot where the PCR values match the attested image. A compromised kernel image won't see the key released, so ZFS won't mount.

This is where the zero-shell policy pays off: the ZFS key sits in `/run/safebox/zfs-key`, in memory, on tmpfs. If an attacker could open a shell, they could `cat` that file. Without shell access, the key is reachable only by processes the attested boot chain authorized to read it (the ZFS subsystem itself, plus a small allowlist of systemd units).

---

## Package Reproducibility

### System packages (dnf)

All system packages are version-pinned in `install-base.sh`:

```bash
SYSTEM_PACKAGES=(
    "mariadb105-server-10.5.24"
    "php-fpm-8.3.6"
    "nginx-1.26.2"
    "docker-ce-25.0.5"
    "nodejs-20.18.0"
    "npm-10.8.2"
    "zfs-2.2.6"
    "iptables-1.8.10"
    "auditd-3.1.5"
    "fail2ban-1.0.2"
)
```

After install, the script verifies each package is at the pinned version. If anything mismatched (e.g., the mirror served a different patch level), the build fails.

### npm packages

The base npm packages (50+ for document generation, image processing, etc.) are installed via `npm ci --ignore-scripts` from a checked-in `package.json` + `package-lock.json`.

`npm ci` verifies the SHA-512 integrity hash of every package tarball before unpacking. If any tarball doesn't match its locked hash, npm refuses to install. This prevents:

- **Tarball replacement attacks** — Even if an attacker compromises the npm registry, replacing a tarball causes its hash to mismatch the lockfile.
- **Version drift** — `npm install` would happily fetch newer versions on a "minor" version bump if the lockfile is missing. `npm ci` only ever installs the exact versions in the lockfile.

`--ignore-scripts` blocks lifecycle scripts (`preinstall`, `install`, `postinstall`). This is the specific vector the May 2025 TanStack/"Mini Shai-Hulud" campaign exploited — compromised packages used postinstall hooks to modify `.claude/settings.json` and `.vscode/tasks.json`. Server-side packages don't need lifecycle scripts; if a specific dependency genuinely requires one, it can be re-enabled per-package in a controlled way.

### Cascade attestation

Every package install (system + npm) feeds into the cascade SHA256 manifest at `/srv/safebox/manifests/`. The build pipeline computes a final SHA256 over all component manifests; that hash is what TPM attests against at boot. A modified package — even a single byte different — produces a different manifest hash, different cascade, different attestation, and the AMI fails to release its ZFS keys.

See [CASCADING-MANIFESTS.md](CASCADING-MANIFESTS.md) for the full chain.

---

## Docker Daemon Hardening

`install-base.sh` writes `/etc/docker/daemon.json` with the following security defaults:

| Setting | Value | Effect |
|---------|-------|--------|
| `userns-remap` | `default` | Containers run as host UID 100000+ instead of host root |
| `no-new-privileges` | `true` | Containers can't gain privileges via setuid |
| `icc` | `false` | Containers can't talk to each other on the default bridge |
| `live-restore` | `true` | Docker daemon can restart without killing containers |
| `storage-driver` | `zfs` | Uses native ZFS instead of overlay2 (snapshots, encryption) |
| `log-driver` | `json-file` | With 100 MB × 5 file rotation cap |

`userns-remap` is the big one: without it, a process running as root inside a container is also root on the host kernel from a UID perspective. With it, container UID 0 is host UID 100000 — privilege escalation out of the container lands you in an unprivileged user space. Crucially, that unprivileged user space still can't reach the ZFS key (which is owned by root with mode 0400) or any other root-owned resource.

A `dockremap` user/group is also created (required by `userns-remap=default`).

---

## PHP-FPM Hardening

The base installer modifies `/etc/php.ini`:

| Setting | Default | Hardened | Rationale |
|---------|---------|----------|-----------|
| `expose_php` | `On` | `Off` | Hide PHP version in HTTP headers |
| `allow_url_fopen` | `On` | `Off` | Disable `file_get_contents('http://...')` — Safebox uses Protocol.HTTP, not raw fopen |
| `allow_url_include` | `Off` | `Off` (enforced) | Never allow `include 'http://...'` |
| `disable_functions` | (none) | `exec, passthru, shell_exec, system, proc_open, popen, curl_multi_exec, parse_ini_file, show_source, dl, phpinfo` | Disable shell exec from PHP — Safebox tools that need subprocess execution run in their own systemd units with their own configs |

Per-pool config (worker count, listen socket, user) is handled in `install-system.sh`.

---

## Auditd Configuration

The base installer enables auditing for security-sensitive events. The audit log is itself one of the things you'd want to consult during forensic analysis of a terminated instance's ZFS snapshot — it's append-only and bound to the encrypted dataset, so it captures kernel-level events that happened during the instance's lifetime.

```
-w /run/safebox/zfs-key       -p rwa    -k safebox_zfs_key
-w /usr/bin/dnf               -p x      -k safebox_pkg
-w /usr/bin/rpm               -p x      -k safebox_pkg
-w /usr/local/bin/npm         -p x      -k safebox_pkg
-w /usr/local/bin/composer    -p x      -k safebox_pkg
-w /etc/docker/daemon.json    -p wa     -k safebox_config
-w /etc/php.ini               -p wa     -k safebox_config
-w /etc/nginx/                -p wa     -k safebox_config
-a always,exit -F arch=b64 -S setuid -F a0=0 -F auid>=1000 -F auid!=4294967295 -k safebox_priv_esc
```

These complement the cryptographically-sealed append-only logs that the system component writes for plugin-level operations. Auditd catches kernel-level events; the system component's logs catch plugin-level events. Together they give a complete trail across an entire instance lifetime.

---

## Network Access Summary

After `install-base.sh` runs, the only network access to the instance is:

**Inbound (none by default)**:
- No SSH (port 22 closed)
- No telnet (port 23 closed, package removed)
- No RDP, VNC, FTP, TFTP
- No SSM Session Manager
- The `system` component (when installed) does NOT listen on any network port. It is a Node.js daemon (`safebox-system.service`) running as the unprivileged `safebox-infra` user; it accepts HMAC-signed JSON over **Unix domain sockets only** — one per managed container at `/run/safebox/containers/<name>.sock` plus one control socket at `/run/safebox/control.sock`. No TCP listener and no exposure outside the host.
- Application traffic — nginx on 443 with TLS, when configured by the application component (not the base)

**Outbound (limited by VPC/security-group)**:
- HTTPS to AWS API endpoints (for IAM-role-based credentials)
- HTTPS to configured upstream services (LLM providers, etc., via Safebox Protocol.HTTP)
- DNS to VPC resolver
- Whatever else the operator allows in their security group

**Out-of-band**:
- AWS EC2 Serial Console: depending on AWS account-level setting. The base installer masks getty units so even if Serial Console is enabled, there's no login prompt. We recommend disabling Serial Console at the account level anyway.
- Nitro hypervisor signals (instance lifecycle): unavoidable, but this is the AWS substrate, not the OS.

---

## Verification Checklist

After running `install-base.sh`, the build pipeline runs `scripts/verify-build.sh`, which checks:

- [x] `zpool list safebox-pool` shows the pool
- [x] `zfs list -t filesystem safebox-pool` shows the four datasets, all encrypted
- [x] `zfs get encryption,keystatus safebox-pool/safebox` shows `aes-256-gcm` and `available`
- [x] `command -v telnetd` returns non-zero (not found)
- [x] `rpm -q telnet-server` returns non-zero (not installed)
- [x] `command -v sshd` returns non-zero (SSH server not present)
- [x] `rpm -q openssh-server` returns non-zero (SSH package not installed)
- [x] `rpm -q amazon-ssm-agent` returns non-zero (SSM agent not installed)
- [x] `ss -tnl | grep -E ':(22|23|513|514|5985|5986)$'` returns no rows (no remote-shell ports listening)
- [x] `systemctl is-active sshd` returns `inactive`
- [x] `systemctl is-active amazon-ssm-agent` returns `inactive`
- [x] `systemctl is-active docker` returns `active`
- [x] `docker info | grep userns` shows the userns mapping
- [x] `php -i | grep expose_php` shows `Off`
- [x] `php -i | grep disable_functions` shows the blocklist
- [x] `auditctl -l | grep safebox` shows the audit rules loaded
- [x] `cat /opt/safebox/manifests/base.json` shows the component manifest with `"shellAccessPolicy": "zero-interactive-access"`

If any of these fail, the AMI build aborts.

---

## Trade-offs and Counterarguments

### "What if I'm just running a development instance?"

You're not building an attested Safebox if SSH is acceptable. Build with the base installer in your development environment too — practicing the zero-shell workflow during development is how you find the operational gaps before they hit production. If you need SSH for development, fork the installer and remove the SSH-removal block; that fork is no longer Safebox.

### "What about emergency response when something goes wrong?"

The emergency response IS termination and snapshot. If your team isn't prepared to terminate-and-rebuild as the primary incident response, the attestation model isn't a fit. There's nothing wrong with that — it just means a different security architecture is appropriate. We don't pretend attestation guarantees apply to systems where shells are tolerated.

### "AWS sales says SSM is secure"

SSM is more secure than a public SSH port with password authentication. That's a low bar. The point isn't whether SSM is "secure" in some abstract sense — it's that SSM **defeats attestation** the same way SSH does. Any mechanism that lets a remote user spawn `/bin/bash` on the instance defeats attestation. SSM is one such mechanism. We remove it.

### "What if a kernel CVE comes out and I need to patch fast?"

Rebuild the AMI with the patched kernel, redeploy, roll the fleet. The patching cycle for an attested Safebox is measured in fleet-rotation time, not single-instance-patch time. This is by design — patching in place would change the rootfs hash, which would break attestation on the next boot anyway.

If you need sub-hour patch turnaround, attestation isn't your security model — runtime intrusion detection plus mutable patching is. Different tools for different threat models.

---

## Documentation Cross-References

- [CASCADING-MANIFESTS.md](CASCADING-MANIFESTS.md) — How component manifests aggregate into the cascade SHA256
- [DETERMINISTIC-AI-ONLY-RNG.md](DETERMINISTIC-AI-ONLY-RNG.md) — LD_PRELOAD strategy for reproducible inference
- [STORAGE-SETUP.md](STORAGE-SETUP.md) — ZFS pool creation procedure (pre-requisite for `install-base.sh`)
- [AMI-SECURITY-SUMMARY.md](AMI-SECURITY-SUMMARY.md) — Higher-level security overview
- [FORENSIC-WORKFLOW.md](FORENSIC-WORKFLOW.md) — How to mount a snapshot for offline analysis (replaces "SSH in and debug")
