# NixOS base ⇄ install-base.sh parity checklist (Turn 2)

This proves the NixOS base (`nixos/modules/`) reproduces every effect of the Amazon-Linux/dnf installer (`aws/scripts/components/base/install-base.sh`), so the dnf path can be deleted and there is one base, not two. Each row is an effect of install-base.sh and where the NixOS base provides it. "Superset" notes where NixOS is strictly stronger.

## Packages (SYSTEM_PACKAGES array)

| install-base.sh | NixOS equivalent | Notes |
|---|---|---|
| mariadb105-server-10.5.24 | `services.mysql` (pkgs.mariadb) | version from nixpkgs pin, not hardcoded |
| php-fpm-8.3.6 | `services.phpfpm.pools.safebox` | version from pin |
| nginx-1.26.2 | `services.nginx` | version from pin |
| docker-ce-25.0.5 | `virtualisation.docker` | version from pin |
| nodejs-20.18.0 + npm-10.8.2 | `pkgs.nodejs_20` | version from pin |
| zfs-2.2.6 | NixOS ZFS (kernel-matched) | `zfs.nix`; co-built with kernel |
| iptables-1.8.10 | `pkgs.iptables` | kernel/netfilter floor |
| auditd-3.1.5 | `security.auditd.enable` | see auditd rows |
| fail2ban-1.0.2 | `services.fail2ban.enable` | **FIXED Turn 2** — was package-only, now a running service |

**Superset:** install-base.sh pinned ten packages by version string ("whatever the mirror serves for that version"); the flake pins *every* package at once by nixpkgs commit hash — a stricter reproducibility guarantee (Bug-3 fix, generalized).

## Removals / shell-channel elimination (Tiers 1–4)

| install-base.sh removed | NixOS guarantee | Notes |
|---|---|---|
| telnet/rsh/vsftpd/tftp/cockpit/webmin | absent from closure | never in systemPackages/services — nothing to remove |
| openssh-server (Tier 2) | `services.openssh.enable = false` + assertion | build fails if re-enabled |
| amazon-ssm-agent (Tier 3) | **assertion added Turn 2** | `assertion = !(services.amazon-ssm-agent.enable or false)` |
| getty/serial-getty/debug-shell (Tier 4) | `.enable = false` for each + autovt + **autologin assertion Turn 2** | no login prompt anywhere |
| masked sshd/ssm/cockpit sockets | absent from closure | nothing to mask — not present |

**Superset:** install-base.sh removed-then-verified at runtime; NixOS makes these *absence-by-construction* (not in the closure) and *build-time assertions* (fail the build, not a late runtime check). A later package pull cannot silently reactivate what was never present.

## Config files

| install-base.sh wrote | NixOS equivalent | Parity |
|---|---|---|
| /etc/docker/daemon.json (userns-remap, no-new-privileges, icc off, zfs driver, log rotation, ulimits) | `virtualisation.docker.daemon.settings` | verbatim |
| dockremap user/group | `users.users.dockremap` + group | verbatim |
| /etc/my.cnf.d/safebox.cnf (InnoDB↔ZFS tuning) | `services.mysql.settings.mysqld` | verbatim (file_per_table, page_size 16k, O_DIRECT, doublewrite off, flush_log/sync_binlog, max_connections 500, thread_cache 50) |
| php.ini (allow_url_include/fopen off, expose_php off, disable_functions) | `services.phpfpm...phpOptions` | verbatim disable_functions list |
| /etc/audit/rules.d/safebox.rules | `security.audit.rules` | **completed Turn 2** — see below |

## auditd rules parity (completed Turn 2)

| install-base.sh rule | NixOS | Notes |
|---|---|---|
| zfs-key watch | ✓ | verbatim |
| dnf/rpm exec watch | replaced by `/nix/store -p x` | no dnf/rpm on NixOS; store is the code source |
| npm/composer exec watch | ✓ (via /run/current-system/sw/bin) | **added Turn 2** |
| daemon.json/php.ini/nginx config watch | ✓ (daemon.json + /etc/nginx) | **added Turn 2** (php.ini is immutable in the nix store, so the nginx + docker watches are the live-config surface) |
| setuid priv-esc watch | ✓ | verbatim |

