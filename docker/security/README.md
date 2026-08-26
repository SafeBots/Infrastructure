# Container hardening: seccomp + AppArmor

This is the right-sized isolation for the container tier: syscall + resource
confinement that targets the container-escape / lateral-movement threat without
a microVM substrate change. It composes with — does not replace — the existing
layers (Nitro attestation, capability sandbox, empty egress, two-box creds).

## What each profile does

**seccomp** shrinks the kernel syscall surface a container can reach. A kernel
bug in a syscall that's not on the allowlist is simply uncallable from the
container.

- `seccomp/safebox-runner.json` — deny-by-default allowlist (186 syscalls) for
  the locked-down services. Explicitly denies the escape-prone ones: `ptrace`,
  `keyctl`, `bpf`, `unshare`, `mount`, `pivot_root`, `kexec_load`,
  `init_module`/`finit_module`/`delete_module`, `add_key`/`request_key`,
  `userfaultfd`, `perf_event_open`, `process_vm_readv`/`writev`, `setns`.
- `seccomp/safebox-gpu.json` — the same base plus the syscalls the NVIDIA/CUDA
  userspace stack needs (UVM via `process_vm_readv`, pinned memory `mlock2`,
  affinity, SysV shm, io_uring). `ioctl` is allowed in both (the driver leans on
  it heavily) — this is the known soft spot for GPU seccomp and the reason the
  GPU profile is necessarily looser than the CPU one.

**AppArmor** confines resource access by path/operation.

- `apparmor/safebox-runner` — confines a compromised service to its own `/app`
  (read-only) plus its writable scratch/output dirs. Hard-denies `/etc/safebox`
  (host key material), `/run/secrets` writes, the docker socket, `mount`,
  `ptrace`, raw sockets, and the `sys_module`/`sys_admin`/`sys_ptrace`
  capabilities. Directly limits the HF-style "read another process's environ /
  the credential store" move.

## Per-service posture (docker-compose.yml)

| service | seccomp | apparmor | cap_drop | read_only | why |
|---|---|---|---|---|---|
| node-exec | safebox-runner | safebox-runner | ALL | yes (+tmpfs /tmp) | untrusted app code — lock hard |
| llama-server-deepseek | safebox-gpu | — | ALL | no | GPU mmap needs write; GPU seccomp |
| ffmpeg | safebox-runner | safebox-runner | ALL | yes (/tmp is a volume) | media processing — lock hard |
| typesense | safebox-runner | — | ALL | no (writes /data) | search index writes |
| chromium | Docker default | — | ALL +SYS_ADMIN | no | Chrome's own sandbox needs SYS_ADMIN |
| system-protocol-api | — (default) | — | — | no | ORCHESTRATOR: mounts docker.sock |

## Deliberate exceptions (not oversights)

- **chromium** keeps Docker's *default* seccomp and adds back `SYS_ADMIN`,
  because Chrome's own sandbox uses user-namespace syscalls a tight deny-default
  profile blocks. Follow-up: a dedicated `chrome-seccomp.json` that allows
  Chrome's namespace syscalls over a deny-default base. Until then, egress is
  still constrained by `safebox-net` and `no-new-privileges` + `cap_drop ALL`
  still hold.
- **system-protocol-api** is the orchestrator; it mounts `docker.sock` to drive
  docker for the system component, so it cannot be confined without breaking its
  job. It is trusted by necessity, bounded by `127.0.0.1:4000` binding and
  M=5/N=7 governance, and gets `no-new-privileges` only.

## Why these paths are attested

The profiles ship in the measured base via `environment.etc` in
`nixos/modules/containers.nix` (`/etc/safebox/docker/security/...` and
`/etc/apparmor.d/safebox-runner`). The compose file references the seccomp
profiles at those exact `/etc/safebox/...` paths, so Docker resolves them from
the measured base at container start — the confinement policy is part of what a
relying party attests, not a mutable file dropped next to the compose.
`security.apparmor.enable = true` plus the `safebox-apparmor-load` unit
(ordered before `safebox-compose`) load the profile into the kernel on boot.

## The dynamic runner path

Model runners launched dynamically (not via compose) already run under a strong
posture in the trust-or-simulate path (`opsTest.js`: `--network none`,
`--read-only`, `--security-opt no-new-privileges`, `--cap-drop ALL`,
`--user nobody`, `--tmpfs /tmp`). When the production dynamic launch adds
`docker run` for GPU runners, it should pass
`--security-opt seccomp=/etc/safebox/docker/security/seccomp/safebox-gpu.json`
and `--security-opt apparmor=safebox-runner` to match the compose tier.

## What this does NOT do

Not a microVM boundary — a kernel exploit in an *allowed* syscall is still a
kernel exploit. This raises the bar (most escape paths need a denied syscall)
and confines the blast radius; it does not make the container a VM. For the
web/PHP tier facing untrusted internet input, a tight custom profile (CPU-only,
no GPU ioctl problem) is the higher-value follow-up.

## Web/PHP tier — systemd sandbox (measured base)

The PHP tier does NOT run in a container — nginx, php-fpm, and mariadb are
host systemd services in the measured base. So the "tight profile for the
untrusted-input-facing tier" is applied natively via **systemd sandboxing** on
the `phpfpm-safebox` service (`nixos/modules/base.nix`). systemd's
`SystemCallFilter` compiles to a seccomp BPF filter, so this is the same
mechanism as the container seccomp profiles, applied to the host service — and
it ships in the measured base, so it's attested.

What it enforces: `@system-service` syscalls minus `@privileged`/`@obsolete`;
`ProtectSystem=strict` with only `/safebox/www` writable; `PrivateTmp`,
`PrivateDevices`, `ProtectProc=invisible`, `RestrictNamespaces`,
`ProtectKernelModules`, empty `CapabilityBoundingSet`, `NoNewPrivileges`.

Two settings deliberately calibrated (the "too tight and it breaks" cases):
- `@resources` is **not** stripped — the php-fpm master calls `setrlimit` for
  `pm=dynamic` worker management, and removing it can break the pool.
- `MemoryDenyWriteExecute` is **omitted** — PHP OPcache with JIT uses W+X
  mappings and would fail to start. Add it only after confirming `opcache.jit`
  is off in the app.
- `AF_NETLINK` is allowed — `getaddrinfo`/libc interface enumeration needs it;
  without it, DNS resolution in PHP can fail.

This is guarded by `docker/test/testPhpSandbox.py`, which fails if the sandbox
is dropped or if either known-breaking setting is reintroduced.
