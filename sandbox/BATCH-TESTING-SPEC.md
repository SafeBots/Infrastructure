# Inspection sandbox for batch test batteries

The build spec for running massive batteries of tests over untrusted code/binaries, on any cloud, uniformly. This is the untrusted-code variant from the README ("Testing untrusted code"), specialized for batch throughput rather than interactive use. Trusted-code testing does NOT use this — it uses the default Safebox's existing controls (Docker + seccomp + ZFS clone + egress.nix) with a clone-run-teardown wrapper; see "Trusted vs untrusted" below.

## What this is for

Running large numbers of test jobs — a battery of candidate binaries, dependency-vetting runs, arbitrary-language workloads — where each job is untrusted (any language, any binary, no capability manifest) and you assume it may be hostile and that you will not notice. Batch, not interactive: no latency budget, simple boot-run-teardown lifecycle, high throughput via parallelism.

## Why batch is the easy case

Three things that make interactive inspection hard don't apply here: (1) no latency budget, so nested-VM + MITM overhead is invisible and needs no hot-path optimization; (2) no session/streaming state — each job is boot → run → capture → destroy; (3) orchestration is a work queue, not a scheduler with SLAs. The heavy machinery's cost is free precisely because the workload is asynchronous.

## Architecture (one box, one added layer)

Each job runs in an inner NixOS microVM nested inside the Safebox, on the SAME machine as the interceptor — so there is no inter-machine network wire whose topology would otherwise have to be attested (cloud SDN config is not covered by VM attestation). One measured closure, one attestation, covering the inner jail + the interceptor + the single egress path. Uniform on every cloud because it's all intra-machine.

```
Safebox (attested, sealed NixOS base — the outer machine)
 └─ batch worker (pulls jobs from a queue)
     └─ per job:
         ├─ ZFS clone of the job's scratch dataset           (writes evaporate on teardown)
         ├─ inner NixOS microVM (Firecracker-class)          (the untrusted binary runs here)
         │    • ONE tap device → interceptor bridge; no other NIC/route
         │    • interceptor CA baked into the inner trust store (measured)
         │    • seccomp/resource caps; timeout
         └─ interceptor (outer layer, same box)
              • terminates inner TLS with on-the-fly certs signed by its CA
              • reads plaintext: policy + host allowlist + volume metering + audit log
              • re-originates a fresh, validated TLS outward to the real destination
     └─ on job end: capture stdout/stderr/exit + egress record → destroy microVM + ZFS clone
```

## Build order (fast path first, harden later)

### Step 1 — Inner NixOS microVM with single-tap topology  [days]
Firecracker (or cloud-hypervisor) booting a minimal NixOS microVM image (nixos-generators produces it). Exactly one tap device, wired to the interceptor bridge; no other NIC and no default route, so the untrusted binary has no network path except the interceptor — enforced by the microVM's device config, not by the binary's cooperation. Reuse: the seccomp profiles in docker/security/seccomp/ for the in-VM process caps; the ZFS module for the clone.

### Step 2 — Interceptor with its own CA  [days → ~1 week]
Fast path: adopt a mature MITM (mitmproxy, or a Go crypto/tls MITM library) rather than writing one. It mints per-host certs on the fly signed by its CA; the CA is baked into the inner microVM's trust store via a NixOS config line (so the trust is measured, not a runtime hack). Wire in the policy: host allowlist, per-destination volume metering, full plaintext audit log. Reuse the allowlist seam from egress.nix conceptually (here it's hostname-level at the interceptor, not IP-prefix).

### Step 3 — Batch worker loop  [days]
A queue worker: pull job → ZFS clone → boot inner microVM with the job's binary → run with a hard timeout and resource caps → capture (exit code, stdout/stderr, the interceptor's egress record) → destroy microVM + clone. Parallelize by running N inner microVMs concurrently (Firecracker is designed for high-density parallel microVMs — this is how you run massive batteries). Results and egress records go to durable storage keyed by job id.

### Step 4 — Harden + prove  [gated on real Nix machine + hardware]
Replace the adopted MITM with the minimal, capability-bounded interceptor (written in U, M-of-N-blessed) so the component that reads all plaintext is the most-proven thing in the system. Confirm the outer machine remains incapable of running arbitrary code (reproducible, attested, no install path). Prove that ONE attestation covers the whole closure — inner-VM topology + interceptor + CA-in-measured-trust-store. This step is gated on the same real-Nix-build + confidential-hardware steps as the base migration (Nix-turns.md).

## Cert pinning / TOFU (the interception contract)

Standard TLS validation → transparent inspection, works. TOFU pinning → defeated for free (the binary's first connection IS the interceptor, so it pins to the interceptor, never having seen the real origin's cert). Baked-in pin you built → don't bake it into the test build. Baked-in pin in a third-party binary → its pinned connections fail, BY DESIGN — and that failure is signal (a binary pinning to resist inspection is exactly what to flag when vetting). Never defeat pinning by patching the binary — that would mean not inspecting it, which defeats the purpose.

## Trusted vs untrusted (why there's no middle tier)

The isolation tier is chosen by WHAT you run, not by the fact that you're testing:
- **Trusted code** (your own suite, a reviewed PR): the default Safebox's existing controls are sufficient — Docker + seccomp + ZFS clone + egress.nix. The threat is bugs, not adversaries; bugs don't need a microVM. Build only a small clone-run-teardown wrapper; do NOT build a separate isolation tier for this.
- **Untrusted code** (arbitrary binaries, dependency vetting): this spec — inner microVM + interceptor. You know nothing about the code, so every guarantee is runtime/structural and the MITM is mandatory and proportionate.

There is no middle tier because the two ends cover the space: your own code gets the default box; unknown code gets the sandbox.

## Effort summary

Steps 1–3 (a working batch inspection sandbox, adopted-tool interceptor): weeks, mostly reuse + adopt. Step 4 (hardened U interceptor + attestation-covers-all proof): gated on the real-Nix/hardware steps that gate the rest of the migration. Build 1–3 to prove the flow end-to-end; do 4 to make it provable.
