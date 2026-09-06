# hosts/safebox.nix  —  MODEL A launch profile (the shipping product)
#
# This is the Model-A safebox: attested measured base, M-of-N-blessed image,
# apps+data beside it on ZFS, update by rebooting into a new blessed AMI.
# Model B (in-place trust-root updates via signed layers) is deliberately OFF —
# designed-in and dormant, not shipped. See nixos/README.md "Models A and B".
{ config, pkgs, lib, ... }:

{
  networking.hostName = "safebox";

  # Orchestrator/privileged process split — master secret goes to the
  # privileged process only; the orchestrator never holds credential plaintext.
  safebox.privilegedProcess.enable = true;
  # ZFS requires a unique 32-bit hostId; set a real per-host value at
  # provisioning time. Placeholder keeps the config evaluable.
  networking.hostId = lib.mkForce "5afeb0c5";
  time.timeZone = "UTC";

  # ZFS data device — the volume Terraform attaches for the safebox-pool.
  # AWS: /dev/sdf (also nvme1n1 on Nitro). GCP: /dev/disk/by-id/google-safebox-data.
  # Azure: /dev/disk/azure/scsi1/lun0. OCI: the attached paravirtualized volume.
  # Set to match the cloud this image is provisioned on.
  safebox.zfs.dataDevice = "/dev/sdf";

  # ---- Model A: measured boot ON (Phase 3.1) -----------------------------
  # The base is measured; its measurement is what M-of-N auditors bless.
  safebox.measuredBoot.enable = true;

  # ---- Model A: category-2 app guarantee ON ------------------------------
  # App containers are digest-pinned and verified against THIS blessed base's
  # allow-list before the app tier starts (fail-closed). Populate allowedDigests
  # with the pinned app-container digests at image-build time (F4 resolution).
  safebox.appVerify.enable = true;
  safebox.appVerify.allowedDigests = [
    # Fill from the digest-pinned compose file before publishing the AMI.
    # ALL app-tier images must be listed (app-verify fails closed otherwise):
    #   node-exec, llama-server-deepseek, ffmpeg, typesense, chromium,
    #   system-protocol-api, onnx-runtime, vllm
    # "sha256:....."   # node@...  (node-exec, system-protocol-api)
    # "sha256:....."   # ghcr.io/ggerganov/llama.cpp@...
    # "sha256:....."   # onnx-runtime@...
    # "sha256:....."   # vllm/vllm-openai@...   (gpu boxes only)
  ];

  # ---- Model-API auth: REQUIRED on the attested image --------------------
  # The model runners gate HMAC on SAFEBOX_REQUIRE_HMAC (off by default, which
  # is fine for local dev). A production, attested box must NOT be able to boot
  # with model auth silently disabled, so the shipping profile sets it on as a
  # system-wide default that the runner-launch path inherits. Off-by-default in
  # the runner code stays as-is; this profile makes the attested image opt in.
  environment.variables.SAFEBOX_REQUIRE_HMAC = "true";

  # ---- Model B: OFF for launch -------------------------------------------
  # In-place trust-root layering is the sovereignty upsell, not the base
  # product. Left disabled; its verifier slot is still reserved in the measured
  # base (layers.nix) so enabling B later does NOT change this image's M0.
  safebox.layers.enable = false;

  # Invariant guard: launch product must not ship Model B enabled by accident.
  assertions = [
    {
      assertion = !config.safebox.layers.enable;
      message = "Launch profile is Model A: safebox.layers (Model B) must stay disabled.";
    }
    {
      assertion = config.safebox.appVerify.enable;
      message = "Model A requires app-digest verification (safebox.appVerify) enabled.";
    }
    {
      assertion = (config.environment.variables.SAFEBOX_REQUIRE_HMAC or "") == "true";
      message = "Attested profile must require model-API HMAC (SAFEBOX_REQUIRE_HMAC=true); do not ship model auth silently disabled.";
    }
  ];
}
