# VM Isolation Architecture: nginx in gVisor

This document describes the end-to-end architecture of a production Safebox after placing nginx inside a gVisor sandbox, explains how every component connects, and analyzes the resulting attack surface against kernel 0-days and remote code execution.

## Why a Sandbox Boundary

On October 14 2026, Dirty Frag (CVE-2026-43284 + CVE-2026-43500) demonstrated deterministic root from any unprivileged local code execution on Linux in under 30 seconds. The exploit chains a page-table race in the memory manager with a use-after-free in the network fragment reassembly path. It is a local privilege escalation (LPE) — it requires initial code execution on the box — but once an attacker has that, the kernel is theirs.

nginx is the internet-facing surface. If a future RCE in nginx (or in a request it proxies) gives an attacker unprivileged shell, Dirty Frag turns that into root on the host kernel, and root on the host means every container, every secret, every key on that Safebox is compromised.

gVisor interposes a Go-based application kernel (the Sentry) between the sandboxed process and the host kernel. The sandboxed process never issues syscalls to the host kernel directly — the Sentry intercepts every syscall and either handles it entirely in its own Go code or translates it into a narrow set of ~60 host syscalls via the platform layer (systrap). An LPE exploit like Dirty Frag targets C code paths in the Linux kernel's memory manager and network fragment reassembly. The Sentry has its own memory management and its own network stack (netstack), both written in Go. The vulnerable C code paths don't exist — they are not isolated behind a boundary, they are simply absent. Dirty Frag literally cannot work.

## End-to-End Architecture

```
Internet
  │
  │ TCP 443 / 80
  ▼
┌──────────────────────────────────────────────────────────┐
│  HOST (Safebox instance)                                 │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  gVisor sandbox (runsc)                            │  │
│  │                                                    │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │ nginx                                        │  │  │
│  │  │  - TLS termination                           │  │  │
│  │  │  - per-tenant vhost routing                   │  │  │
│  │  │  - ACME HTTP-01 challenges                    │  │  │
│  │  │  - proxy_pass to host ports via veth pair      │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  │                                                    │  │
│  │  Sentry (Go application kernel)                    │  │
│  │   - netstack: Go network stack (no Linux net code) │  │
│  │   - memory mgmt in Go (no Linux MM code)           │  │
│  │   - platform=systrap (ptrace-based interception)   │  │
│  │  bind mount: /mnt/vhosts (read-only)              │  │
│  └────────────────────────────────────────────────────┘  │
│       │                                                  │
│       │ veth pair: 172.16.0.0/24                         │
│       │ Sandbox: 172.16.0.2 → Host: 172.16.0.1          │
│       │                                                  │
│       ▼                                                  │
│  ┌──────────────────────────────────────────────────┐    │
│  │ autovhost                                         │    │
│  │  - provisions vhost configs + certs               │    │
│  │  - writes to /var/lib/safebox/nginx/vhosts/       │    │
│  │  - signals sandbox to reload nginx                 │    │
│  │  - per-tenant proxyTarget mapping                  │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │ Container: tenant-alpha                           │    │
│  │  - Qbix Server (Node.js + PHP)                    │    │
│  │  - listens 127.0.0.1:3001                         │    │
│  │  - /run/safebox/containers/tenant-alpha.sock       │    │
│  │  - npm / composer / pip / gem / git / migrate      │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │ Container: tenant-beta                            │    │
│  │  - Qbix Server (Node.js + PHP)                    │    │
│  │  - listens 127.0.0.1:3002                         │    │
│  │  - /run/safebox/containers/tenant-beta.sock        │    │
│  │  - npm / composer / pip / gem / git / migrate      │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │ System component                                  │    │
│  │  - Operator instance: /run/safebox/control.sock    │    │
│  │    handles /containers, /models, /volumes,         │    │
│  │    /succession                                     │    │
│  │  - Per-tenant instances:                           │    │
│  │    safebox-system@<name>.service                    │    │
│  │    serves per-container .sock                      │    │
│  │    handles /system (tool invocation),              │    │
│  │    /test, /embed                                   │    │
│  │  - Pipeline: HMAC verify → OCP verify → route      │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │ Host services (unchanged)                         │    │
│  │  - safebox-keyd (per-tenant key derivation)        │    │
│  │  - safebox-seal / safebox-unseal (vTPM)            │    │
│  │  - ZFS encrypted pool                              │    │
│  │  - Safenet node (registry, DNS)                    │    │
│  │  - Transparency log                                │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  Shielded VM: Secure Boot, vTPM, SEV-SNP                 │
│  dm-verity root, tmpfs /etc overlay                      │
└──────────────────────────────────────────────────────────┘
```

