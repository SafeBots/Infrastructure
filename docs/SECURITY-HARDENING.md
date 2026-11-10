# Security Hardening: Full Analysis

This document is the comprehensive security analysis of a production Safebox. It covers every isolation layer from the internet-facing edge to the encrypted storage pool, explains how attestation works and how external clients can verify it, and analyzes the system's resilience to kernel-level exploits including Dirty Frag (CVE-2026-43284 + CVE-2026-43500) and the IPv4 TCP handshake UAF (CVE-2026-98432). For the detailed gVisor sandbox architecture and attack chain analysis, see [VM.md](VM.md). For the transparency log and instance identity protocol, see [TRANSPARENCY.md](TRANSPARENCY.md). For the OCP governance gate in the infrastructure base, see [OCP-IN-BASE.md](OCP-IN-BASE.md). For post-quantum TLS configuration, see [PQ-TLS.md](PQ-TLS.md).

## Isolation Architecture: gVisor Everywhere

Every container on a production Safebox runs inside a gVisor sandbox. There is no runc on the system. The Docker daemon is configured with `runsc` as the default (and only) runtime via `/etc/docker/daemon.json`:

```json
{
  "default-runtime": "runsc",
  "runtimes": {
    "runsc": {
      "path": "/usr/bin/runsc",
      "runtimeArgs": [
        "--platform=systrap",
        "--network=sandbox",
        "--file-access=shared",
        "--overlay2=root:memory"
      ]
    }
  }
}
```

Every `docker run` launches into gVisor automatically. The `--privileged` flag is rejected by runsc. There is no fallback runtime and no way to escape to a native Linux container from inside the system.

### What Runs in gVisor

| Container | Purpose | gVisor Impact |
|---|---|---|
| **nginx** | TLS termination, vhost routing, ACME challenges | Internet-facing attack surface. Kernel exploits impossible inside sandbox. |
| **tenant-alpha, tenant-beta, ...** | Per-tenant Qbix Server (Node.js + PHP) | App-level RCE cannot reach host kernel. Package managers (npm, composer, pip) run inside sandbox. |
| **safebox-system@\<name\>** | Per-tenant system instances | Tool invocations (git, migrate, zfs-snapshot) execute inside sandbox. |
| **dnsclient** | Safenet DNS announce/challenge | Narrow protocol surface, sandboxed. |

### What Runs on the Host (Not in gVisor)

| Process | Why It's on the Host |
|---|---|
| **Docker daemon** | Needs direct kernel access for cgroups, namespaces, image management. |
| **safebox-keyd** | Per-tenant key derivation from master secret. Unix socket only, mode 0600. |
| **safebox-seal / safebox-unseal** | vTPM operations. Hardware-bound, cannot run in a sandbox. |
| **ZFS** | Kernel module. Manages the encrypted storage pool. |
| **Operator instance** (`safebox-system.service`) | Needs Docker socket access for container lifecycle. Unix socket only, mode 0600. |
| **Safenet node** | Registry replication, DNS zone compilation. |

The operator instance is the only process on the host that accepts requests from other processes (via its Unix socket). It has no network port. Every request to it requires both HMAC authentication (proves identity) and OCP governance verification (proves M-of-N authorization).

## Why "Docker Group = Root" No Longer Applies

The traditional argument is that Docker group membership is root-equivalent because a user can run `docker run --privileged -v /:/host alpine chroot /host bash` to get a root shell. On a production Safebox, this argument is structurally invalid:

1. **`--privileged` is rejected.** runsc refuses to start a container with `--privileged`. The flag is incompatible with gVisor's security model.
2. **No runc.** There is no alternative runtime that would honor `--privileged`. The only runtime binary on the system is `/usr/bin/runsc`.
3. **gVisor intercepts all syscalls.** Even without `--privileged`, a container started through the Docker socket enters a gVisor sandbox where the Sentry (Go application kernel) handles every syscall. There is no path from inside the container to the host kernel's syscall interface.
4. **The operator instance is systemd-hardened.** The process that talks to the Docker socket runs under 23 systemd security restrictions (PrivateTmp, ProtectSystem=strict, ProtectHome, NoNewPrivileges, MemoryDenyWriteExecute, CapabilityBoundingSet= empty, SystemCallFilter, etc.). Even if the operator instance were compromised, it can only start gVisor containers.

The Docker socket is still a privileged resource, but it can no longer produce a root shell. It can produce gVisor sandboxes, which is what it's supposed to do.

