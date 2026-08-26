# Generate, don't install: the no-custom-software posture

**Companion to `trust.html` (the why) and `PRE-AMI-RUNBOOK.md` (the how).**
This note states a security posture the architecture already implements; it is
not a new mechanism and requires no code change. It names the commitment so a
reviewer sees it stated plainly rather than inferring it.

## The claim

The deepest attack surface in any system is **arbitrary, human-written, per-box
custom software** — unbounded, unaudited, and unique to each deployment, so no
web-of-trust can form around it. A Safebox eliminates that category. Every piece
of code that runs is in exactly one of two buckets:

1. **Blessed-and-shared** — a small, pinned, identical-everywhere set that
   updates only through the M-of-N-audited inductive path.
2. **Generated-and-contained** — produced on the box under substrate governance,
   run inside the capability sandbox with empty egress, never able to modify the
   trust root.

Nothing is **hand-written-and-unique**. That is the whole posture.

The operative test is NOT "is it installed?" It is:
**"is it blessed-and-shared, or generated-and-contained?"** Anything that is
neither is not allowed to run.

## The three tiers, as they exist in the tree today

**Tier 1 — the measured base (blessed-and-shared).**
Ten pinned host packages: mariadb, php-fpm, nginx, docker, nodejs, npm, zfs,
iptables, auditd, fail2ban. Under NixOS these come from the pinned nixpkgs
closure (`services.nginx`, `services.mysql`, `services.phpfpm`, …), measured into
the boot PCRs. Finite, identical on every Safebox, audited once and amortized
across the whole network. Updated only by producing a new blessed measurement.

**Tier 2 — the container tier (blessed-and-shared, digest-pinned).**
ffmpeg, llama-server, typesense, chromium, the model runners — each a container
pinned by `sha256:` digest, run under the seccomp/AppArmor confinement in
`docker/security/`. **This is where ffmpeg lives** — and ffmpeg is the perfect
illustration of the rule, not an exception to it: it is not custom software and
not an ad-hoc install, it is the most-shared, most-audited media tool there is,
pulled by digest and governed as an "additional" service. Updated only through
the audited path (the trust-or-simulate harness + the auditor diff-audit).

**Tier 3 — generated-and-contained (no install at all).**
The workflows, tools, and custom logic a box needs are **generated on the box**
under governance (the "coding is workflows" substrate), not installed. This is
what makes "no custom software" survivable: the box can still do bespoke work —
it just *generates* that work under the substrate's rules instead of running
hand-written, unaudited code. Generated artifacts are contained by construction
(below).

## The two honest boundaries (state them, don't hide them)

This posture is strong only if two things are true, and both must be stated
plainly or a serious reviewer punctures the claim immediately.

**1. Containment of generated code is STRUCTURAL, not LLM-trust.**
"LLM-verified" is a useful filter but is NOT the guarantee. An LLM can be fooled,
prompt-injected, or simply wrong; a subtly malicious generated artifact that
passes LLM review is a real failure mode. So the safety of Tier-3 code does not
rest on "an LLM checked it." It rests on mechanisms that hold *even if the LLM is
wrong*:
- the **capability sandbox** — generated code can touch only what it is granted;
- **empty egress** — it cannot phone home regardless of what it does;
- the **trust-or-simulate harness** — run it against a mocked world, watch the
  four channels (network namespace, audit log, capability invocations, stream
  writes);
- the **measurement** — generated code cannot produce a blessed measurement, so
  it can never modify the trust root.
LLM verification narrows the input; structural containment is what makes a bad
generated artifact harmless. Frame it as "the LLM checks it" and it is soft;
frame it as "generated code is contained and the LLM is a pre-filter" and it is
strong.

**2. The blessed-update path is the crown jewel and gets the heaviest audit.**
If the only ways in are "blessed updates" and "generated-and-contained code,"
then compromising a blessed package (a poisoned php/node/Qbix/ffmpeg update) is
the highest-value attack — it is the one thing that runs *inside* the trust
boundary rather than in the sandbox. This is exactly what the trust-or-simulate
harness and the auditor diff-audit are built for, so the architecture already
points its heaviest machinery at its highest-value target. The consequence: the
auditor's competence on **package updates specifically** (the injected-vuln
benchmark, the contract diff, the M-of-N human escalation on incompatible
security-relevant changes) is load-bearing in a way it is not for generated code.
Generated code is *contained*; a blessed update is *trusted*. Put the audit rigor
proportional to that.

## Why port hygiene is necessary but not sufficient

The sealed image listens inbound on **80/443 only** by default. This is real
hygiene against external scanners and honest-but-buggy services — but it provides
**zero** protection against a compromised installed package, which reaches
*outbound* (reverse shell, DNS tunnel, a listener multiplexed over the existing
443) rather than opening a new inbound port. Inbound port policy never constrains
malicious installed code. That job belongs entirely to this posture: the only
code that runs is blessed-and-shared or generated-and-contained. Do not let a
"we only open 80/443" demo be mistaken for a backdoor defense — it isn't one.

Media/real-time deployments may additionally open 3478 + the TURN UDP relay range
**only if** they run a TURN server, and then only with authenticated,
time-limited credentials and denied internal-IP relaying (an open TURN relay is
an abusable proxy). Do **not** default-open 53 inbound: an exposed resolver is a
DDoS amplifier and DNS is a classic covert-exfil channel — the box's own name
resolution is outbound and needs no inbound listener.

## What this note changes

Nothing in the running system. Tiers 1–3 all exist today: the pinned base, the
digest-pinned + confined container tier, and the generate-under-governance
substrate. This note is the *stated commitment* to the posture and its two honest
boundaries, so the security claim is on the record in the form a reviewer can
check — not implied and not resting on "the AI checks everything."
