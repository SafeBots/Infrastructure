# Turn 3 runbook — verify attestation on real confidential hardware, per cloud

This is the execution guide for Turn 3 of Nix-turns.md: booting the sealed image
on real confidential-compute instances and proving each one attests correctly.
It CANNOT be done in CI or from a dev box — it requires (a) a built, locked image
from Turn 1, and (b) live confidential instances in each cloud. This file makes
that work mechanical: per cloud, the exact launch, fetch-quote, and compare steps,
mapped to the tooling already in this repo.

## What already exists in the repo (build on this, don't reinvent)

- `attestation/measure/precompute-measurement.py --cloud <c>` computes the EXPECTED
  measurement from the built image: SEV-SNP launch measurement (sev-snp-measure over
  OVMF/kernel/initrd/cmdline/vcpus) for GCP/Azure/OCI/IBM, or Attestable-AMI
  PCR4/PCR7/PCR12 (from the UKI) for AWS. It fails loudly if the tool is absent
  rather than emitting a fake — a wrong expected measurement is worse than none.
- `attestation/verify/verify-attestation.py` + `attestation/verify/hardware/` hold
  the per-cloud `verify_hardware_quote()` skeleton with the trust chains already
  named: aws (NitroTPM/NSM COSE_Sign1 -> Nitro root), gcp (vTPM quote + SEV-SNP ->
  VCEK -> AMD root), azure (vTPM + SEV-SNP/TDX -> MAA / AMD|Intel root), oci (SEV
  -> AMD root). Turn 3 FILLS IN and VALIDATES these against real quotes.
- `aws/scripts/components/dnsclient/nsmClient.js` + `cborDecode.js` already fetch and
  COSE-verify a NitroTPM attestation document on AWS today — the template for the
  other clouds' fetch step.

The gap Turn 3 closes is not "write a verifier from scratch" — it's "run the real
quote through the verifier on each cloud, fill the per-cloud hardware-root
validation, and confirm the live measurement equals the precomputed reference."

## The invariant being proven, on every cloud

1. Compute the reference measurement from the built image (offline, reproducible):
   `precompute-measurement.py --cloud <c> --image <sealed-image>`.
2. Launch a confidential instance from the sealed image.
3. Fetch the instance's hardware-signed attestation quote.
4. Verify the quote's signature chains to the cloud's/AMD's/Intel's hardware root
   (proves genuine confidential hardware, not an emulated vTPM).
5. Extract the attested measurement from the verified quote and confirm it EQUALS
   the reference from step 1.

Pass = steps 4 and 5 both hold. Only then is a secret released / the box trusted.

## Per-cloud steps

### AWS (do first — lowest risk, we already attest here)

- Launch: register the sealed AMI, launch on a NitroTPM-capable instance with UEFI
  + Secure Boot enabled (NitroTPM prerequisites). No preconfigured AMIs exist — ours
  must be self-configured, which the flake does.
- Reference: `precompute-measurement.py --cloud aws --image <sealed.ami>` →
  PCR4/PCR7/PCR12. Cross-check with AWS `nitro-tpm-pcr-compute --image UKI.efi`
  (their tool and ours must agree — a strong independent check).
- Fetch quote: the existing `nsmClient.js` path (`/dev/nsm`, COSE_Sign1), or EC2
  instance attestation (GA Sept 2025).
- Verify: COSE signature chains to the Nitro root; PCRs equal the reference.
- Done when: live PCRs == precomputed PCRs == AWS-tool PCRs.

### GCP

- Launch: `gcloud compute instances create ... --confidential-compute
  --shielded-secure-boot --shielded-vtpm --min-cpu-platform="AMD Milan"` from the
  registered GCE image.
- Reference: `precompute-measurement.py --cloud gcp` (SEV-SNP launch measurement).
- Fetch quote: go-tpm-tools requests the SEV-SNP report from the AMD Secure
  Processor; vTPM PCR quote signed by the AK linked to that report. Per-instance
  EKPub via `gcloud compute instances get-shielded-identity`.
- Verify: SEV-SNP report -> VCEK -> AMD root; vTPM AK linked to report; measurement
  matches reference.

### Azure

- Launch: a DCa*/ECa* confidential VM SKU from the registered managed image.
- Reference: `precompute-measurement.py --cloud azure`.
- Fetch quote: the confidential VM emits a SEV-SNP (or TDX) report at boot via the
  vTPM, embedding AKPub; use the Azure guest-attestation library / cvm-attestation-tools.
- Verify: via Microsoft Azure Attestation (MAA) OR verify the raw AMD/Intel report
  yourself (VCEK/PCK -> vendor root); measurement matches reference. For Safebox,
  running our OWN verifier is preferred over MAA.

### Oracle (OCI)

- Launch: an E5 or E6 shape (SEV-SNP) with confidential computing enabled. NOT
  E3/E4 (SEV-only, no SNP attestation).
- CAVEAT (known): OCI custom images do NOT support Secure Boot, so PCR7-style vTPM
  measured boot is unavailable. Rely on the SEV-SNP LAUNCH measurement (which
  attests the initial image directly, independent of vTPM Secure Boot) — this is
  why precompute uses the sev-snp-measure root for oci.
- Attestation: OCI supports Bring Your Own Attestation Service (BYAS) on E5/E6 —
  deploy OUR verifier, which fits the auditor model (the attestation service is ours).
- Verify: SEV-SNP report -> AMD root; launch measurement matches reference.

### IBM Cloud

- Launch: an AMD SEV-SNP confidential VM profile from the imported custom image.
- Reference: `precompute-measurement.py --cloud ibm` (SEV-SNP launch measurement;
  same root as gcp/azure/oci).
- Fetch quote: SEV-SNP report from the AMD Secure Processor via IBM's confidential
  tooling; validate the exact import + attestation flow on IBM's specific profiles.
- Verify: SEV-SNP report -> AMD root; measurement matches reference.

### Alibaba (last — region-gated)

- Launch: a confidential VM shape in a region where confidential compute is offered.
- CAVEAT (known): confidential availability is region-limited. Where unavailable,
  the reproducible image still runs — it just can't attest. Scope Alibaba as
  "runs everywhere, attests where the hardware/region allows."
- Verify where available: vTPM/SEV report -> AMD root; measurement matches reference.

## Done criteria for Turn 3

- AWS/GCP/Azure: live attestation validates AND measurement == reference, verified
  by our own verifier (`verify-attestation.py` per-cloud path filled and passing on
  a real quote).
- OCI/IBM: same, with OCI on E5/E6 + BYAS using the SEV-SNP launch-measurement root.
- Alibaba: validated in a confidential-capable region; scoped otherwise.
- The per-cloud `verify_hardware_quote()` in `attestation/verify/hardware/` is no
  longer a skeleton for the clouds tested — it validates real hardware roots.

## Honest status

Every step above is specified and mapped to real repo tooling, but NONE of it is
run yet, because it is gated on a Turn-1 image and live confidential instances.
This runbook is the plan of record; executing it produces the per-cloud attestation
evidence that turns "should attest" into "attests," cloud by cloud, AWS first.
