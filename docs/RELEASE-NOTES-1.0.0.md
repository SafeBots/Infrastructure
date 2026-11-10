# Safebots Infrastructure 1.0.0 Release Notes

This release replaces the first multi-cloud golden-image build with a measured, immutable image whose keys are sealed in hardware and whose only writable state lives on an encrypted pool. It follows two adversarial reviews. The first found that an attacker with ordinary cloud-account access could get root on a production safebox on every cloud; the second was run against the rewritten code and found five further issues, all fixed before this release. Both are described below so the record is complete.

## Headline changes

Every cloud (AWS, GCP, Azure, OCI) now builds Ubuntu 24.04 LTS from one base installer. The root filesystem is a read-only dm-verity volume whose hash is on the GRUB-measured kernel command line. The ZFS pool key and the HMAC seed are sealed in the TPM under PCRs 0, 2, 4, 7, 8, 9, 14, and 15 and unsealed only in the initramfs; PCR 15 is burned immediately afterwards so nothing later in the boot can unseal them again. cloud-init and every cloud agent are removed and pinned out; a first-boot unit reads two metadata values and executes nothing. Announcing requires a TPM quote and, by default, an SEV-SNP or TDX report proving the box runs with encrypted memory. There is no registration server; boxes publish signed OCP claims to the Safenet transparency log, verified independently by DNS relays and peers. Node.js is built against OpenSSL 3.5 so Safebox-to-Jet and Safebox-to-Safebox TLS negotiates hybrid post-quantum key exchange (X25519MLKEM768). nginx also uses OpenSSL 3.5 via LD_LIBRARY_PATH, so browser-facing TLS negotiates PQ groups with browsers that support them (Chrome does; others fall back to classical X25519).

## Attacks identified in the first review and how each is closed

**Offline disk edit and swap.** The root filesystem was writable, unmeasured, and held the HMAC master key. An attacker could snapshot the boot disk, mount it elsewhere, plant a systemd unit, and swap it back; attestation read only PCR 0 and 7, which do not change when the root changes, and the virtual TPM stays with the VM across a swap. Closed by the verity root, the measured command line (PCR 8) and kernel/initramfs (PCR 9), the sealed keys, and removing every secret from the root disk.

**Hostile user-data at launch.** cloud-init was installed and unrestricted, so anyone who could launch an instance from the image got root on first boot by passing a script. Closed by removing cloud-init and replacing it with a unit that only reads `safebox-id`, `owner-pubkey`, and `launch-authorization` from metadata, validates them, and writes a file.

**Build operator account shipped in the image.** The Azure and OCI images contained the build user with passwordless sudo. Closed by building in a chroot, never capturing the build instance, and a cleanup step that deletes users, locks every password, sets every shell to nologin, and refuses to capture otherwise.

**Serial or VNC console plus GRUB edit.** No GRUB password, so `init=/bin/bash` on the kernel line gave a root shell; Secure Boot does not prevent this. Closed by a PBKDF2 GRUB superuser, zero timeout, masked getty, rescue, and emergency units, `kernel.sysrq=0`, console settings off in Terraform where the cloud has one, and, as the real guarantee, the fact that any command-line edit changes PCR 8 so the keys stay sealed.

**Cloud agents and extensions.** Azure Run Command and VMAccess were blocked only by an unverified config edit; the OCI agent plugins were left enabled in Terraform; the GCP Terraform depended on the guest agent that the build removed. Closed by removing and pinning out every agent package, OCI `agent_config` with all plugins disabled, GCP metadata with OS Login and serial port off, and Azure deny policies for extensions, run commands, and boot diagnostics as a module option.

**Container to host root.** The service user was in the `docker` group, and sudoers allowed `docker run --detach *` and `dnf install -- *`. Closed by removing the group membership and replacing every sudo rule with ten root-owned wrapper scripts that take fixed arguments and validate each against a strict pattern; package installation from the API is gone, since packages change only by image rotation.

**Metadata service from containers.** Any container could read the account token from the metadata service. Closed by an nftables rule dropping container traffic to the metadata address, a host rule allowing it only for the two service users, OCI legacy endpoints disabled, and the launch authorization that the owner signs has a validity window (max 24 hours).

**Keys that did not protect anything.** The HMAC master was random bytes cached on the unencrypted root on AWS, Azure, and OCI, or an HKDF of public PCR values on GCP; the ZFS key was never sealed because the sealing script did not exist; the AWS client needed `/dev/nsm`, which exists only inside an enclave that was never launched. Closed by the sealed-seed design, NitroTPM on AWS, and attestation clients wired on every cloud.

**Unsigned ZFS modules under Secure Boot.** Found during implementation: ZFS built from source or via DKMS is unsigned and a Secure Boot kernel refuses it, so the pool would never load on Amazon Linux, Oracle Linux, or Debian. Closed by moving every cloud to Ubuntu, whose kernel packages ship signed ZFS modules.

