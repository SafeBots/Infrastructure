# Inductive Trust on a Safebox

How an auditor verifies what is running on a Safebox, end to end, from hardware attestation down to the exact files on disk. This document is written for auditors and is the canonical statement of the trust property the system holds. The implementation that makes the property hold lives in [`aws/scripts/components/system/opsModels.js`](../aws/scripts/components/system/opsModels.js) and in the artifact manifests under [`config/artifacts/`](../config/artifacts/). The companion operational doc is [ARTIFACT-UPDATES.md](./ARTIFACT-UPDATES.md).

---

## The property we hold

**At any point in time, the running state of a Safebox is exactly equal to (AMI bytes) ⊕ (artifacts installed since boot, each cryptographically verified against an M-of-N signed manifest).**

That equation is the whole architecture. Everything else in this document is the proof — the base case, the inductive step, and the consequences.

If the property holds, an auditor can answer the question *"what is running on this Safebox"* by reading three things: the AMI attestation, the set of signed artifact manifests since boot, and the current install state on disk. No on-site inspection of running processes. No "trust the operator." No process documentation. The cryptographic record is the answer.

---

## Base case — the AMI

A Safebox starts as an AMI (Amazon Machine Image) whose bytes are fixed at build time. The AMI is hardware-attested by AWS Nitro Enclave: the hypervisor measures the image's hash before the VM is permitted to boot, and AWS publishes that measurement as a signed attestation document. An auditor can fetch the attestation, verify the signature against the AWS public key, and read the measured AMI hash directly.

The AMI itself is built reproducibly from:

1. **A pinned Amazon Linux 2023 base image** whose hash is recorded.
2. **A set of RPM packages** whose SHA-256 hashes match the manifests under [`config/artifacts/rpm/`](../config/artifacts/rpm/).
3. **A set of Node.js packages** whose tarball SHA-512 integrity values match the manifests under [`config/artifacts/npm/`](../config/artifacts/npm/).
4. **A set of Python packages** whose wheel SHA-256 hashes match the manifests under [`config/artifacts/pip/`](../config/artifacts/pip/).
5. **A set of configuration files** — sudoers allowlist, systemd unit files, the Safebox plugin source — all under version control with deterministic content.

Two builds from the same manifest set produce byte-identical AMIs. The AMI hash is therefore a function purely of the signed manifest set. An auditor confronted with a running Safebox can: read the manifest set the build claimed to use, reproduce the build locally, compare the resulting hash to what AWS Nitro attests is running. Equal hashes mean the running AMI was built from the signed manifests.

This is the base case. It establishes the property for `t = boot`.

---

## Inductive step — every install verifies an artifact

After boot, the only way for the running state to change in a way that affects what code executes is to install something — a new AI model, a security-patched RPM, a Node module update, a Python wheel. Every such install goes through the same pipeline, which we will state as an invariant and then walk through:

**Invariant:** No bytes reach a running directory on a Safebox without first being hashed and the hash matched against a manifest entry signed by M-of-N of the community's auditors.

The pipeline that maintains the invariant has five steps, the same five for every artifact kind:

1. **A signed manifest names what the install will be.** The manifest carries `name`, `version`, `kind` (model / rpm / npm / pip / hf-file / binary), `consumer` (who will load it: a model runner, the system, the Node runtime, the Python runtime), `license`, and a `files` array — each file with `sizeBytes`, `sha256`, optional `integrity` (for npm-native sha512), and `sources` (a list of HTTPS URLs to try in order). The manifest is canonicalized to RFC 8785 JSON, the canonical JSON is SHA-256'd, and that hash becomes the **manifest hash** that auditors actually sign over.

2. **M-of-N of the community's auditors sign** the manifest hash using the OpenClaim envelope (ES256, P-256 + SHA-256 — see [`classes/Safebox/Signature.js`](https://github.com/Safebots/Safebox/blob/main/classes/Safebox/Signature.js) in the Safebox plugin source). The signatures are attached to a `Safebox/action` stream with an `actionType` matching the install kind (`models/install`, `packages/system/install`, `packages/node/install`, `packages/python/install`). The Safebox policy system enforces the per-action-type M-of-N threshold.

3. **The system component receives the signed manifest** with a `verifiedOpToken` — a short-lived bearer token issued only after enough signatures land. The dispatcher in [`opsArtifacts.handleInstall()`](../aws/scripts/components/system/opsArtifacts.js) (a thin wrapper over `opsModels.handleInstall` that branches on `manifest.kind`) takes over.