## Defense-in-Depth: 25 Independent Layers

| # | Layer | What It Prevents |
|---|---|---|
| 1 | **gVisor Sentry** | Kernel exploits (Dirty Frag, CVE-2026-98432, and all future C kernel LPEs). Go application kernel replaces Linux syscall handlers. |
| 2 | **gVisor netstack** | Network-layer kernel exploits. Go TCP/IP stack replaces Linux net/ipv4, including fragment reassembly and the TCP handshake UAF (CVE-2026-98432). |
| 3 | **gVisor seccomp** | Host syscall abuse. Sentry limited to ~60 host syscalls; rest blocked by seccomp-bpf. |
| 4 | **Gofer process** | Filesystem escape. Separate unprivileged process mediates all file I/O via LISAFS/9P with its own seccomp filter. |
| 5 | **No runc** | Runtime downgrade. No alternative runtime exists on the system. |
| 6 | **No --privileged** | Privilege escalation via Docker. runsc rejects the flag. |
| 7 | **userns-remap** | Container-to-host uid confusion. Each tenant gets a dedicated uid range in the host namespace. |
| 8 | **Per-tenant uid separation** | Cross-tenant access. Sticky bit on `/run/safebox/containers` (mode 1771) prevents socket access across tenants. |
| 9 | **HMAC authentication** | Identity spoofing. Per-container key derived by safebox-keyd via HKDF from master secret. |
| 10 | **OCP governance gate** | Unauthorized operations. M-of-N ES256 signatures on FIDO2 hardware tokens required for all privileged operations. |
| 11 | **Claim-to-operation binding** | Claim replay. OCP claim's `stm.sha256` binds it to the specific operation requested. |
| 12 | **JTI replay prevention** | Request replay. Each claim has a unique JTI; duplicates rejected. |
| 13 | **Exponential backoff** | Churn attacks. Rapid manipulation of governance keys or container lifecycle triggers increasing cooldowns. |
| 14 | **systemd hardening** | Code injection in operator instance. 23 restrictions including W^X memory, syscall filtering, capability removal. |
| 15 | **dm-verity root filesystem** | System binary modification. Kernel verifies every block against a hash tree baked into the image. Even root can't write. |
| 16 | **Secure Boot + vTPM** | Boot-chain tampering. Measured boot; ZFS encryption key sealed to vTPM; unseals only for the verified boot chain. |
| 17 | **AMD SEV-SNP** | Memory snooping by hypervisor or physical access. Hardware encryption of VM memory. |
| 18 | **ZFS encryption** | Data-at-rest exposure. AES-256-GCM on the storage pool. Key sealed to vTPM. |
| 19 | **Transparency log** | Silent tampering. Append-only log of all governance decisions, replicated across Safenet peers. |
| 20 | **Post-quantum TLS** | Harvest-now-decrypt-later attacks on data in transit. Hybrid X25519MLKEM768 key exchange (FIPS 203). |
| 21 | **Kernel module blacklist** | Exploits in unused protocols, filesystems and hardware drivers. 40+ modules blocked via `/etc/modprobe.d/safebox-blacklist.conf`. |
| 22 | **Expanded sysctl hardening** | io_uring, perf_event, userfaultfd and source-routing exploits. Eight additional kernel knobs disabled in `90-safebox.conf`. |
| 23 | **SSH masked at boot** | Remote shell access. `safebox-sealed-boot.service` masks SSH units and removes binaries via overlay whiteouts on sealed images. |
| 24 | **kernel.modules_disabled** | Post-boot module injection. Set to 1 by `safebox-sealed-boot.service` after all modules load; one-way for the life of the boot. |
| 25 | **hidepid=2 on /proc** | Cross-UID process information leakage. Each process sees only its own `/proc` entries. |

Layers 23-25 are conditional on sealing: they apply only to the production image (see [SEALING.md](SEALING.md)). The audit image omits them so auditors can inspect the running system.

Compromise one layer and the others still hold. An attacker must chain multiple independent breaches to reach tenant data.

## Attestation: How a Safebox Proves What It Is

### Instance Identity

On every boot, the system component generates an ephemeral P-256 keypair in RAM. The private key is never written to disk, never serialized, never exported. The public key's SHA-256 hash is the instance identifier: `safebox://<hex>`. When the process exits, the private key is gone — a reboot forces re-attestation with a fresh identity.