## The gVisor Sandbox

### How gVisor Works

gVisor runs as an OCI-compatible container runtime (`runsc`). When Docker or containerd starts a container with `--runtime=runsc`, gVisor interposes its Sentry process between the containerized application and the host kernel. The Sentry is a user-space application kernel written entirely in Go. It implements the Linux syscall interface — over 200 syscalls — without delegating to the host kernel's implementations.

The key architectural properties:

- **platform=systrap.** The Sentry uses ptrace to intercept every syscall from the sandboxed process. The sandboxed process's syscalls never reach the host kernel. Instead, the Sentry handles them in Go code, and when it needs host resources (memory mapping, file I/O), it issues its own carefully constrained syscalls — roughly 60 of the ~350 Linux syscalls. No KVM or `/dev/kvm` is needed. This works on every cloud, every instance type, bare metal or virtual.

- **netstack.** The Sentry includes a complete TCP/IP network stack written in Go (`pkg/tcpip`). It processes raw packets from a network device (a veth endpoint or AF_PACKET socket) and implements TCP, UDP, ICMP, ARP, IPv4/IPv6, and the socket API entirely in Go. The host kernel's network stack — including the fragment reassembly code that Dirty Frag exploits — is never used for sandbox traffic.

- **Memory management in Go.** The Sentry manages the sandboxed process's virtual address space, page tables, and memory mappings in Go. The host kernel's memory manager — including the page-table race condition that Dirty Frag exploits — is not in the code path. The Sentry uses host `mmap`/`munmap` to obtain physical pages but manages all virtual mappings itself.

- **File system in Go.** The Sentry implements VFS2, a virtual filesystem layer in Go. File operations from the sandboxed process are handled by the Sentry's own code. Host filesystem access (for bind mounts) goes through the gofer process, a separate process that mediates all file I/O between the sandbox and the host filesystem over a 9P or LISAFS protocol.

### What the Sandbox Contains

The sandbox is purpose-built and minimal. It runs nginx and nothing else. No shell, no package manager, no Nix store, no sshd, no cron, no user accounts beyond what nginx needs. The entire container image is produced at build time by a Nix derivation and baked into the host image.

Components inside the sandbox:

- **nginx** (~2 MB). The mainline nginx binary with stream, mail, and Perl modules disabled and no third-party modules. It terminates TLS, serves ACME challenges, and proxy_passes to the host over the veth pair.

- **Minimal OCI container image** (~25 MB total). Built by Nix as a Docker-compatible OCI image containing the nginx binary, config files, and the minimal set of shared libraries nginx needs (libc, libssl, libcrypto, libpcre, libz). No init system — the container entrypoint is nginx in foreground mode (`nginx -g 'daemon off;'`).

- **No guest kernel.** This is the fundamental difference from a VM approach. There is no Linux kernel inside the sandbox. The Sentry *is* the kernel, and it's written in Go.

### Nix Build Integration

The sandbox image is a Nix derivation (`nginx-sandbox.nix`) that produces:

1. `nginx-sandbox-image.tar` — an OCI container image containing the nginx binary, its dependencies, and the base config. Built by `pkgs.dockerTools.buildLayeredImage` with a minimal closure: nginx, openssl, pcre, zlib, and a static `/etc/passwd` for the nginx user.

2. `runsc-config.toml` — the gVisor runtime configuration: platform=systrap, network=sandbox (netstack), file-access=shared (gofer-mediated), overlay=root:memory (tmpfs overlay on the rootfs for nginx temp files and logs).

These artifacts are included in the host Nix image build. The host's systemd unit `safebox-nginx-sandbox.service` loads the OCI image and starts it with `runsc` on boot. No Nix tooling exists inside the sandbox — the sandbox is a static appliance.

