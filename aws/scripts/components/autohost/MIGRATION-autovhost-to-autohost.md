# Migration: `autovhost` → vendored Autohost

This document records the convergence of Safebox's in-repo `autovhost` component
onto the public [Autohost](https://github.com/Safebots/Autohost) project, and
what an operator or reviewer needs to know about it.

## Why this happened

Safebox originally shipped its own on-demand vhost provisioner, `autovhost`,
living at `aws/scripts/components/autovhost/`. Separately, Autohost was published
as a generic open-source tool for the same job. Over time the two drifted into
two forks of one idea, each with features the other lacked:

- `autovhost` had a **registrable-domain (eTLD+1) issuance limiter** — the
  defense against wildcard-DNS ACME abuse — that Autohost didn't.
- Autohost had a **pluggable authorization hook**, **multi-engine** support
  (nginx *and* Apache), **multi-provider** certs (Let's Encrypt, Cloudflare
  Origin CA, CloudFront), a **renewal timer**, and **better IP discovery**
  (AWS IMDSv2 + Azure IMDS + GCP metadata + public echo services, versus
  autovhost's AWS-only IMDS) that `autovhost` didn't.

Maintaining two provisioners with near-identical names was a liability: a bug
fixed in one wouldn't reach the other, and the naming invited confusion about
which was which. The only thing keeping them separate was the one feature each
had that the other lacked.

## What changed

The single feature `autovhost` had that Autohost lacked — the registrable-domain
limiter — was **moved upstream into Autohost**, where it's generic and benefits
every Autohost user, not just Safebox. With that done, `autovhost` had nothing
Autohost couldn't do, so it was deleted and Safebox now consumes Autohost
directly.

Concretely:

1. **The registrable-domain limiter is now in Autohost's `src/rateLimit.js`** as
   a third sliding-window limit (`allowPerDomain`, keyed on eTLD+1) alongside the
   existing per-IP and global limits. All three are additive. It's controlled by
   `perDomainLimitPerHour` (default 10; set 0 to disable) and the env var
   `AUTOVHOST_PER_DOMAIN_LIMIT_PER_HOUR`. This shipped to the public Autohost
   repo along with 17 tests (`test/testRateLimitDomain.js`).

2. **Safebox consumes Autohost as a submodule** at `vendor/autohost/`, pinned by
   commit. The provisioner source is Autohost's, unmodified. Nothing is forked.

3. **The old `autovhost` component is replaced by a thin `autohost` component**
   at `aws/scripts/components/autohost/` that supplies only:
   - `autohost.safebox.json` — Safebox config mapping (see below)
   - `install-autohost.sh` — installs from the `vendor/autohost/` submodule
   - `units/safebox-autohost.service` — the systemd unit
   - `nginx-templates/` — the catch-all nginx config, splash pages, vhost template
   - `test/testAutohostSplash.js` — validates the Safebox splash HTML

4. **`aws/scripts/components/autovhost/` is deleted.**

## Config key mapping (`autovhost` → Autohost)

Safebox behavior is reproduced entirely through Autohost's existing config
surface — no code changes to Autohost were needed for the Safebox-specific
paths. `install-autohost.sh` installs `autohost.safebox.json` to
`/etc/safebox/autohost.json`, and the systemd unit points Autohost at it via
`AUTOVHOST_CONFIG=/etc/safebox/autohost.json`.

| autovhost config key   | Autohost config key   | Safebox value                              |
|------------------------|-----------------------|--------------------------------------------|
| `vhostConfDir`         | `vhostDir`            | `/etc/nginx/conf.d/auto`                   |
| `vhostCertDir`         | `certDir`            | `/etc/nginx/conf.d/auto-certs`             |
| `acmeChallengesDir`    | `acmeChallengesRoot`  | `/var/lib/safebox/autohost`                |
| `acmeAccountKeyPath`   | `acmeAccountKeyPath`  | `/var/lib/safebox/autohost/acme-account.key` |
| `socketPath`           | `socketPath`          | `/run/safebox/autohost.sock`               |
| `proxyTarget`          | `proxyTarget`         | `127.0.0.1:3000`                           |
| `vhostTemplatePath`    | `vhostTemplatePath`   | `/etc/safebox/autohost-vhost-template.conf` |

The rate-limit knobs (`perIpLimitPerHour`, `perDomainLimitPerHour`,
`globalLimitPerHour`) carry the same defaults as before.

IP discovery is **not** mapped — Autohost's built-in multi-cloud discovery is a
superset of what autovhost did (AWS-only), so Safebox simply uses Autohost's.

## Safebox-specific governance: the hook seam

`autovhost` had no authorization step — just a DNS check plus the limiter. That
same behavior is the default here (`authorizeHook: null`). When Safebox is ready
to enforce project/quota/token governance on which domains may be provisioned,
it sets `authorizeHook` in `autohost.safebox.json` to a module path, and Autohost
calls it after the DNS/rate-limit checks and before cert issuance. This is the
seam for the projects/domains/quota control plane, and it requires **no fork** —
the hook lives in the Safebox tree, Autohost stays pristine.

## The submodule + attestation model

Autohost is a git submodule, which is a pinned commit SHA — a content-address of
its tree. This fits Safebox's transitive-signing model: M-of-N approval of a
parent Safebox commit pins the Autohost commit by SHA, so "the Autohost we build
with" is exactly the approved tree or the build fails.

The submodule is resolved at **AMI build time** (`git submodule update --init`
runs before SSH is removed and the image is sealed), so the running box never
fetches code — it boots a signed image that already contains Autohost's resolved
bytes. For the attestation to cover Autohost, the build hashes the **resolved
filesystem** (which includes `vendor/autohost/`), not the git metadata. See the
"Updates & lifecycle" section of the main README for how post-boot updates
(npm/composer/git) each re-check M-of-N.

## What an operator runs (on the real Safebox repo)

These are git operations on the actual repository, done once:

```bash
# Add public Autohost as a pinned submodule
git submodule add https://github.com/Safebots/Autohost vendor/autohost
git -C vendor/autohost checkout <approved-commit-sha>
git add .gitmodules vendor/autohost

# Remove the old fork (already done in this prepped tree)
git rm -r aws/scripts/components/autovhost

git commit -m "Converge autovhost onto vendored Autohost submodule"
```

At AMI build time, before install and before SSH removal:

```bash
git submodule update --init vendor/autohost
```

`install-autohost.sh` verifies `vendor/autohost/src/autohost.js` is present and
fails with a clear message if the submodule wasn't resolved.

## What was preserved, what was dropped

Preserved: the nginx catch-all wiring (mirror directive → `/provision` over the
Unix socket, `{"host":"$host","requestIp":"$remote_addr"}` body — verified to
match Autohost's `provision()` signature), the Safebox splash pages, the
per-host vhost template, the bootstrap self-signed cert, the systemd hardening,
and the registrable-domain limiter (now upstream).

Dropped: the forked `autovhost.js`/`config.js` provisioner code (replaced by
Autohost's), and the redundant tests whose behavior Autohost's own suite already
covers (`testAutovhostHandler` → Autohost `testHandler`, `testAutovhostReload` →
`testReload`, `testAutovhostUnit` → `testUnit`). Only the Safebox-specific splash
test was ported (`testAutohostSplash.js`).