### Boot-Time Attestation Claim

After startup, the system component issues a self-signed OCP claim:

```json
{
  "ocp": 1,
  "iss": "safebox://a1b2c3d4...",
  "stm": {
    "type": "attestation",
    "instancePublicKey": "data:key/es256;base64,MFkwEwYH...",
    "measurement": "0xaabb...48-byte-PCR0-hex",
    "cloud": "aws",
    "hardwareRoot": "nitrotpm",
    "parentInstance": "0xccdd...PCR4-derived-hex",
    "imageHash": "sha256:eeff..."
  },
  "nbf": "2026-04-23T14:00:00.000Z",
  "exp": "2026-04-24T14:00:00.000Z"
}
```

This asserts: I am running this measured image, on this cloud's hardware root of trust, and here is my public key so you can verify my signatures.

### Challenge-Response (Liveness Proof)

Any external client can call `POST /attestation/challenge` with a random nonce. The Safebox returns the attestation claim plus a signature over `SHA-256(nonce || claim)` using the instance's ephemeral key. This proves the Safebox is alive right now — not replaying a cached attestation.

### Transparency Log

Every attestation, succession, governance key rotation, and volume blessing is appended to an immutable transparency log at `/var/lib/safebox/transparency/transparency.json`. Each entry has a monotonically increasing sequence number. The log is replicated to `safebox.org`, which aggregates logs across all Safeboxes and detects forks (two instances claiming the same predecessor in a succession chain).

See [TRANSPARENCY.md](TRANSPARENCY.md) for the full protocol.

## Post-Quantum Cryptography: What's Protected and What's Not

### What's PQC-Protected: Data in Transit

Safebox container images build Node.js against OpenSSL 3.5+, which includes ML-KEM (FIPS 203). The hybrid `X25519MLKEM768` key exchange combines classical X25519 with ML-KEM-768 in a single TLS 1.3 handshake. Security holds if either primitive survives.

This protects all Safebox↔Jet and Safebox↔Safebox TLS connections against harvest-now-decrypt-later attacks. An adversary recording traffic today cannot decrypt it even with a future quantum computer.

See [PQ-TLS.md](PQ-TLS.md) for the image build and configuration.

### What's PQC-Protected: Data at Rest

ZFS encryption uses AES-256-GCM. Grover's algorithm reduces the effective key strength to 128 bits, which is still computationally infeasible. Data at rest is quantum-resistant without any changes.

### What's Not Yet PQC-Protected: Attestation and Governance Signatures

Attestation claims and OCP governance signatures currently use ES256 (ECDSA P-256 + SHA-256). Shor's algorithm breaks ECDSA on a cryptographically relevant quantum computer (CRQC).

The practical risk depends on the use case:

**Attestation claims** have a 24-hour validity window. An attacker would need to break ES256 in real time to forge a live attestation — harvest-now-decrypt-later doesn't apply because a stale attestation proves nothing. Until a CRQC can factor P-256 in under 24 hours, classical attestation signatures are safe.

**Governance claims** are more sensitive. A governance claim authorizes a specific operation (container creation, model installation, key rotation). If an attacker could forge governance signatures, they could authorize arbitrary operations. The FIDO2 hardware tokens holding the ES256 keys are the root of trust.

### Path to PQC Attestation and Governance: Hybrid Dual Signatures

The OCP claim format already supports multiple entries in the `key[]` and `sig[]` arrays. The natural extension is dual-signing:

```json
{
  "ocp": 1,
  "iss": "safebox://a1b2c3d4...",
  "stm": {
    "type": "attestation",
    "instancePublicKey": [
      "data:key/es256;base64,MFkwEwYH...",
      "data:key/ml-dsa-65;base64,MIIHbjA..."
    ],
    "measurement": "0xaabb...",
    "cloud": "aws",
    "hardwareRoot": "nitrotpm"
  },
  "key": [
    "data:key/es256;base64,MFkwEwYH...",
    "data:key/ml-dsa-65;base64,MIIHbjA..."
  ],
  "sig": [
    "base64...es256-signature...",
    "base64...ml-dsa-65-signature..."
  ]
}
```

**ML-DSA-65** (FIPS 204, previously known as Dilithium3) is the NIST post-quantum digital signature standard at security level 3 (128-bit post-quantum security). OpenSSL 3.5+ includes ML-DSA, so the same image build that enables PQ-TLS also enables PQ signatures. Node.js linked against OpenSSL 3.5+ can generate and verify ML-DSA signatures using the same `crypto.sign()` / `crypto.verify()` API.