### Host-to-Sandbox Communication

**veth pair (traffic).** A veth pair connects the sandbox's network namespace to the host. The host assigns 172.16.0.1 to its end; the sandbox gets 172.16.0.2. iptables on the host forwards ports 443 and 80 from the public interface to 172.16.0.2. nginx inside the sandbox proxy_passes back to 172.16.0.1:<tenant-port> to reach the per-tenant application servers on the host. The veth pair is a private L2 link — the sandbox has no route to the internet except through traffic it receives on its listening ports. Note: inside the sandbox, network traffic goes through gVisor's netstack (Go), not through the host kernel's network stack. The veth endpoint passes raw packets to the Sentry, which processes them entirely in Go.

**Bind mount (configuration).** The host shares `/var/lib/safebox/nginx/vhosts` and `/var/lib/safebox/nginx/certs` into the sandbox as read-only bind mounts at `/mnt/vhosts`. Access to these files is mediated by the gofer process — a separate, unprivileged process that speaks LISAFS/9P between the Sentry and the host filesystem. The gofer runs outside the sandbox and enforces read-only access. When autovhost writes a new vhost config or cert, the files are visible to nginx inside the sandbox through the gofer.

**Reload signal (control).** The host signals nginx reloads by executing `runsc exec <container-id> nginx -s reload` instead of the current sudo-based `nginx -s reload`. This runs the reload command inside the existing sandbox. No additional network channel or listener is needed — `runsc exec` uses the existing control socket between the `runsc` runtime and the Sentry.

### Cross-Cloud Compatibility

gVisor with platform=systrap requires no hardware virtualization support. It uses ptrace for syscall interception, which is a standard Linux kernel feature available on every instance type on every cloud.

| Cloud | Support | Notes |
|---|---|---|
| **GCP** | Yes — all instance types | Works on e2, n2d, c2d, and every other family. No configuration needed. Google developed gVisor; it powers Cloud Run and GKE Sandbox. |
| **Azure** | Yes — all instance types | Works on every VM size. No nested virtualization or special configuration. |
| **OCI** | Yes — all instance types | Works on all shapes including AMD Flex and ARM Ampere. No special configuration. |
| **AWS** | Yes — all instance types | Works on every instance family including t3, m6i, c7g (ARM), and Graviton. No nested virtualization needed. |

This is the primary operational advantage of gVisor over VM-based approaches: there are no instance-type constraints, no nested virtualization requirements, no cloud-specific configuration, and no need for different isolation strategies on different clouds. One approach, everywhere.

### Performance Characteristics

gVisor with platform=systrap adds overhead for syscall-heavy workloads because every syscall passes through ptrace interception and the Go Sentry. For nginx as a reverse proxy:

- **Startup time:** ~10ms (the Sentry process starts; no kernel boot, no BIOS, no initrd).
- **Memory overhead:** ~30 MB for the Sentry process.
- **Proxy latency:** Single-digit percent overhead. nginx's hot path is `read()` on the client socket → `write()` on the upstream socket and vice versa. Each of these is intercepted by the Sentry, but the Sentry's `read`/`write` implementations are thin wrappers that delegate to host `read`/`write` on the veth file descriptor. The actual data path is: nginx syscall → ptrace trap → Sentry handles in Go → Sentry issues host syscall → data moves. The overhead is the ptrace round-trip (~1-2 µs per syscall), negligible compared to network RTT.
- **TLS handshake:** Handled by OpenSSL inside the sandbox. Compute-bound, not syscall-bound, so gVisor overhead is minimal.

## Per-Tenant Port Routing

### Current State

Today, autovhost writes every vhost config with the same `proxyTarget: '127.0.0.1:3000'` from `config.js`. Every hostname proxies to the same backend port. This works for single-tenant boxes but doesn't isolate tenants.

### With Per-Tenant Routing

Each container gets a dedicated port allocated at creation time:

