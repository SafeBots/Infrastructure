# Per-process network egress

## The gap this closes

`networking.firewall` (hardening.nix) is INBOUND-only: `allowedTCPPorts=[80 443]`
is an *inbound* allow-list, and there is no OUTPUT-chain rule anywhere. So the
"empty egress" that the generate-don't-install posture and the storage-mapping
gate both assume was, at the network layer, not enforced. This module enforces it
— and per-process, which is stronger than one box-wide allowlist.

## Mechanism

systemd `IPAddressDeny=any` + `IPAddressAllow=<list>` per service (kernel eBPF,
composes with the existing systemd sandbox). `safebox.egress.<svc>.allow` sets
the list; loopback is always allowed (unix-socket / localhost IPC is not egress);
omit `allow` for deny-all. Enforces WHO reaches WHERE, so a compromised web tier
can't reach an auditor IP as cover, and a runner reaches nothing.

## Default policy (egress-defaults.nix)

- **phpfpm-safebox (the Qbix PHP web tier — the weakest link): deny-all.** Its DB
  is a local unix socket and nginx reaches it over a unix socket, so it needs no
  outbound network. A compromised web tier physically cannot phone home.
- **model runners: deny-all.** No outbound business.
- **backup service: narrow allow** to the controlled backup peer / blessed
  storage-mapping host only.
- **weight-fetcher: via proxy.** CDN-backed, so it goes through a box-controlled
  forward proxy (hostname allowlisting at the proxy) and is allowed only the
  proxy IP — not a broad CDN range.

## Honest caveat

`IPAddressAllow` matches IP prefixes, not hostnames. Exact for our own infra
(auditors, backup peer — stable IPs). For CDN destinations (weights, cloud
buckets) the correct pattern is the forward proxy above; `viaProxy` documents
that seam. Don't allow whole cloud IP ranges as a shortcut — that reopens the
hole this module closes.

## nginx in front, and the Qbix webserver unix-socket question

Today the host nginx owns 80/443 and reaches php-fpm over a UNIX SOCKET already
(`fastcgi_pass unix:…`), so the nginx→PHP hop has no TCP egress surface. Good.

If we move app-serving to the **Qbix webserver** (pure-PHP, one process per app,
each in its own container jail), the analogous question is whether it should
LISTEN on a unix socket for the nginx→qbix hop instead of TCP. The upstream repo
shows it binds TCP today (`0.0.0.0:port`; the C binary and the U `Net.listen`
variant are both TCP), and it already uses unix socket *pairs* internally for
worker IPC — so the primitive is there, but front-facing unix-socket LISTEN is
not yet a feature.

**Recommendation: yes, add unix-socket listen support, because it makes egress
policy strictly tighter.** If nginx → qbix goes over a unix socket:
- the qbix container needs NO inbound TCP port and NO TCP loopback for serving,
  so its egress policy can be `IPAddressDeny=any` with an *empty* allow — the
  socket is a filesystem object mediated by mount/namespace, not the network
  stack, so it's outside the IP-egress question entirely;
- nginx reaches each app's qbix over `unix:/run/safebox/<app>.sock`, exactly like
  it reaches php-fpm now — one uniform, TCP-less internal fabric;
- it composes with the container jail: bind-mount only that app's socket in, and
  the app tier has zero network reachability, enforced two ways (no socket path +
  deny-any egress).

So the unix-socket work and the egress work reinforce each other: unix-socket
listen removes the internal TCP surface, and deny-any egress removes the external
one. Until qbix gains front-facing unix-socket listen, keep it on TCP bound to
127.0.0.1 with a deny-any egress policy (loopback-only), which is safe but leaves
an internal TCP surface the unix socket would eliminate.
