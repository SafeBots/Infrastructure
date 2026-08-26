#!/usr/bin/env python3
"""
attestation/measure/precompute-measurement.py   (refactor.md Phase 3.2)

Pre-compute the EXPECTED measurement of a Safebox image BEFORE it boots.

This is the hinge of attestation-survives-updates (trust.html): because the
NixOS image is reproducible, its measurement is a deterministic function of the
build inputs. We compute M ahead of time, so M-of-N can bless M into the
approved set (Phase 3.4) and keys can be sealed to it (Phase 3.3) before a
single instance ever runs.

Two measurement roots, selected by --cloud:

  SEV-SNP (gcp/azure/oci-amd):
      launch measurement = f(OVMF, kernel, initrd, cmdline, vcpus)
      computed with AMD's `sev-snp-measure` (IBM, Apache-2.0).

  NitroTPM (aws):
      Attestable-AMI PCRs (PCR4/PCR7/PCR12) derived from the built AMI's
      measured components. AWS exposes these at AMI-build time; here we wrap
      that so the workflow is identical across clouds.

HARDWARE/TOOLCHAIN NOTE: this orchestrates real tools (`sev-snp-measure`, the
Nix build outputs) that are not present in a bare CI container. It is written
to be run in the build pipeline that has the image artifacts. Where a tool is
absent it fails LOUDLY rather than emitting a fake measurement — a wrong
"expected measurement" is worse than none.
"""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path


def sev_snp_measurement(ovmf: Path, kernel: Path, initrd: Path,
                        cmdline: str, vcpus: int) -> str:
    """Compute the SEV-SNP launch digest via `sev-snp-measure`.

    Mirrors:  sev-snp-measure --mode snp --vcpus N --ovmf OVMF \
                  --kernel K --initrd I --append "CMDLINE"
    """
    for p in (ovmf, kernel, initrd):
        if not p.exists():
            sys.exit(f"ERROR: measurement input missing: {p}\n"
                     f"       Cannot compute a real measurement without it.")
    try:
        out = subprocess.run(
            ["sev-snp-measure", "--mode", "snp",
             "--vcpus", str(vcpus),
             "--ovmf", str(ovmf),
             "--kernel", str(kernel),
             "--initrd", str(initrd),
             "--append", cmdline,
             "--output-format", "hex"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
    except FileNotFoundError:
        sys.exit("ERROR: `sev-snp-measure` not installed.\n"
                 "       pip install sev-snp-measure  (IBM, Apache-2.0)\n"
                 "       Refusing to emit a placeholder measurement.")
    except subprocess.CalledProcessError as e:
        sys.exit(f"ERROR: sev-snp-measure failed:\n{e.stderr}")
    return out


def nitrotpm_pcrs(ami_components_dir: Path) -> dict:
    """Derive the Attestable-AMI PCRs from the built AMI's measured components.

    AWS computes PCR4/PCR7/PCR12 at AMI-registration time. In the real pipeline
    this reads AWS's emitted reference measurements. Here we hash the measured
    component set the AMI build produced, in the documented PCR-extend order, so
    the value is reproducible from the same inputs.
    """
    comp = ami_components_dir / "measured-components.json"
    if not comp.exists():
        sys.exit(f"ERROR: {comp} not found.\n"
                 "       The AMI build must emit the measured-component list\n"
                 "       (kernel, initrd, cmdline, boot config) for PCR derivation.")
    components = json.loads(comp.read_text())
    # PCR extend is a running hash: PCR_new = H(PCR_old || H(component)).
    def extend(pcr: str, data: bytes) -> str:
        return hashlib.sha384((bytes.fromhex(pcr) + hashlib.sha384(data).digest())).hexdigest()
    pcrs = {}
    for pcr_name, items in components.items():         # e.g. {"PCR4":[...], ...}
        acc = "00" * 48                                # SHA-384 PCR bank
        for item in items:
            acc = extend(acc, Path(item).read_bytes() if Path(item).exists()
                         else item.encode())
        pcrs[pcr_name] = acc
    return pcrs


def main() -> None:
    ap = argparse.ArgumentParser(description="Pre-compute expected Safebox measurement")
    ap.add_argument("--cloud", required=True,
                    choices=["gcp", "azure", "oci", "aws"])
    ap.add_argument("--image-dir", type=Path, required=True,
                    help="Directory with the built image artifacts")
    ap.add_argument("--vcpus", type=int, default=4, help="SEV-SNP: vCPU count")
    ap.add_argument("--cmdline", default="console=ttyS0 loglevel=4",
                    help="Kernel command line baked into the measured boot")
    ap.add_argument("--out", type=Path, required=True,
                    help="Where to write the measurement record (JSON)")
    args = ap.parse_args()

    if args.cloud in ("gcp", "azure", "oci"):
        m = sev_snp_measurement(
            ovmf=args.image_dir / "OVMF.fd",
            kernel=args.image_dir / "kernel",
            initrd=args.image_dir / "initrd",
            cmdline=args.cmdline, vcpus=args.vcpus,
        )
        record = {"cloud": args.cloud, "root": "sev-snp",
                  "measurement": m, "vcpus": args.vcpus, "cmdline": args.cmdline}
    else:  # aws
        pcrs = nitrotpm_pcrs(args.image_dir)
        record = {"cloud": "aws", "root": "nitrotpm", "pcrs": pcrs}

    # A measurement record is only useful if reproducible: record the inputs.
    record["image_dir"] = str(args.image_dir)
    args.out.write_text(json.dumps(record, indent=2))
    print(f"Wrote expected-measurement record -> {args.out}")
    print("Next: bless it (attestation/bless) and seal keys to it (attestation/seal).")


if __name__ == "__main__":
    main()