1. `opsContainers.js` creates a tenant (e.g., `tenant-alpha`), assigns uid 20001, and allocates port 3001 (base 3000 + offset from the uid allocation).
2. The port mapping is written to `/var/lib/safebox/tenant-ports.json`:
   ```json
   {
     "tenant-alpha": { "port": 3001, "uid": 20001 },
     "tenant-beta":  { "port": 3002, "uid": 20002 }
   }
   ```
3. The tenant's container starts its Qbix Server listening on `127.0.0.1:<port>`.
4. When autovhost provisions a vhost for a hostname, it looks up the hostname-to-tenant mapping and substitutes the correct `proxyTarget` for that tenant's port. The vhost template's `{{proxyTarget}}` becomes `172.16.0.1:3001` instead of the global default.

The hostname-to-tenant mapping comes from the Safebox plugin, which tells autovhost which hostnames belong to which tenant via the autovhost Unix socket. autovhost already handles per-host provisioning — the change is extending `vhostConfigFor(host)` to look up the tenant's port instead of using the global `cfg.proxyTarget`.

Inside the sandbox, nginx sees the vhost configs through the bind mount and proxy_passes each hostname to the correct host port. nginx doesn't know about tenants — it just follows the proxyTarget in each vhost config.

## Containers and Package Managers

Each tenant runs inside a Docker container with userns-remap (uid namespace isolation). The container holds the tenant's Qbix application: Node.js, PHP (via PHP-FPM), and whatever language runtimes the app needs.

### Package Manager Operations

The tenant's application can request package operations (install, update, remove) for npm, composer, pip, gem, cargo, and git. These requests flow through the governance pipeline:

1. **Tenant app** calls `POST /system` on its per-container Unix socket (`/run/safebox/containers/<name>.sock`), with the tool name, action, and packages in the request body.
2. **Per-tenant system instance** (`safebox-system@<name>.service`) receives the request. The pipeline:
   - **HMAC verification** — proves the request came from the authenticated container (per-container key from safebox-keyd).
   - **OCP verification** — the request body must include an `ocpClaim` with M-of-N governance signatures. For `POST /system` (all tool invocations), the threshold is **3 of 5** governance signers.
   - **Route** — the request reaches the `opsSystem.js` handler.
3. **opsSystem.js** validates the tool name and action against the `TOOL_BUILDERS` map. Each tool has a builder that produces the exact command and arguments:
   - `npm`: `npm install --save --`, `npm remove --save --`, `npm update --`, `npm list --json`, `npm outdated --json`
   - `composer`: `composer require --no-scripts --no-interaction --`, etc.
   - `pip`: `pip install --`, `pip uninstall -y --`, etc.
   - `gem`: `gem install --`, `gem uninstall --`, etc.
   - `cargo`: `cargo add --`, `cargo remove --`, etc.
   - `git`: `git status --porcelain`, `git pull --ff-only`, `git clone --depth 1 --`, etc.
   - `migrate`: `bash /workspace/migrate.sh <action> [target]`
   - `zfs-snapshot`, `zfs-rollback`: via the `safebox-zfs` wrapper
   - `dnf`: **NOT_SUPPORTED** — system packages change only by image rotation. There is no path from a tenant's request to modifying the host's package set.
4. **Execution** happens via `safebox-container exec <name> <tool> <args>` — a wrapper that runs the command inside the tenant's container with the correct uid, working directory, and environment. The host system component never executes tool commands in its own namespace.
5. **Response** flows back through the Unix socket to the tenant.

### Why M-of-N Matters Here

Without OCP governance, a compromised container that obtains its HMAC key (which it has by design — it needs it to authenticate) could install arbitrary npm packages, pull malicious git repos, or run migration scripts. The OCP gate ensures that 3 of 5 governance key holders (human administrators with ES256 keys baked into the base image) approved the operation before it executes. A compromised container alone cannot satisfy this threshold.

### dnf Is Not Supported

System-level packages (the host OS, kernel modules, system libraries) are immutable. They change only through image rotation: build a new Nix image, measure it, bless it through the governance process, and launch new instances from it. The `dnf` tool builder returns `null`, and `opsSystem.js` rejects the request with `NOT_SUPPORTED` before it reaches any execution path. There is no mechanism for any container, any socket, or any OCP claim to modify the host's system packages at runtime.

## The System Component

