# Response: model-runner HMAC canonical form — FIXED

**To:** Safebox plugin
**From:** Infrastructure
**Re:** your change request on the v1.2 runner HMAC divergence

---

## Done — and you were right about the root cause

Confirmed against the tree: `auth.js` uses the strong canonical form
(`timestamp \n nonce \n method \n path \n sha256(body)-hex`), the runners had
drifted off it, and the runners were the odd one out. We fixed it the way you
recommended — **one shared module, not 11 inline copies** — because while
verifying we found the drift was actually worse than "one weak form":

- 9 runners: the dotted weak form you flagged (`ts.nonce.body`, no endpoint binding)
- `privacy-filter`: same weak form but single-quoted (`b'.'`) — a find/replace on
  the exact bytes would have missed it
- `onnx`: **materially weaker** — it signed the body *only* (`hmac(key, body)`),
  with no timestamp window, no nonce, no replay protection at all

A per-runner payload swap would have left onnx broken and inconsistent. So we
did the consolidation now.

## What changed

1. **One canonical verifier:** `model-runners/_shared/safebox_auth.py`. The
   canonical string is defined exactly once and matches `auth.js` and the
   Safebox `LocalRunner` byte-for-byte:
   `"<ts>\n<nonce>\n<method>\n<path>\n<sha256(body)-hex>"`.

2. **All 11 runners now delegate** to it — `verify_hmac(request, body)` call
   sites are unchanged; each runner's inline verifier is replaced by a one-line
   delegation plus a sibling import. onnx is brought fully up to the canonical
   verifier (it gains the timestamp window, nonce/replay protection, and
   endpoint binding it never had).

3. **Kept everything you said to keep:** the three `X-Safebox-*` headers, the
   300s window, verify-before-recording-the-nonce, timing-safe compare, and the
   half-eviction nonce cache. All of it moved into the shared module intact.

4. **Packaging:** each runner's Docker build context is its own directory, so
   the shared module is vendored into each runner dir by
   `model-runners/sync-shared.sh` (run it whenever the canonical module
   changes) and `COPY safebox_auth.py /app/` was added to every Dockerfile. All
   11 vendored copies are byte-identical to the canonical source (CI should
   assert this — see below).

## Your two confirmations

1. **nginx path rewriting — checked, no risk.** There is no nginx rewrite or
   proxy prefix-strip on the runner path in the tree. Runners are launched
   dynamically and called directly on their socket/port, so the FastAPI handler
   sees `request.url.path` exactly as the client signed it. If a future front
   proxy is added in front of a runner, this becomes live again — the shared
   module's docstring calls it out.

2. **`SAFEBOX_REQUIRE_HMAC=true` on the attested image — set.** Added to the
   attested Model-A profile (`nixos/hosts/safebox.nix`) as
   `environment.variables.SAFEBOX_REQUIRE_HMAC = "true"`, plus an **assertion**
   so the image fails to build if the attested profile ever ships with model
   auth silently disabled. Off-by-default stays in the runner code for local
   dev; the attested profile opts in.

   **One thing for us (Infra) to confirm on our side, flagged honestly:**
   `environment.variables` sets a system/login-shell default. Whether the
   runner-launch path inherits it depends on how the launching unit spawns
   `docker run` (it must pass the process environment through, or set
   `-e SAFEBOX_REQUIRE_HMAC` explicitly). The launch orchestration is the
   "whoever orchestrates docker runs" code referenced in `opsContainers.js`; we
   will confirm that path forwards the env (or add `-e` at the docker-run site)
   before the AMI is cut. The attested default + assertion is in place; the
   env-forwarding at the launch site is the remaining wire-up and it's ours.

## Parity test — matches your cross-repo test

`model-runners/_shared/test/test_hmac_parity.py` signs a request the
`auth.js`/`LocalRunner` way and asserts the shared verifier: accepts the strong
form, and rejects endpoint-swap (proves endpoint binding), nonce-replay,
old-weak-form, and expired-timestamp. All five pass. Point your cross-repo test
at `_shared/safebox_auth.py` as the single source of truth and the two repos are
checked against one canonical string.

## Recurrence prevention (matches your recommendation)

- Canonical form defined **once** in `_shared/safebox_auth.py`.
- `sync-shared.sh` vendors it into each runner; **CI should assert every
  `<runner>/safebox_auth.py` is byte-identical to `_shared/safebox_auth.py`**
  (one `sha256sum` compare) so a future edit can't silently desync one runner.
- The parity test fails loudly if the canonical string ever diverges from what
  a `LocalRunner`-signed request expects.

## Net

- **Runners now agree with `auth.js` and Safebox.** Endpoint binding and
  separate-body-hash restored; onnx's missing replay protection fixed.
- **No Safebox code change required.**
- **One remaining Infra wire-up:** confirm the runner-launch unit forwards
  `SAFEBOX_REQUIRE_HMAC` (or sets `-e`) before the AMI is cut.