The hybrid approach: the Safebox generates both an ES256 and an ML-DSA-65 keypair at boot. Attestation claims are dual-signed with both keys. Verifiers check both signatures — if either is valid, the attestation holds. This provides backward compatibility (existing clients that only understand ES256 can ignore the ML-DSA signature) and forward security (if P-256 is broken, ML-DSA still holds; if ML-DSA is broken, ES256 still holds).

### Can an External Client Verify Attestation in a PQC Way?

Yes. A Safecloud client (or any external verifier) can verify PQC attestation by:

1. **Calling `POST /attestation/challenge`** with a random nonce. The Safebox returns the dual-signed attestation claim and a dual challenge signature (one ES256, one ML-DSA-65) over the nonce.

2. **Verifying both signatures.** The client checks:
   - The ES256 signature over `SHA-256(nonce || claim)` using the ES256 public key from `instancePublicKey[0]`.
   - The ML-DSA-65 signature over `SHA-256(nonce || claim)` using the ML-DSA-65 public key from `instancePublicKey[1]`.
   - Both keys match the ones declared in the attestation claim's `stm.instancePublicKey`.
   - The claim has not expired (`nbf <= now <= exp`).
   - The `measurement` (PCR0) matches the expected blessed image hash.

3. **Trusting the result if either signature verifies.** If the classical signature is broken by a quantum computer, the PQ signature still proves authenticity. If ML-DSA turns out to have an unforeseen weakness, ES256 still holds.

The Safecloud client libraries need to add ML-DSA-65 verification support. Since Safecloud clients are software (not hardware tokens), they can be updated to use any crypto library that implements FIPS 204 — OpenSSL 3.5+, liboqs, or a pure-JavaScript implementation like `pqc-ml-dsa`.

For governance claims, the path is longer because the signing keys are on FIDO2 hardware tokens. PQ signature support on FIDO2 tokens depends on hardware manufacturers adopting FIPS 204. In the interim, governance claims can use a software-based ML-DSA co-signature alongside the hardware ES256 signature, with the ML-DSA private key stored in the Safebox's encrypted ZFS pool (protected by vTPM-sealed encryption and dm-verity). This is a weaker trust model for the PQ signature (software key vs. hardware token) but still provides quantum resistance for the signature itself.

## OCP Governance: Authorization at the Infrastructure Layer

The infrastructure base independently verifies that M-of-N governance signers approved every privileged operation. HMAC proves identity (who is speaking); OCP proves authorization (whether the operation was approved). Both must pass.

### Thresholds

| Operation | Threshold | Why |
|---|---|---|
| `POST /system` (all tool invocations) | 3 of 5 | dnf, docker exec, git, migrate, zfs — any tool call can modify the trust surface. |
| `POST /containers/create` | 4 of 5 | Adds a new entity with its own HMAC key. Expands the trust surface. |
| `POST /containers/destroy` | 4 of 5 | Removes a container and its key. |
| `POST /models/install` | 2 of 3 | Supply chain operation. External model weights enter the system. |
| `POST /volumes/install` | 2 of 3 | External volumes mounted into the base. |
| `POST /succession/*` | 4 of 5 | Transfers the master secret between instances. |

### Genesis Keys

The genesis governance keys are baked into the base image at build time. They are part of the dm-verity-measured filesystem — they contribute to PCR0. Changing who controls the Safebox IS building a new image, which requires governance approval of the new image, which requires M-of-N of the current key set. This is a bootstrap loop by design — the root of trust cannot be silently replaced.

### Key Rotation

Runtime key rotation requires a supermajority (M+1) of the current key set. Exponential backoff applies to churn: the cooldown between key removal operations doubles with each removal. If multiple rotations happen within a 90-day window, the cooldown multiplier increases from 2x to 3x to 4x. Even with 9 of 10 keys compromised, a full governance takeover takes years, giving the honest minority time to respond.

See [OCP-IN-BASE.md](OCP-IN-BASE.md) for the full protocol.

## Image Sealing: Audit vs Production Hardening

Safebox uses a two-image workflow (identical across AWS, GCP, Azure and OCI). An **audit image** has SSH and root access so external auditors can inspect a running instance. After the audit passes, `safebox-seal-image.sh` seals the image by writing a single flag file (`/etc/safebox/sealed`). The resulting **production image** differs from the audit image by exactly one file on disk. At boot, `safebox-sealed-boot.service` detects the flag and applies hardening measures that would have blocked the auditors' work:

| Measure | Effect | Why conditional |
|---------|--------|-----------------|
| **SSH masked** | SSH units masked, binaries removed via overlay whiteouts by `safebox-sealed-boot.service` | Auditors need SSH to log in and inspect the running system |
| **kernel.modules_disabled=1** | One-way sysctl set by `safebox-sealed-boot.service` after all modules load | Auditors may need diagnostic modules (`kprobes`, tracing) |
| **hidepid=2 on /proc** | Each UID sees only its own processes | Auditors inspect all process ownership and listeners |

SSH binaries and config remain on the dm-verity root filesystem but are invisible to userspace on sealed boots because the overlay whiteouts take precedence. This design eliminates all seal-step nondeterminism: the only on-disk change between Image A and Image B is the flag file.

The sealed-boot service runs `After=multi-user.target docker.service safebox-nftables.service zfs.target`, ensuring Docker, ZFS, nftables and all other modules are fully loaded before module loading is disabled. Both `modules_disabled` and `hidepid` are one-way for the life of the boot — they cannot be undone without a reboot, which on a dm-verity root returns the box to its verified state.

See [SEALING.md](SEALING.md) for the full workflow, file inventory and verification steps.

## Proactive Kernel Attack-Surface Reduction

Beyond responding to specific CVEs, the base image proactively disables kernel features that Safebox does not use. Every disabled feature is one fewer entry point for a future, undisclosed vulnerability.

### Kernel Module Blacklist

`/etc/modprobe.d/safebox-blacklist.conf` prevents the kernel from loading modules for protocols, filesystems and hardware that a cloud-hosted Safebox never uses. Each entry uses `install <module> /bin/false`, which makes `modprobe` return success without loading the module — so autoloaders and dependency pulls do not reintroduce attack surface.

**Blocked network protocols:** SCTP, DCCP, TIPC, RDS, n-hdlc, AX.25, NET/ROM, X.25, ROSE, DECnet, Econet, IEEE 802.15.4, IPX, AppleTalk, SNAP (psnap), 802.3 (p8023/p8022), CAN, ATM. Safebox uses only IPv4/IPv6 TCP, UDP, Unix sockets and vsock (for Nitro Enclave communication). Every other protocol family is pure attack surface — many have had remote code-execution CVEs over the years, and several are effectively unmaintained.

**Blocked filesystems:** cramfs, freevxfs, jffs2, hfs, hfsplus, udf. Cloud VMs never mount these. A crafted filesystem image that triggers a bug in one of these parsers is a standard local privilege-escalation technique; blocking the module removes it entirely.

**Blocked hardware:** usb-storage, firewire-core, firewire-ohci, thunderbolt, bluetooth, btusb, cfg80211, mac80211. Cloud VMs have no USB ports, no FireWire, no Thunderbolt, no Bluetooth and no wireless NICs. These modules serve only as attack surface for DMA attacks, BlueBorne-style exploits and rogue-device scenarios that do not apply.

### Expanded Sysctl Hardening

`/etc/sysctl.d/90-safebox.conf` disables kernel features beyond the original HARDENING-PLAN.md scope:

| Sysctl | Value | Why |
|---|---|---|
| `kernel.perf_event_paranoid` | `3` | Restricts perf_event to CAP_PERFMON processes. Unprivileged performance counters have been used in side-channel attacks (Spectre-variant timing, cache eviction). Safebox runs no profiling workloads. |
| `kernel.io_uring_disabled` | `2` | Disables io_uring for all users. io_uring has had a steady stream of privilege-escalation CVEs since its introduction in 5.1. Safebox uses no io_uring — all I/O goes through standard read/write or gVisor's emulated syscalls. |
| `vm.unprivileged_userfaultfd` | `0` | Restricts userfaultfd to privileged processes. Unprivileged userfaultfd is a textbook building block for kernel exploit races — it lets an attacker pause a page fault mid-copy, creating a controlled TOCTOU window. |
| `fs.suid_dumpable` | `0` | Prevents core dumps from setuid binaries. Core dumps can leak credentials and encryption keys from process memory. |
| `net.ipv4.tcp_syncookies` | `1` | Enables SYN cookies. Under a SYN flood, the kernel encodes connection state in the SYN-ACK sequence number instead of allocating backlog memory, preventing resource exhaustion without dropping legitimate connections. |
| `net.ipv4.conf.*.accept_source_route` | `0` | Disables IP source routing on all interfaces. Source-routed packets let an attacker specify the path through the network, bypassing firewall rules and network segmentation. |
| `net.ipv4.conf.default.*` | matches `all` | Ensures new interfaces inherit the same hardening as `all`. Without `default` settings, a dynamically created interface (Docker bridge, veth pair) would use kernel defaults. |
| `net.ipv6.conf.*.accept_source_route` | `0` | Same as IPv4 source-route disable, for IPv6. |

