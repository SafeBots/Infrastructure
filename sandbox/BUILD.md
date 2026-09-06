# Building and running the inspection sandbox (Variant 2)

Copy-pasteable build + run for the OPTIONAL untrusted-code inspection sandbox. This is a separate build target from the default Safebox; the default ships without any of it. Like every Safebox, the build/boot/attest steps need a real Nix machine and confidential hardware — this doc is the operator runbook, and it maps to the modules and the batch worker already in the tree.

## Prerequisites

A Nix machine with cache access (see nixos/TURN1-RUNBOOK.md), and — for the real boot — a confidential instance (see the per-cloud table in the README / Nix.md). The sandbox is expressed as composition: hosts/sandbox-outer.nix imports the base (hosts/safebox.nix) verbatim and adds the wrapper module (modules/sandbox-host.nix); the inner microVM is modules/sandbox-inner.nix. The base ships by itself via .#ami etc.; the wrapper is strictly additive, so removing it leaves the base intact.

## 1. Generate the interceptor CA (one-time, kept offline)

The interceptor mints per-host certs signed by its own CA; the CA cert is baked into the inner VM's measured trust store. Generate the CA offline and reference its cert path from both modules:

```
# offline, on a trusted machine
openssl req -x509 -newkey ed25519 -days 3650 -nodes \
  -keyout interceptor-ca.key -out interceptor-ca.crt \
  -subj "/CN=Safebox Inspection Interceptor CA"
# the .crt goes into the inner image (measured); the .key stays on the outer host, interceptor-only.
```

## 2. Build the outer host and the inner microVM images

```
# outer sealed host that runs the interceptor + hosts the inner VM
nix build .#sandbox-outer        # base safebox + sandbox wrapper (composed)

# inner microVM image (single tap, CA in trust store, job runner)
nix build .#sandbox-inner
```

Both are NixOS closures; the outer host (hosts/sandbox-outer.nix) composes the base and enables safebox.sandboxHost; the inner (modules/sandbox-inner.nix) enables safebox.sandboxInner. The build asserts the outer bridge address and the inner gateway agree (10.200.0.1) — a mismatch fails the build.

## 3. Seal the outer host (removes SSH, like every Safebox)

```
# boot the outer builder, then:
attestation/ami2-seal/seal-ami2.sh --rootfs <mounted-outer-image>
```

After sealing, the outer host has no SSH and — being NixOS — no package manager: it cannot install anything or be changed at runtime without rebuilding the closure (which changes the measurement and fails attestation). This is what makes it a trustworthy container for possibly-hostile inner code.

## 4. Configure the interceptor policy

Copy sandbox/interceptor/policy.example.json, set the host allowlist, volume limits, and audit level. v0 runs a mature MITM (mitmproxy or a Go crypto/tls MITM) wired to this policy; Turn 4 (see BATCH-TESTING-SPEC.md) replaces it with the U-written, capability-bounded, M-of-N-blessed interceptor.

## 5. Run a batch

The batch worker (sandbox/batch_worker.py) owns the per-job lifecycle: clone -> boot inner VM -> run with timeout -> capture (exit + interceptor egress record) -> ALWAYS teardown (destroy VM + ZFS clone). Wire its SandboxDriver Protocol to the real Firecracker/ZFS/interceptor calls on the host, then feed it jobs from your queue. Parallelize by running N workers; Firecracker microVMs are cheap and dense, which is how you run massive batteries.

```
# each job, conceptually:
run_job(driver, job_id, entrypoint=["/path/to/untrusted/binary", "arg"], ca_cert="interceptor-ca.crt", timeout_s=900)
# -> JobResult{exit_code, timed_out, egress_record, quarantined, phases}
```

A job that trips a volume limit or whose connection pins-and-fails is flagged quarantined in its egress record — surfaced by the worker, not hidden.

## 6. Attestation (gated, same as the rest)

Because it is all one machine, there is no inter-machine network topology to attest — one attestation of the outer host covers the interceptor + the inner-VM single-wire topology + the measured CA. Proving that end-to-end needs the real confidential hardware, per attestation/TURN3-ATTESTATION-RUNBOOK.md.

## What's proven in-repo vs gated

Proven now (config-level + logic): the module invariants (sandbox/test/test-sandbox-host-invariants.sh, test-sandbox-inner-topology.sh) and the batch lifecycle (test-batch-worker.py — teardown always happens, quarantine surfaced). Gated on Nix machine + hardware: the real build, the real Firecracker boot, the live MITM, and the one-attestation-covers-all proof.

## Audit before sealing (before SSH is removed)

The entire sandbox is declarative and lives in five plain files that are part of the measured closure — an auditor reviews these BEFORE the seal removes SSH, and their content is exactly what the attestation later proves is running:

- `nixos/hosts/sandbox-outer.nix` — composes the base + wrapper; asserts address consistency.
- `nixos/modules/sandbox-host.nix` — the interceptor service, the dead-end bridge, the inner-VM launcher, the immutability + no-sshd assertions.
- `nixos/modules/sandbox-inner.nix` — single-NIC topology, route-to-interceptor-only, CA in the measured trust store, hard timeout.
- `nixos/modules/sandbox-interceptor/policy_addon.py` — the deny-default allowlist + volume-metering + audit logic.
- `sandbox/interceptor/policy.example.json` — the policy data (allowlist, limits).

Run `bash tests/run-all.sh` (the sandbox suites are included) to confirm the invariants hold, review the five files, THEN build and seal. Because the base is unchanged and the wrapper is additive, an auditor who has already blessed the base only needs to review the wrapper delta.

## Fail-closed behavior (defense in depth)

If the interceptor process dies, the inner VM does not gain an escape: the bridge is a dead-end with no uplink and no NAT, so with the interceptor down there is nothing forwarding traffic — inner egress fails closed. The interceptor restarts on failure. And because it is all one machine, there is no separate network path for a compromised inner VM to discover: its single tap reaches only the bridge, and the bridge reaches only the interceptor.