## Directory / permission structure (completed Turn 2)

| install-base.sh mkdir/chmod | NixOS tmpfiles | Mode |
|---|---|---|
| /opt/safebox{,/manifests,/lib,/bin} | ✓ **added Turn 2** | 0755 root |
| /srv/safebox/runtimes/system | ✓ **added Turn 2** | 0750 root |
| /safebox/nginx/ssl | ✓ **added Turn 2** | 0710 nginx |
| /safebox/mariadb/data | ✓ **added Turn 2** | 0700 mysql |
| /safebox/www | ✓ (pre-existing) | 0750 nginx |
| /etc/nginx/conf.d/auto{,-certs} | ✓ (pre-existing) | 0750 nginx |

## Users / access policy

| install-base.sh | NixOS | Parity |
|---|---|---|
| no interactive users | `users.mutableUsers = false` | superset (no runtime user add) |
| (implicit) | `users.users.root.hashedPassword = "!"` | superset (root locked) |
| firewall: no 22/23/5985/5986 | `networking.firewall` allow 80/443 only | verbatim |

## The four Node components install unchanged

install-system.sh's only host requirements are: `systemctl` present, `node ≥20`, and the `/etc/safebox` + `/run/safebox` paths. The NixOS base provides systemd, `nodejs_20`, and the safebox paths — so `install-system.sh`, `install-dnsclient.sh`, and `install-autohost.sh` run against the NixOS host unchanged. (These four components are Node services deployed onto the host; they are not part of the base image build and do not need porting.)

## Residual: manifest

install-base.sh wrote /opt/safebox/manifests/base.json with a cascading SHA-256 placeholder. NixOS emits a human-readable manifest at `/etc/safebox/manifests/base.json`, but the real manifest is the closure hash (measured in Phase 3). Parity preserved; the closure hash supersedes the hand-computed cascade.

## Verdict

Every effect of install-base.sh is reproduced by the NixOS base, and in the security-relevant cases (shell-channel elimination, package pinning, php-fpm sandbox) the NixOS base is strictly stronger. The Turn-2 edits closed the four real gaps found by the diff: fail2ban service, complete auditd rules, SSM/getty assertions, and the directory/permission structure. **`install-base.sh` can be deleted once Turn 1 (pin + build) confirms the closure evaluates** — the two are equivalent at the effect level, with NixOS the superset. Deletion itself is a Turn-4 step (do it together with the build-pipeline rewrite), but the parity that authorizes it is established here.

## One honest remaining sub-item: per-cloud guest integration

install-base.sh targeted Amazon Linux, which ships AWS guest integration (EC2 metadata, growpart, ENA drivers) pre-wired. A generated NixOS image needs each cloud's guest integration added explicitly. This is NOT an install-base.sh-parity gap (install-base.sh only ever did AWS), but it IS required for the images to boot correctly per cloud, and it belongs to the same "make the base cloud-ready" work:

- AWS: `virtualisation.amazon-image` / amazon-init (EC2 metadata, growpart) — the `amazon` nixos-generators format supplies most of this.
- GCP: `services.google-guest-agent` / the `gce` format's profile.
- Azure: `waagent` / the `azure` format's profile.
- OCI / IBM / Alibaba: cloud-init (the `qcow` format is bare — these need cloud-init enabled and the cloud's metadata datasource configured).

The nixos-generators cloud formats bundle much of this automatically (that is the point of `format = "amazon"` vs a bare qcow), so for AWS/GCP/Azure it largely comes for free with the format; for the qcow-based clouds (OCI/IBM/Alibaba) cloud-init must be enabled in the host config. This is wired and verified as part of Turn 3 (per-cloud boot), because whether the guest integration actually works can only be confirmed by booting on that cloud — which is exactly the hardware-gated step. Flagged here so it is not mistaken for done: the *install-base.sh parity* is complete; the *per-cloud guest readiness* for the five non-AWS clouds is confirmed at first boot in Turn 3.