The system component (`server.js`) is the authorization gateway between containers and privileged operations.

### Two Roles

**Operator instance** (`safebox-system.service`, uid `safebox-infra`): listens on `/run/safebox/control.sock` (mode 0600, owned by safebox-infra). Handles host-scope operations that affect the trust surface:
- `POST /containers/create` — allocate uid, write config, start tenant system instance, docker run. Threshold: 4/5.
- `POST /containers/destroy` — stop container, remove HMAC key, clean up. Threshold: 4/5.
- `POST /models/install` — pull model weights into the base. Threshold: 2/3.
- `POST /volumes/install` — mount external volumes. Threshold: 2/3.
- `POST /succession/*` — transfer the master secret. Threshold: 4/5.

**Per-tenant instances** (`safebox-system@<name>.service`, uid `safebox-sys-<name>`): each listens on `/run/safebox/containers/<name>.sock`, bind-mounted into only that container at `/run/safebox/system.sock`. Handles per-tenant operations:
- `POST /system` — tool invocations (npm, composer, pip, gem, cargo, git, migrate, zfs-snapshot, zfs-rollback). Threshold: 3/5.
- `GET /test/*` — test status queries. HMAC-only (read-only).
- `/embed` — inference requests. HMAC-only (scoped by per-container key).

### Identity Model

The sticky bit on `/run/safebox/containers` (mode 1771, `root:safebox-sys`) prevents any instance from touching another instance's socket. Each tenant system instance runs as its own uid (`safebox-sys-<name>`) and reads only its own HMAC key from `/run/safebox/keys/<name>/instance.hmac`. The operator instance runs as `safebox-infra` and reads the operator key from `/run/safebox/keys/_operator/control.hmac`. safebox-keyd derives and distributes all keys.

A container connects to its own socket (bind-mounted as `/run/safebox/system.sock`) and authenticates with the per-container HMAC key. It cannot reach any other container's socket or the operator control socket — the filesystem topology enforces this, and the uid separation makes it kernel-enforced.

## What Stays the Same

Everything behind the nginx sandbox boundary operates exactly as it does today:

- **Shielded VM with Secure Boot, vTPM, SEV-SNP** — the host instance is attested and its root filesystem is dm-verity protected. The vTPM seals the ZFS pool encryption key.
- **safebox-keyd** — derives per-tenant HMAC keys, per-container app keys, and the operator key from the master secret via HKDF.
- **ZFS encrypted pool** — tenant data at rest is encrypted with a key sealed to the vTPM. ZFS snapshots, clones, and rollbacks are governed by OCP claims.
- **Safenet node** — registry replication, DNS zone compilation, name resolution. Unchanged.
- **Transparency log** — all governance decisions (container create/destroy, model install, key rotation) are logged with the OCP claim that authorized them.
- **Succession protocol** — M-of-N transfer of the master secret between Safebox instances.
- **Safecloud integration** — encrypted backups to the Drop network, package distribution via JetSwarm, content-addressed media storage.
- **Governance key registry** — genesis keys baked into the image, runtime rotation with supermajority + exponential backoff on churn.

## Security Analysis: 0-Days and RCE Against the Outer Safebox

### Attack Surface Enumeration

The outer Safebox has exactly two network-facing ports: 443 (HTTPS/TLS) and 8443 (dnsclient announce challenge). Port 80 is optionally open for ACME HTTP-01. All traffic on 443 and 80 enters the gVisor sandbox and hits nginx. Port 8443 is handled by the dnsclient component on the host (not proxied through the sandbox).

### Why Dirty Frag Cannot Work Inside the Sandbox

Dirty Frag chains two Linux kernel bugs:

1. **CVE-2026-43284** — a page-table race in the Linux memory manager's `mm/memory.c` handling of copy-on-write faults. The exploit creates a race between `do_wp_page()` and `zap_pte_range()` to gain a dangling PTE pointing to a freed page.

2. **CVE-2026-43500** — a use-after-free in the Linux kernel's `net/ipv4/inet_fragment.c` network fragment reassembly. The exploit uses the freed page from step 1 to corrupt a fragment reassembly queue structure, achieving arbitrary kernel write.

Inside the gVisor sandbox, neither code path exists:

- **Memory management:** The Sentry manages virtual memory in Go (`pkg/sentry/mm`). Copy-on-write faults are handled by the Sentry's own page table walker, not by the host kernel's `mm/memory.c`. The race condition in `do_wp_page()` is in C code that the Sentry never calls — the Sentry maps host pages with `mmap` but manages all virtual-to-physical translations itself.

- **Network fragment reassembly:** The Sentry includes netstack (`pkg/tcpip`), a complete TCP/IP stack in Go. IP fragment reassembly is implemented in `pkg/tcpip/network/ipv4/ipv4.go` in Go, not in the host kernel's `net/ipv4/inet_fragment.c`. The vulnerable C code is never in the execution path. An attacker inside the sandbox sending fragmented packets has those fragments reassembled by Go code that has its own (separate) implementation with its own (separate) bugs, if any.

This is a categorical defense, not a probabilistic one. It is not that Dirty Frag is unlikely to work — it is that the two pieces of C code it exploits are not present. The Sentry is a different implementation of the same interface, written in a memory-safe language that eliminates the class of bugs (use-after-free, dangling pointers, page-table races) that Dirty Frag relies on.

### Attack Chain: Internet to Host Root

To fully compromise the outer Safebox (host root), an attacker must chain:

**Step 1: Remote Code Execution in nginx (inside the sandbox).**
The attacker needs an RCE in nginx itself — not in a backend application, because nginx proxy_passes to the host and the response flows back through nginx's own code. The backend app runs on the host, not in the sandbox, so an RCE in the PHP or Node.js app is a separate (and shorter) chain analyzed below.

nginx RCEs are rare but not impossible. The last critical nginx RCE was CVE-2021-23017 (DNS resolver). The sandbox contains only nginx — no scripting modules, no Perl, no Lua, no third-party modules. The attack surface is nginx's C code for HTTP parsing, TLS handshake (via OpenSSL), and proxy buffering.

**Step 2: Escalation inside the sandbox.**
With unprivileged code execution inside the sandbox, the attacker attempts to escalate privileges. Traditional kernel LPE exploits like Dirty Frag will not work because the Sentry's Go implementations replace the vulnerable C code paths. The attacker would need to find a bug in the Sentry itself — a Go application, subject to Go's memory safety guarantees (no use-after-free, no buffer overflows, no dangling pointers). Logic bugs are possible; memory corruption is not (barring unsafe code, which gVisor uses sparingly and in carefully audited paths).

**Step 3: Sandbox escape.**
Even with root inside the sandbox (which is already harder than in a Linux kernel due to the Go Sentry), the attacker must escape the gVisor sandbox to reach the host. The Sentry process communicates with the host through ~60 syscalls, seccomp-filtered to only those calls. The attack surface is:
- **The Sentry itself** — a logic bug that causes the Sentry to issue a host syscall with attacker-controlled arguments in a way that bypasses seccomp.
- **The gofer process** — mediates filesystem access. A compromised Sentry could try to exploit the gofer to write outside the allowed bind mounts. The gofer runs as an unprivileged user with its own seccomp filter.
- **The ~60 host syscalls** — even if the attacker fully controls the Sentry, the seccomp filter limits what host syscalls it can make. Exploiting a host kernel bug through this filtered set is possible but substantially harder than having the full ~350 syscall surface.

**Step 4: Host LPE (if the escape lands unprivileged).**
If the sandbox escape gives unprivileged execution on the host, the attacker needs a kernel LPE to reach root. At this point, Dirty Frag *is* available against the host kernel, but the attacker had to chain an nginx RCE + Sentry escape + gofer or seccomp bypass to get here — a much harder path.

### Attack Chain: RCE in a Backend App (Shorter Path)

If the attacker gets RCE not in nginx but in a tenant's PHP or Node.js application, the chain is shorter because the backend runs on the host, not inside the sandbox:

**Step 1: RCE in the tenant application.**
Exploit a vulnerability in the PHP or Node.js code, or in a dependency. This gives code execution as the container's app user (uid 100991 in host namespace due to userns-remap).

