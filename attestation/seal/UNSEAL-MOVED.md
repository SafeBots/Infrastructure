# `unseal-zfs-key.sh` moved

The boot-time unseal script now lives at:

    nixos/modules/scripts/unseal-zfs-key.sh

**Why:** it must be *inside the flake root* (`nixos/`) so `zfs.nix` can reference
it. Nix flakes copy only the flake directory into the store; a path escaping it
(`../../attestation/...`) fails evaluation in pure mode.

It is shipped into the measured base via `environment.etc` in
`nixos/modules/zfs.nix`, so the unseal logic itself is measured — it cannot be
swapped for a version that skips the M-of-N policy check without changing `M0`.

Its counterpart, `seal-key-to-policy.sh`, stays here: sealing is an operator
action run once, not part of the measured boot path.