## Kernel CVE Resilience

This section analyzes specific kernel CVEs and why they do not compromise Safebox deployments.

### CVE-2026-43284 + CVE-2026-43500 (Dirty Frag)

IPv4 fragment reassembly exploits in the host kernel's `net/ipv4` path. gVisor's netstack handles all fragment reassembly for container traffic in userspace Go code, so the vulnerable kernel code path is never reached by container workloads. The host kernel is patched in the base image, but even without the patch, no container-originated traffic can trigger the bug.

### CVE-2026-98432 (IPv4 TCP Handshake UAF)

CVSS 9.8, remote, unauthenticated. A use-after-free in the host kernel's TCP handshake code (`net/ipv4/af_inet.c`, `net/ipv4/tcp_ipv4.c`): when a connecting peer sends IPv4 header options, the kernel passes the option block to the new socket without copying, then frees it while another CPU may still read it. Impact ranges from heap disclosure to remote code execution.

**Why Safebox is protected (three layers):**

1. **gVisor netstack.** All container TCP traffic uses gVisor's Go TCP/IP stack. The vulnerable kernel functions are never called for container workloads. This is the primary defense — it is architectural, not a patch race.
2. **Host firewall rule.** The `safebox-imds.nft` input chain drops all inbound TCP SYN packets carrying IPv4 header options (`ip hdrlength > 5 tcp flags syn`) before any port accept. This prevents the vulnerable code path from being reached even for the host's own listeners. Legitimate TCP connections are unaffected because timestamps, window scaling, and SACK are TCP-layer options (inside the TCP header), not IP-layer options (in the IPv4 header).
3. **MPTCP disabled.** The CVE is especially dangerous with MPTCP listeners (Go ≥1.24 enables MPTCP by default). The sysctl `net.mptcp.enabled = 0` in `90-safebox.conf` disables MPTCP at the kernel level, removing this attack surface entirely.

The host kernel should still be patched in the base image as a matter of course, but the Safebox deployment is protected independently of the host kernel version.

## Multi-App Isolation and Blast Radius

A single Safebox can host multiple applications, each running in its own gVisor-sandboxed Docker container with its own volumes, network rules, and capabilities. This isolation is structural, not policy-based — each app is in a separate container with a separate UID range (userns-remap), separate network namespace, and separate filesystem view. App A cannot see App B's processes (`hidepid=2`), cannot access App B's data (separate ZFS datasets), and cannot reach App B's container network (inter-container communication is disabled by default via `icc: false` in the Docker daemon config).

### Blast Radius of an App-Level Vulnerability

If an application has a logic error — even a full remote code execution vulnerability — the blast radius is contained to that application's container:

| What the attacker gets | What they don't get |
|---|---|
| Access to that app's data (its own database, its own volumes) | Access to any other app's data |
| Ability to make network requests the app is allowed to make | Access to the host filesystem (gVisor sandbox) |
| Ability to read that app's environment variables and credentials | Access to the host kernel's syscall interface |
| Whatever authority the app itself has for that boot | Persistence across reboot (dm-verity restores the verified image) |
| | Lateral movement to other containers on the same Safebox |
| | Access to the Docker socket, ZFS keys, or governance credentials |
| | Ability to install a backdoor that survives reboot |

This is a fundamentally different blast radius from a traditional VPS or even a standard Docker deployment, because the gVisor sandbox prevents the attacker from reaching the host kernel even if they achieve root inside the container, and the dm-verity root filesystem prevents any changes from persisting across reboot.

### Shared Infrastructure Services

Applications on the same Safebox share infrastructure services without sharing each other's data:

| Service | Isolation Model |
|---|---|
| **MariaDB** | Each app gets its own database with its own credentials. A compromised app can trash its own tables but cannot query another app's database. |
| **LLM inference** | The Safebox proxies requests to configured providers (or runs local models). Each app calls through the proxy with its own quota. Other apps don't see the requests. |
| **ffmpeg / ImageMagick** | Available as host services or sidecar containers. Processing happens outside the app's container, so a malicious input that exploits a media processing vulnerability is contained in the processing sandbox, not in the app's data volume. |
| **Typesense** | Each app gets its own collection namespace. Full-text search is shared infrastructure; search indexes are per-app. |
| **Redis** | Each app gets its own key prefix or database number. Cache is shared infrastructure; cached data is per-app. |

The net effect: each app gets the blast-radius containment of its own isolated container, the shared services of a full-stack server (databases, media processing, AI inference, search), and the security posture of a hardware-attested, immutable-root system — without any single app being able to compromise another app, the host, or the network.

### Cross-Safebox Services via Safenet

For workloads that span multiple Safeboxes (e.g., an app on Safebox A that needs GPU inference from Safebox B), Safenet provides transparent remote service calls over mutual TLS between attested Safeboxes. Both sides verify each other's TPM quotes before exchanging data. The app on Safebox A doesn't know or care that the call left its box — the Safenet layer handles attestation, routing, and settlement. Inter-Safebox service costs are metered and settled automatically in Safebux, the Safenet micropayment protocol. No credit cards, no invoicing, no payment API integration — the operator of Safebox A sees a line item for GPU time consumed, and the operator of Safebox B sees revenue.