4. **Each file in the manifest is fetched from `sources[0]`, then `sources[1]`, etc.** First HTTPS source returning a 200 is used. The downloaded file's size is checked against `sizeBytes`; mismatch aborts. The file's SHA-256 is computed and compared against the manifest's `sha256`; mismatch aborts. For npm artifacts, the SHA-512 integrity field is also computed and compared. Any failure deletes the partial download and throws — no silent fallback.

5. **The verified files are atomically moved into a kind-appropriate location** named by the manifest hash:

   | kind | install destination | binding mechanism |
   |---|---|---|
   | `model` | `/srv/safebox/models/<manifestHash>/` | Runners mount this directory read-only |
   | `rpm` | `dnf localinstall` of the verified RPMs into the running system | Persists to the next AMI build via the rebuild pipeline |
   | `npm` | `/var/lib/safebox/node-runtime/<consumer>/node_modules/` | Consumed by Qbix at process restart |
   | `pip` | `pip install --require-hashes` into `/var/lib/safebox/python-runtime/<consumer>/venv/` | Consumed by FastAPI runners at restart |
   | `hf-file` | `/srv/safebox/hf-cache/<manifestHash>/` | Read-only, mounted as needed |

If steps 1–5 all complete, the running state is now (previous running state) ⊕ (artifact bytes that exactly match a signed manifest hash). The property is preserved.

If any of steps 1–5 fail, the running state is unchanged. The property is preserved.

This is the inductive step. Whatever the property held at time `t`, it holds at time `t+1`.

---

## Therefore, the running state is the signed record

By induction over the install events since boot, the running state of a Safebox at any time `t` is:

```
state(t) = AMI bytes ⊕ ⋃ { artifact bytes : manifest signed before t }
```

There are no other sources of bytes that affect what code executes. Specifically:

- **There is no SSH access in production.** The Infrastructure README documents this explicitly. The privileged surface is the M-of-N-gated HTTP endpoints, not a shell.
- **The sudoers file is the complete privileged surface.** A dozen specific commands, all gated by signed-action-token verification. An auditor reads it in five minutes.
- **Runners cannot write to model directories.** They mount `/srv/safebox/models/<hash>/` read-only and have no write capability to the install paths.
- **The Safebox plugin's tool sandbox** (Q.Sandbox / isolated-vm) prevents tools from reaching the filesystem at all, except via the audited `Protocol.*` surface.

The base case + the inductive step + the absence of other state-modifying paths gives the property as a closed system: **what runs on this Safebox is what was signed.**

---

## What an auditor actually does

The procedure to verify a Safebox in production:

1. **Fetch the AWS Nitro attestation.** The system component exposes `/attestation/document`. The document is signed by an AWS-rooted certificate chain. Verify the signature, extract the measured AMI hash (PCR0).

2. **Reproduce the AMI build locally** using the signed manifest set the build pipeline records (committed to git, signed by M-of-N of the build-time auditors). Compare the locally-built AMI hash to the attested PCR0. Equal hashes mean the running AMI was built from the manifests the community signed.

3. **Fetch the list of post-boot install actions** from the Safebox stream record. Each is a `Safebox/action` with `actionType ∈ {models/install, packages/system/install, packages/node/install, packages/python/install}`, an attached manifest, and the OpenClaim signatures from the M-of-N approvers. Verify each signature against the corresponding auditor's public key. Verify each manifest's canonical hash matches the action's `Safebox/sha256` attribute.

4. **Compare the manifests to what's on disk.** For models: `/srv/safebox/models/` should contain subdirectories whose names are the manifest hashes of installed models. For RPMs: `rpm -qa | xargs rpm -q --queryformat '%{NAME}-%{VERSION}-%{RELEASE} %{SIGSHA256}\n'` should match. For npm: walk `/var/lib/safebox/node-runtime/*/node_modules/` and verify each package's tarball hash against its manifest. For pip: `pip freeze --hash` should match the signed manifests.

5. **Any discrepancy** between manifests and disk is the report. The system maintains the invariant; a discrepancy means either an integrity failure (which the install pipeline would have caught and aborted) or an exception path that bypassed the pipeline (which should not exist and whose existence is the audit finding).

This procedure does not require running tcpdump, snapshotting memory, inspecting kernel modules, or trusting the operator's word for anything. It requires reading and verifying signatures, hashing files, and comparing strings. An auditor can do it in a single working day for a typical Safebox deployment, and the result is mathematical rather than testimonial.

---

## What this replaces for compliance