**Step 2: Container escape.**
The container runs with userns-remap, no `--privileged`, and a seccomp profile. The attacker needs a container escape — a Docker/runc vulnerability, a kernel vulnerability reachable from inside the namespace, or a misconfiguration.

**Step 3: Host LPE.**
After escaping the container, the attacker is unprivileged on the host. A kernel LPE like Dirty Frag gives them root.

This chain is **two steps shorter** than the sandbox path (no sandbox escape needed) but still requires a container escape + kernel LPE. The nginx sandbox doesn't protect this path — it protects the path through nginx itself.

### Comparative Risk Assessment

| Attack Path | Steps | Difficulty | Dirty Frag Impact |
|---|---|---|---|
| Internet → nginx RCE → Sentry escape → gofer/seccomp bypass → host LPE → root | 4 | Very High | Dirty Frag does not work inside the sandbox (Go Sentry). Only works after sandbox escape, against the host kernel. |
| Internet → app RCE → container escape → host kernel LPE → root | 3 | High | Dirty Frag is directly usable after container escape. Container boundary is the barrier. |
| Internet → app RCE → Unix socket to system component → bypass OCP → privileged operation | 3 | High | Doesn't need kernel LPE at all. Requires forging or stealing OCP governance signatures (3/5 ES256 keys). |
| Internet → port 8443 → dnsclient RCE → host kernel LPE → root | 2 | High | dnsclient is on the host, not in the sandbox. But it handles only the announce challenge protocol, a narrow surface. |

### What the Sandbox Boundary Buys

1. **Categorical immunity to C kernel exploits.** A Dirty Frag-class exploit inside the sandbox doesn't just fail to reach the host kernel — it fails to work at all. The vulnerable C code paths (memory manager, network fragment reassembly) are replaced by Go implementations in the Sentry. This is not isolation; it is elimination. Future C kernel LPEs that target other Linux subsystems (netfilter, filesystem, IPC) face the same situation: if the Sentry reimplements the subsystem in Go, the exploit has no target.

2. **Reduced blast radius of nginx compromise.** Inside the sandbox there are no secrets, no keys, no tenant data, no Unix sockets. nginx has access to TLS certificates (via gofer-mediated bind mount, read-only) and the veth pair. An attacker with root in the sandbox can read TLS private keys for the hosted domains and can see/modify traffic in transit. They cannot reach the host filesystem, the ZFS pool, the HMAC keys, the governance keys, or any container's Unix socket.

3. **Go's memory safety as a structural defense.** The Sentry is written in Go, which provides memory safety by default — no use-after-free, no buffer overflows, no dangling pointers, no data races (Go's race detector catches these in testing). This eliminates the entire class of memory corruption bugs that most kernel exploits rely on. Bugs in the Sentry will be logic bugs, not memory corruption, and they will produce incorrect behavior, not arbitrary code execution.

4. **Narrow host syscall surface.** The Sentry makes ~60 host syscalls, filtered by seccomp. The full Linux syscall table has ~350 entries. Even if an attacker fully controls the Sentry process, the seccomp filter constrains what they can ask the host kernel to do.

### What the Sandbox Boundary Does Not Buy

1. **No protection for the app-RCE path.** If an attacker compromises the tenant's PHP or Node.js application, they're already on the host (inside a container). The sandbox boundary is irrelevant for this path.

2. **TLS keys are still exposed.** The sandbox needs the TLS private keys to terminate TLS. An attacker with root in the sandbox can read them through the gofer. Mitigation: key rotation with short-lived certificates, and monitoring for unexpected key access.

3. **Traffic interception.** An attacker with root in the sandbox can see all plaintext HTTP after TLS termination and can modify proxied responses. This is inherent to any architecture where TLS terminates before the application.

4. **Port 8443 is still on the host.** The dnsclient announce challenge listener is not inside the sandbox. It's a narrow protocol surface, but it's a direct path to host code execution if it has an RCE.

### Residual Risks

**Risk 1: Sentry logic bug leading to sandbox escape (Low probability, Critical impact).** A logic bug in the Sentry could allow the sandboxed process to trick the Sentry into issuing a host syscall with attacker-controlled arguments, or into mishandling file paths in a way that accesses host files outside the bind mounts. gVisor has a strong security track record — it's used by Google Cloud Run, GKE Sandbox, and Google's internal infrastructure — but logic bugs in ~200K lines of Go code are possible. Mitigation: keep gVisor updated; the Nix image build pins to a specific version with known CVE status.