## Attacks identified in the second review and how each is closed

**Initramfs root shell before the sealed phase closed.** If the unseal failed after the keys were out but before PCR 15 was burned (for example because the data disk had been detached), dracut dropped to a root shell on the serial console with the policy still satisfiable, so the attacker could re-run the unseal. Closed by `rd.shell=0 rd.emergency=reboot` on the measured command line, masking the emergency units inside the initramfs, and burning PCR 15 the moment both keys unseal and on every failure path.

**Tenant script executed on the host.** The `migrate` tool ran a tenant-authored `migrate.sh` on the host as the service user, which can read the HMAC seed and every tenant's data. Closed by running it inside the tenant's own container through the container wrapper.

**Cross-tenant test clones.** The test endpoint accepted any dataset name as the clone source. Closed by binding the source to the calling tenant and adding a per-tenant concurrent-test cap.

**Per-container key on tenant-writable storage.** The key was written inside the tenant workspace, where a symlink could redirect the write. Closed by moving keys to a root-controlled tmpfs directory, writing with `O_NOFOLLOW`, and bind-mounting read-only.

**Azure agent flags not settable.** A Specialized gallery image cannot carry `provisionVMAgent` or `allowExtensionOperations`, so the plan's claim was false for Azure. Closed by stating the real control (agent removed, deny policies) and offering the policies as a module option.

**Smaller items also closed:** image-family lookups rejected in Terraform (substitution risk); `docker.service` requires the firewall unit; fallback EFI binaries removed so PCR 4 is stable across boots; expected PCR 9 computed into the manifest; red-team scripts no longer pass when the tester merely lacks permission; the HMAC seed is delivered through systemd credentials instead of a readable file; dnsclient runs as its own user; the metadata override of the control-plane URL is removed; a host inbound firewall with default drop.

## Added in this release

- Registration requires an SEV-SNP or TDX report bound to the TPM quote (`allowUnencryptedMemory` defaults to false and must be set at build to run on non-confidential shapes).
- Post-quantum hybrid TLS for Node.js via OpenSSL 3.5; see `docs/PQ-TLS.md`.
- `docs/HARDENING-PLAN.md`, the normative specification.
- `common/image/verify-image.sh`, which fails the build on any hardening gap, and `tests/redteam/<cloud>.sh`, which attempts every vector above against a candidate image.
- Per-tenant system component isolation with dedicated uids and a `keyd` master-key service.
- Decentralized announce via Safenet transparency log; registration server and tokens removed.

## Per-tenant system component isolation

Each tenant now runs its own `safebox-system@<name>.service` instance as a dedicated uid (`safebox-sys-<name>`, allocated from uid 20000+). The operator-only unit (`safebox-system.service`, uid 990) retains control routes and container lifecycle management. A root-owned `keyd` service holds the HMAC master key (loaded via systemd credentials) and derives per-tenant keys on demand, writing them to `/run/safebox/keys/<name>/` on a tmpfs. Two new wrappers (`safebox-instance`, `safebox-keyd-reload`) manage tenant lifecycle from the operator unit. This closes the last shared-process risk: a compromised tenant service can no longer read another tenant's HMAC key or data.

## Decentralized announce via Safenet

The centralized registration server and single-use registration tokens are removed. Safeboxes now generate an Ed25519 identity at first boot and publish a signed `safebox_announce` OCP claim to the Safenet transparency log via gossip. The claim carries a TPM quote (with confidential-compute report bound), the box's public key, and a time-limited `launch_authorization` signed by the owner's key. DNS relays and peer safeboxes verify announces independently using `verifyAnnounce.js`, which checks: box signature, owner authorization validity and expiry, quote-nonce binding, AK signature over the quote, PCR values against the blessed-image set, confidential-compute evidence, and a first-seen rule per safebox-id. This removes the control plane as a single point of failure and trust anchor.

## Known limitations

Nothing in this release has booted on real hardware; every script passes static checks and the Node suites pass, but the boot chain, TPM sealing, verity, confidential-compute reports, and the four capture flows need a real build on each cloud. The expected PCR 8 value is modeled and must be confirmed from the first hardware boot. Two build-time digests (OpenSSL 3.5.5 and Node 22.22.2 tarballs) are fail-closed placeholders to be filled in. An attacker who wipes `/boot/safebox/` offline can force a fresh self-seal with blessed PCRs; the box cannot announce without a valid owner-signed launch authorization, and first boot now refuses if any pool already exists, but Safenet peers and DNS relays must also compare quotes against the blessed PCR set. OCI shapes with plain SEV (not SNP) produce no guest report and cannot register under the default policy. Safenet's `Discovery.js` needs a `safebox_announce` handler for gossip to land in the transparency log (out of scope for this repo).