See the [Safenet README](https://github.com/Safebots/Safenet) and [Safenet PROTOCOL.md](https://github.com/Safebots/Safenet/blob/main/PROTOCOL.md) for the full protocol specification.

## What Would Actually Compromise This

After all 25 defense layers, four attack vectors remain:

### 1. gVisor Sentry Escape (No Known Exploit)

A logic bug in the Sentry that allows a sandboxed process to trick it into issuing a host syscall with attacker-controlled arguments. The Sentry is ~200K lines of Go — memory-safe, but logic bugs are possible. gVisor is used by Google Cloud Run, GKE Sandbox, and Google's internal infrastructure. No sandbox escape has been publicly demonstrated.

**Difficulty:** Requires finding a novel logic bug in a memory-safe Go program, then chaining it with a seccomp bypass and a host kernel exploit. No known working chain.

### 2. Operator Instance or safebox-keyd Bug (No Network Port)

The operator instance handles container lifecycle and model installation. safebox-keyd derives and distributes HMAC keys. Both communicate exclusively over Unix sockets with mode 0600 — no network port, no remote access. An attacker would need local code execution on the host (which requires escaping gVisor first) and then a logic bug in one of these processes.

**Difficulty:** Requires prior sandbox escape + logic bug in a small, auditable Node.js process with no external attack surface.

### 3. 3/5 Hardware Key Physical Theft

The governance keys are ES256 keys on FIDO2 hardware tokens held by different humans. Forging a governance claim requires physically possessing 3 of the 5 tokens and knowing their PINs. This is a physical security problem, not a software security problem.

**Difficulty:** Physical theft of multiple hardware tokens from multiple people in multiple locations.

### 4. AMD SEV-SNP Silicon Bug (Nation-State)

AMD SEV-SNP provides hardware-encrypted VM memory. A bug in the silicon — not the firmware, the actual chip — could allow a hypervisor to read plaintext VM memory. This would expose the unsealed ZFS key and the instance's ephemeral private key. Such a bug would be an AMD product vulnerability affecting every SEV-SNP deployment globally.

**Difficulty:** Finding a hardware bug in AMD's memory encryption engine. Nation-state capability.

## What Root Can't Do on a Production Safebox

Even if an attacker achieves root on the host through some unforeseen path:

- **Can't modify system binaries.** dm-verity root filesystem. The kernel verifies every block against a hash tree baked into the image. Write attempts fail at the block device layer.
- **Can't read tenant data at rest.** ZFS encryption key is sealed to the vTPM. Root can read the sealed blob but can't unseal it without the TPM's cooperation through the measured boot chain.
- **Can't forge governance claims.** ES256 keys are on FIDO2 hardware tokens. Not on disk anywhere. Not derivable from anything on the system.
- **Can't install a persistent backdoor.** Next boot re-verifies the image hash. A modified image won't pass Secure Boot + dm-verity.
- **Can't SSH in.** There is no sshd. No console access. No way in except the HTTP ports, which enter gVisor sandboxes.
- **Can't get a root shell.** The root account is locked (`passwd -l`) and its shell is `/usr/sbin/nologin`. Even `su - root` fails.
- **Can't load kernel modules.** `kernel.modules_disabled=1` is set after boot by `safebox-sealed-boot.service`. This is a one-way sysctl — the kernel rejects all module loads until reboot.
- **Can't enumerate processes.** `/proc` is mounted with `hidepid=2`. Each UID sees only its own processes.
- **Can't modify the transparency log undetectably.** The log is replicated across Safenet peers. Any change is detected by `safebox.org` aggregation.
- **Can't survive a reboot.** The dm-verity root means nothing the attacker writes to the filesystem persists. A fresh boot restores the verified image.

Root on a running Safebox gives the attacker exactly one thing: access to in-memory secrets (the unsealed ZFS key, the ephemeral instance private key) for the duration of that boot. It doesn't persist, can't spread to other Safeboxes, and can't modify the system.

## Production Checklist

- [x] gVisor (runsc) as default and only Docker runtime
- [x] No runc installed on the system
- [x] `--privileged` rejected by runsc
- [x] systemd unit with 23 security restrictions on operator instance
- [x] M-of-N OCP governance on all privileged operations
- [x] HMAC authentication on all inter-process communication
- [x] Per-tenant uid separation with sticky-bit socket directory
- [x] dm-verity root filesystem with Secure Boot
- [x] vTPM-sealed ZFS encryption
- [x] AMD SEV-SNP hardware memory encryption
- [x] Ephemeral instance identity with hardware-bound attestation
- [x] Append-only transparency log replicated across Safenet
- [x] Governance genesis keys baked into measured image
- [x] Exponential backoff on governance key rotation churn
- [x] Post-quantum TLS (X25519MLKEM768) for data in transit
- [x] AES-256-GCM at rest (quantum-resistant)
- [x] Kernel module blacklist (40+ unused modules blocked)
- [x] Expanded sysctl hardening (io_uring, perf_event, userfaultfd, source routing, SYN cookies)
- [x] Image sealing workflow (audit image → sealed flag → production image)
- [x] SSH masked at boot on sealed images (overlay whiteouts)
- [x] kernel.modules_disabled=1 on sealed images (post-boot, one-way)
- [x] hidepid=2 on /proc on sealed images (process isolation)
- [x] Per-app container isolation (separate UID ranges, network namespaces, ZFS datasets)
- [x] Inter-container communication disabled by default (icc: false)
- [x] Shared services with per-app credentials (MariaDB, Redis, Typesense)
- [x] Media processing in isolated sandbox (ffmpeg, ImageMagick separate from app data)
- [x] LLM inference proxy with per-app quota
- [x] Hybrid PQ attestation signatures (ML-DSA-65 + Ed25519 dual-sign in Software Signer) — requires OpenSSL 3.5+ image build
- [ ] Hybrid PQ governance signatures — HARDWARE-GATED: current FIDO2 tokens (YubiKey 5) do not support ML-DSA; FIDO2 PQ spec is in draft; no production devices exist. Will upgrade when PQ-capable FIDO2 hardware ships. This is a hardware constraint, not deferred work.
- [ ] safebox.org aggregation live

## Conclusion

The system is nigh-unhackable. The remaining attack vectors are: finding a logic bug in Google's gVisor sandbox (no known exploit, memory-safe Go, battle-tested across billions of containers), physically stealing 3 of 5 hardware governance tokens, finding a bug in AMD's memory encryption silicon, or exploiting a logic bug in the operator instance or safebox-keyd (no network port, Unix socket mode 0600, reachable only after escaping gVisor). These are not software security problems in the traditional sense — they require novel capability against hardened, memory-safe infrastructure, physical access to distributed hardware tokens, or nation-state hardware exploitation.

Post-quantum protection is complete for data in transit (hybrid TLS) and data at rest (AES-256-GCM). Attestation and governance signatures use classical ES256 today; the path to hybrid PQ signatures (ML-DSA-65 + ES256) is a straightforward extension of the existing OCP claim format and requires no protocol changes — only an image build against OpenSSL 3.5+ (which is already done for PQ-TLS) and client-side ML-DSA verification support. External clients, including Safecloud clients, can verify PQC attestation through the existing challenge-response endpoint once dual signatures are enabled.

See [VM.md](VM.md) for the full gVisor architecture and attack chain analysis.