**Risk 2: Gofer process as an attack surface (Low probability, High impact).** The gofer mediates all filesystem access between the Sentry and the host. A compromised Sentry could try to exploit bugs in the gofer's LISAFS/9P implementation to write outside the allowed paths. The gofer runs unprivileged with its own seccomp filter, so even a gofer compromise is contained. Mitigation: the bind mounts are read-only, eliminating most write-path attack surface in the gofer.

**Risk 3: Host kernel bug reachable through the ~60 allowed syscalls (Low probability, High impact).** The seccomp filter limits the Sentry to ~60 syscalls, but those ~60 could contain a kernel bug. The filtered set is well-tested code (mmap, read, write, futex, etc.) and doesn't include high-risk syscalls (no ioctl on arbitrary devices, no mount, no ptrace of host processes), but kernel bugs in core syscalls are possible. Mitigation: the host kernel is patched and hardened (SELinux, dm-verity root).

**Risk 4: App-path container escape (Medium probability, Critical impact).** The docker/runc container boundary is the weakest isolation layer on the host. Historical container escapes (CVE-2024-21626 runc, CVE-2020-15257 containerd) demonstrate this is a realistic attack vector. Mitigation: userns-remap, seccomp profiles, no `--privileged`, read-only rootfs where possible. Future mitigation: run tenant containers inside their own gVisor sandboxes (the "inner Safebox" architecture from the design discussion).

**Risk 5: Supply chain through package managers (Medium probability, High impact).** A compromised npm/pip/composer package installed through the governed `POST /system` path delivers malicious code into a tenant container with the app's permissions. The OCP gate (3/5 governance signatures) prevents unauthorized installs, but if the governance signers approve a package that is itself compromised (typosquatting, maintainer account takeover), the malicious code runs inside the container. Mitigation: the Safe Store audit (onboard LLM vetting), and the fact that package operations execute only inside the container — they cannot modify the host or other containers.

### Summary: Isolation Depth

With the nginx gVisor sandbox in place, the isolation layers from the internet to host root are:

```
Internet
  │
  ├─ TLS (encrypted transport)
  │
  ├─ nginx request parsing (inside gVisor sandbox)
  │
  ├─ gVisor Sentry (Go application kernel — replaces Linux kernel)
  │    - netstack: Go network stack (Dirty Frag impossible)
  │    - Go memory management (page-table races impossible)
  │    - ~60 host syscalls, seccomp-filtered
  │
  ├─ gofer process (unprivileged, seccomp-filtered, mediates FS)
  │
  ├─ Host kernel (SELinux, seccomp, dm-verity root)
  │
  ├─ Per-tenant container isolation (userns-remap, seccomp, separate uid)
  │
  ├─ Per-tenant Unix socket isolation (sticky bit, uid separation)
  │
  ├─ HMAC authentication (per-container key, proves identity)
  │
  ├─ OCP governance gate (M-of-N ES256 signatures, proves authorization)
  │
  └─ Operation execution (inside container namespace, via safebox-container exec)
```

Without the sandbox, the chain from nginx RCE to host root was: RCE → Dirty Frag → root. Two steps, both with known working exploits. With the gVisor sandbox, the kernel exploit step is eliminated entirely — Dirty Frag has no target inside the sandbox — and the attacker must find a logic bug in a Go application kernel, escape a seccomp-filtered sandbox, and then find a separate host kernel exploit. The hardest step (Sentry escape) has no known working exploit against gVisor's sandbox.

The comparison with a VM approach (Firecracker) is also instructive. A VM isolates the host kernel by running a separate guest kernel. Dirty Frag may work inside the guest (it's still a Linux C kernel), giving the attacker guest root, from which they need a VM escape. gVisor eliminates the guest kernel entirely — there is no kernel to exploit, guest or host. The attacker goes from "find a VM escape from guest root" to "find a logic bug in a memory-safe Go program," which is a categorically harder problem.
