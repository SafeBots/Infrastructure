# Layered blessing: platform base + org app layers

Two authorities, two layers, one invariant (nothing runs unless M-of-N blessed
something content-addressed — who the quorum is depends on who owns the layer).

## The chain

1. **Platform** M-of-N blesses the base closure (`bless-measurement.py`) and the
   standard app container (its digest goes in the platform base allow-list,
   shipped in the measured base).
2. **Org** M-of-N blesses that org's app layer (`bless-app-layer.py`) — its code
   + its `npm install`/`composer install`ed deps, frozen into a layer digest,
   built ON TOP of a platform-blessed standard container.

## What a blessing binds

`bless-app-layer.py` signs `(org, app, layer_digest, base_digest)` — binding the
org's layer AND the platform base it forks from. That binding is what makes the
additive-only guarantee enforceable at verify time.

## Verification (fail-closed, `verify-app-layer.py`)

Before an app layer runs, ALL of:
1. **Org-blessed** — ≥ M valid signatures from THAT ORG's trusted auditor keys.
2. **Derives from a blessed base** — the layer's `base_digest` is in the
   PLATFORM's blessed standard-container allow-list. An org cannot bless a layer
   onto a base the platform never blessed.
3. **Additive-only** — the layer's additions do not shadow base-owned paths
   (`/nix/store/`, `/usr/bin/node|php|nginx`, `/run/current-system`,
   `/etc/safebox/`), and no bind-mount targets a base path. An org may ADD a
   package (A@1.5); it may not REPLACE the platform's runtime below it.

All trusted-key sets and the platform allow-list are part of the measured base —
tampering changes M0 and fails attestation.

## Tested

`test-app-layer.sh` proves: an org-blessed layer on a blessed base that is
additive-only is accepted; a layer forking an unblessed base is refused; an
under-threshold set is refused; an untrusted org auditor does not count toward M;
and additive-only violations (shadowing `/usr/bin/node`, bind-mounting over
`/nix/store`) are refused.

## Relation to app-verify.nix

`app-verify.nix` enforces digest-pinning of running containers against the
platform allow-list (Model A). This layer adds the ORG-scoped blessing + the
chain/additive-only check on top: the full guarantee is "running container is
digest-pinned AND its layer is org-M-of-N-blessed AND derives from a
platform-blessed base AND is additive-only."