The traditional answer to "what is running on this server" is sampling-based: an auditor reviews configuration management evidence, picks some servers to inspect, runs some scripts, reads some logs, and assembles a report that says "controls appear to be operating as designed during the sample window." It's the foundation of SOC 2 Type II, ISO 27001, PCI DSS, HIPAA controls testing, and the rest of the audit ecosystem.

The Safebox model replaces sampling with verification. There is no sample window; there is a continuous, cryptographically signed record of every change to the running state. There is no "appear to be operating as designed"; the design holds the property by construction or it does not. There is no "during the sample window"; the record covers every install action ever performed.

This does not eliminate auditors. It changes what auditors do. Instead of inspecting controls and inferring whether they worked, auditors verify signatures and inspect manifests and confirm the property holds. The skill set is closer to cryptographic protocol review than to GRC. The cost is proportional to the complexity of the manifest set, not to the size of the engineering organization or the volume of change events.

For regulators, the consequences are larger. A regulator asking "show me every change to your protected-data-handling code in the period in question" gets a cryptographically signed log of signed manifest installs, not a Jira export. The log is the same format across vendors because it is the same code path. The questions a regulator can answer with it are limited only by what they think to ask of a deterministic record.

---

## Failure modes and how they're caught

| Threat | Where the property could break | What catches it |
|---|---|---|
| AMI image substitution | An adversary boots a different AMI than the one signed | AWS Nitro attestation refuses; PCR0 mismatch |
| Hash collision in manifest signing | Two different artifacts have the same SHA-256 | SHA-256 is collision-resistant; not a practical concern |
| Signing key compromise of one auditor | Adversary signs a malicious manifest | M-of-N threshold; one compromised auditor is not enough |
| Signing key compromise of M auditors | Adversary signs anything they want | The audit trail is still complete; the compromise is visible after the fact, but the attack succeeds. This is the limit of the property — the community chooses M and N to make this hard, and uses distinct-jurisdiction signers so that no single subpoena reaches enough keys. |
| Mirror or HF account compromise serving a different file | Downloaded sha256 does not match the manifest | Install pipeline aborts; running state unchanged |
| Mirror compromise serving the manifest-correct file with embedded malicious behavior | The manifest hash matches because the file is what was signed | This is the same risk as signing a malicious manifest. The defense is auditor diligence at the M-of-N signing step — they are signing not only that the file exists at the hash, but that the file is what the manifest claims it does. |
| Bug in `opsArtifacts.js` validation logic | Hash check skipped or weakened | The validator is a small surface (≈600 lines), tested in [`testModelsCanonical.js`](../aws/scripts/components/system/test/testModelsCanonical.js) and [`testModelsLifecycle.js`](../aws/scripts/components/system/test/testModelsLifecycle.js), and changes to it themselves require M-of-N approval through the AMI rebuild pipeline. |
| Disk corruption silently flipping a bit | A file passes its hash check at install time, then disk corruption later changes a byte | Out of scope for the install-time property. Caught by periodic `opsArtifacts.handleVerify()` re-hashing, runnable on demand. |
| Privilege escalation inside a runner | Runner attempts to write to `/srv/safebox/models/` | Runners mount read-only; the write call fails. Privilege escalation that bypasses mount flags is a kernel-level attack and is out of scope for this property. |

The point is not that the property defends against every attack. It is that the failure modes are enumerable, named, and mostly addressed — and the remaining ones are exactly the failure modes that signed cryptographic records of the change history make visible after the fact. The traditional audit substitute for this — "we have a change management process" — does not make the same failures visible at all.

---

## The shape of the proof, restated for engineers

If the AMI is verified at boot, and every install is verified before bytes land, then the running state is the union of verified bytes. The property is preserved at every step. There is no other state-modifying path. Therefore the running state is exactly the signed record.

This is induction. Base case is `state(0) = AMI bytes`, verified by hardware attestation. Inductive step is `state(t+1) = state(t) ⊕ verified_artifact`, verified by the install pipeline. The conclusion is `∀t, state(t) = AMI ⊕ ⋃ verified_artifacts(<t)`.

Engineers reading this should be able to find every step of the proof in code. The base case is in `/etc/aws/nitro-attestation/` and the AMI build pipeline. The inductive step is in `aws/scripts/components/system/opsArtifacts.js` (the dispatcher) and `aws/scripts/components/system/opsModels.js` (the validator). The signatures are in the Safebox plugin's stream records under `Safebox/action` streams of the install action types. The disk state is at the mount points named in the table above.

If any of those pieces drifts from this document, the document is wrong and should be updated before the drift makes the property unverifiable. The whole point of writing this down is that the property is checkable in source.
