# TLS Passthrough Mode

## Summary

In TLS passthrough mode, nginx routes encrypted TCP streams by SNI hostname directly to tenant containers without decrypting the traffic. The TLS private key lives inside the tenant's gVisor container, on the tenant's encrypted ZFS dataset, sealed to the TPM. nginx never holds the key and never sees plaintext.

This is an optional hardening mode. The default remains TLS termination in nginx (vhost-template.conf) for backward compatibility and because it supports HTTP-level features (rate limiting, header injection, request buffering, static file serving). Passthrough mode trades those features for a categorical security improvement: the internet-facing C code holds no secrets.

## Why

nginx is the only process on a Safebox that parses untrusted bytes from the raw internet. It is written in C. It has had remote code execution vulnerabilities before (CVE-2021-23017, CVE-2024-24989/24990) and will have them again.

In the default TLS termination mode, compromising nginx gives the attacker the TLS private key and a man-in-the-middle position on all decrypted traffic — they can read requests, forge responses, and impersonate the server for the lifetime of the cert.

In passthrough mode, compromising nginx gives the attacker a TCP relay position. They can drop or delay encrypted packets (denial of service). They cannot decrypt the traffic, read the requests, modify the responses, or forge the server's identity. The TLS key never touched nginx's address space.

The security improvement is categorical: the blast radius of the highest-risk component shrinks from full traffic compromise to denial of service.

## Architecture

```
Default (TLS termination):
  Internet → nginx (decrypts, inspects HTTP, proxies) → tenant container (plaintext HTTP)
  nginx holds: TLS private key, plaintext traffic

Passthrough:
  Internet → nginx (reads SNI, proxies raw TCP) → tenant container (decrypts, handles HTTP)
  nginx holds: nothing. Sees only encrypted bytes.
```

## How it works

1. nginx's `stream {}` block uses `ssl_preread` to read the SNI hostname from the TLS ClientHello without decrypting
2. The hostname is looked up in a map populated by autovhost at provisioning time
3. nginx proxies the raw TCP stream to the tenant container's internal IP:port
4. The tenant container (running the Qbix webserver or any TLS-capable server) terminates TLS with its own cert and key
5. The cert and key are on the tenant's ZFS dataset, encrypted with a TPM-sealed key, inside a gVisor sandbox

## Configuration

Set `SAFEBOX_TLS_MODE=passthrough` in the Safebox configuration before provisioning. This causes:

- `install-autovhost.sh` installs `safebox-stream-passthrough.conf` into nginx's `stream {}` context
- autovhost writes SNI map entries instead of per-host `http {}` server blocks
- autovhost still handles ACME HTTP-01 challenges on port 80 (plaintext, required by Let's Encrypt)
- autovhost writes the renewed cert and key to the tenant's ZFS dataset instead of nginx's cert directory
- The tenant container must listen on its TLS port and load the cert from its ZFS mount

## Tenant container requirements

In passthrough mode, the tenant container is responsible for:

- **TLS termination** — `tls.createServer()` in Node, or the Qbix webserver's TLS mode
- **Loading the cert and key** from the bind-mounted ZFS path (e.g. `/var/lib/safebox/certs/<hostname>/`)
- **Cert reload** — watching for renewed certs written by autovhost (inotify or periodic reload)
- **All HTTP-level concerns** — rate limiting, security headers, request buffering, static file serving

## What still works

- **ACME HTTP-01 challenges** — nginx still handles port 80 plaintext for Let's Encrypt validation. The ACME challenge server block is in the `http {}` context, separate from the `stream {}` passthrough. Cert renewal works as before.
- **Custom domain provisioning** — autovhost's cascade (DNS check → ACME → cert write → nginx reload) works the same way. The difference is that the cert is written to the tenant's ZFS dataset and the nginx reload updates the stream map, not an `http {}` vhost.
- **Multiple tenants per box** — SNI routing supports any number of hostnames, each mapped to a different tenant container.
- **The splash page** — unknown hostnames with no SNI map entry are dropped at the TCP level. The HTTP catch-all on port 80 still serves the splash page for first-time visitors.

## What doesn't work

- **sendfile** — nginx can't serve static files directly because it never sees the HTTP layer. The tenant app serves all files. Inside gVisor, sendfile goes through the Sentry anyway, so the zero-copy benefit was already reduced.
- **nginx-level rate limiting** — must be implemented in the tenant app or via a rate-limiting module inside the container.
- **nginx security headers** — X-Content-Type-Options, X-Frame-Options, etc. must be set by the tenant app.
- **nginx access logs at the HTTP layer** — nginx can log TCP connection metadata (source IP, bytes transferred, duration) but not HTTP paths or status codes.
- **HTTP/2 server push** — not applicable in stream passthrough.

## Performance

SNI passthrough is faster than TLS termination, not slower. nginx reads only the first ~200 bytes of the ClientHello to extract the hostname, then proxies raw TCP. No encrypt/decrypt, no HTTP parsing.

The TLS handshake cost moves to the tenant container's Node.js process, which is slightly slower than nginx's optimized OpenSSL path — approximately 1-2ms per new TLS connection. Negligible for real traffic. Established connections have zero additional overhead since nginx is just copying bytes.

## Files

| File | Purpose |
|------|---------|
| `common/autovhost/nginx-templates/safebox-stream-passthrough.conf` | nginx stream {} block with SNI routing and map include |
| `common/autovhost/nginx-templates/vhost-passthrough-template.conf` | Per-host HTTP server for ACME challenges + HTTPS redirect |
| `docs/TLS-PASSTHROUGH.md` | This document |

## Migration

To switch an existing Safebox from termination to passthrough:

1. Set `SAFEBOX_TLS_MODE=passthrough` in the Safebox config
2. Copy existing certs from nginx's cert directory to each tenant's ZFS dataset
3. Configure the tenant app to load certs and listen on TLS
4. Rebuild nginx config (autovhost regenerates on reload)
5. Restart nginx

The change is per-box, not per-tenant. All tenants on a passthrough box must handle their own TLS.
