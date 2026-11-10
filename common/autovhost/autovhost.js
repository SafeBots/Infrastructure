// /opt/safebox/autovhost/autovhost.js
//
// Provisions nginx vhosts on demand. nginx (via njs or a small Lua snippet)
// forwards requests for unknown Host headers to this Unix socket. We:
//
//   1. Quick reject from negative cache (24h) — if we tried recently and failed
//   2. Cheap DNS sanity check: dns.resolve4(host) must include our public IP
//   3. ACME HTTP-01 via Let's Encrypt: get a real browser-trusted cert
//   4. Write the vhost config + cert/key files to /var/lib/safebox/nginx/vhosts/
//   5. Mutex-guarded nginx -s reload (debounced)
//   6. After reload, the next request for that Host gets served by nginx
//      directly using the new vhost.
//
// The cascade is gated so that scanner / spam traffic doesn't burn through
// Let's Encrypt rate limits. The vast majority of unknown-Host hits fail
// at step 2 (DNS doesn't point at us) for ~free per-request cost.
//
// What this component does NOT do:
//   - Serve customer traffic. nginx serves customer traffic once the vhost
//     is installed. We just provision the vhost.
//   - Handle origin-side TLS for CDN-fronted deployments (where Cloudflare
//     or CloudFront SaaS Manager handles browser TLS). That's a separate
//     deployment mode using a baked-in origin cert; see README.
//   - Renew certs. acme-client maintains its own account, but renewal is
//     handled by a separate periodic job (cron / systemd timer); we just
//     do initial provisioning.

'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const net   = require('net');
const dns   = require('dns').promises;
const crypto = require('crypto');
const { execFile } = require('child_process');
const acme   = require('acme-client');

const config = require('./config');

const audit = (entry) => {
    try { process.stderr.write('[autovhost] ' + JSON.stringify(entry) + '\n'); } catch {}
};

// ── State ────────────────────────────────────────────────────────────────────
//
// negativeCache: hostname -> { reason, expiryMs }
//   Hosts that recently failed validation. Avoids burning ACME quota and
//   avoids repeating expensive DNS lookups for the same bad host.
//
// inflight: hostname -> Promise<result>
//   Concurrent requests for the same host get joined to one in-flight
//   provisioning operation.
//
// installedHosts: Set<hostname>
//   Hosts we've already installed in this process lifetime. We don't need
//   to re-check or re-install — nginx is serving them.
//   (This is reset on autovhost restart; nginx still has the vhosts from
//   /var/lib/safebox/nginx/vhosts/, so customers don't notice.)

const negativeCache  = new Map();
const inflight       = new Map();
const installedHosts = new Set();

// Differentiated negative-cache TTLs:
//   - DNS-mismatch: short (5 min). The customer may be mid-propagation; we
//     want to retry soon. Caching for 24h would make new customers wait a
//     day even if they fix their DNS within a minute.
//   - ACME-failed: longer (1h). Retrying immediately just hits the same
//     upstream error and risks burning Let's Encrypt rate limits.
const DNS_MISMATCH_TTL_MS = 5 * 60 * 1000;
const ACME_FAIL_TTL_MS    = 60 * 60 * 1000;
// Legacy fallback for callers that don't specify a reason category.
const NEGATIVE_CACHE_TTL_MS = ACME_FAIL_TTL_MS;

const HOST_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const HOST_MAX_LEN = 253;

// Reload debouncing: we only call nginx -s reload at most once per
// RELOAD_DEBOUNCE_MS, even if several vhosts get installed in quick
// succession. The mutex ensures we never run two reloads concurrently.
const RELOAD_DEBOUNCE_MS = 2000;
let pendingReload = false;
let reloadInFlight = false;
let lastReloadAt = 0;

// ── Validation ───────────────────────────────────────────────────────────────

function isValidHostname(host) {
    if (typeof host !== 'string') return false;
    if (host.length === 0 || host.length > HOST_MAX_LEN) return false;
    return HOST_REGEX.test(host);
}

function negativeCacheCheck(host) {
    const entry = negativeCache.get(host);
    if (!entry) return null;
    if (entry.expiryMs <= Date.now()) {
        negativeCache.delete(host);
        return null;
    }
    return entry.reason;
}

function negativeCacheAdd(host, reason, ttlMs) {
    negativeCache.set(host, {
        reason,
        expiryMs: Date.now() + (ttlMs || NEGATIVE_CACHE_TTL_MS),
    });
}

// ── Step 1: DNS sanity check ─────────────────────────────────────────────────
//
// Resolve the requested hostname against the system resolver. If the A
// records don't include our public IP, the customer hasn't actually pointed
// their DNS at us yet — no point in trying ACME. Return false, negative-cache
// for 24h.

async function dnsPointsAtUs(host, ourIps) {
    let addrs;
    try {
        addrs = await dns.resolve4(host);
    } catch (e) {
        // NXDOMAIN, no A records, SERVFAIL, etc.
        return { ok: false, reason: `dns_resolve_failed:${e.code || e.message}` };
    }
    if (!Array.isArray(addrs) || addrs.length === 0) {
        return { ok: false, reason: 'dns_no_a_records' };
    }
    for (const ip of addrs) {
        if (ourIps.has(ip)) return { ok: true, matched: ip };
    }
    return { ok: false, reason: `dns_points_elsewhere:${addrs.join(',')}` };
}

// ── Step 2: ACME HTTP-01 ─────────────────────────────────────────────────────
//
// We keep one ACME account key for the lifetime of the box (in
// /var/lib/safebox/autovhost/account.key, written 0600 root). On first
// request after install, register the account; subsequent requests reuse it.
//
// HTTP-01 challenge files go to
// <acmeChallengesDir>/.well-known/acme-challenge/<token> (default root
// /run/safebox-autovhost/challenges). nginx is configured (see
// nginx-templates/safebox-autovhost.conf and the per-host template) with
// `root <acmeChallengesDir>` for /.well-known/acme-challenge/ on ALL Host
// values, so the request URI maps onto the file directly.
// So a fresh customer pointing their DNS at us, hitting /, triggers vhost
// provisioning; Let's Encrypt validates against the same nginx instance
// serving the challenge token from the shared challenges directory.

const cfg = config.load();
let acmeClientInstance = null;

// Where tokens go: the HTTP-01 document root plus the fixed ACME URI prefix,
// so nginx's `root` directive resolves /.well-known/acme-challenge/<token>.
function acmeTokenDir() {
    return path.join(cfg.acmeChallengesDir, '.well-known', 'acme-challenge');
}

async function getAcmeClient() {
    if (acmeClientInstance) return acmeClientInstance;
    const accountKey = await loadOrCreateAccountKey();
    const directoryUrl = cfg.acmeStaging
        ? acme.directory.letsencrypt.staging
        : acme.directory.letsencrypt.production;
    acmeClientInstance = new acme.Client({
        directoryUrl,
        accountKey,
    });
    // Register account on first use. acme-client handles "already registered"
    // gracefully on subsequent calls because the key is the same.
    await acmeClientInstance.createAccount({
        termsOfServiceAgreed: true,
        contact: cfg.acmeContactEmail ? [`mailto:${cfg.acmeContactEmail}`] : undefined,
    });
    audit({ event: 'acme_account_ready', staging: !!cfg.acmeStaging });
    return acmeClientInstance;
}

async function loadOrCreateAccountKey() {
    const keyPath = cfg.acmeAccountKeyPath;
    try {
        return fs.readFileSync(keyPath);
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }
    audit({ event: 'acme_account_key_generating' });
    const key = await acme.crypto.createPrivateKey();
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    return key;
}

// Provision a real cert for the host. Returns { cert, key } as PEM strings.
async function provisionCert(host) {
    const client = await getAcmeClient();
    const [key, csr] = await acme.crypto.createCsr({ commonName: host });

    const cert = await client.auto({
        csr,
        email: cfg.acmeContactEmail,
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
            // Write the challenge token to the shared challenges directory.
            // The static nginx ACME server block serves it from there for
            // /.well-known/acme-challenge/<token>.
            const tokenDir = acmeTokenDir();
            const tokenPath = path.join(tokenDir, challenge.token);
            await fs.promises.mkdir(tokenDir, { recursive: true, mode: 0o755 });
            await fs.promises.writeFile(tokenPath, keyAuthorization, { mode: 0o644 });
            audit({ event: 'acme_challenge_written', host, token: challenge.token.slice(0, 8) });
        },
        challengeRemoveFn: async (authz, challenge, keyAuthorization) => {
            const tokenPath = path.join(acmeTokenDir(), challenge.token);
            try { await fs.promises.unlink(tokenPath); } catch {}
        },
    });

    return { cert: cert.toString(), key: key.toString() };
}

// ── Step 3: vhost install + nginx reload ─────────────────────────────────────

// Built-in default template. Used when no operator template file is
// configured (cfg.vhostTemplatePath null) or the configured file is
// missing. Keeps Safebox usable out-of-the-box without requiring operators
// to manage an external file.
//
// Placeholders: {{hostname}}, {{certPath}}, {{keyPath}}, {{proxyTarget}},
// {{acmeChallengesRoot}}.
const DEFAULT_VHOST_TEMPLATE = `server {
    listen 443 ssl http2;
    server_name {{hostname}};

    ssl_certificate     {{certPath}};
    ssl_certificate_key {{keyPath}};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;

    # HSTS intentionally NOT set by default. See comment at top of
    # safebox-autovhost.conf catch-all. Operators add HSTS to their
    # custom vhost template after their fleet's TLS is stable.

    location /.well-known/acme-challenge/ {
        root {{acmeChallengesRoot}};
        default_type text/plain;
    }

    location / {
        proxy_pass         http://{{proxyTarget}};
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
}

server {
    listen 80;
    server_name {{hostname}};
    location /.well-known/acme-challenge/ {
        root {{acmeChallengesRoot}};
        default_type text/plain;
    }
    location / {
        return 301 https://$host$request_uri;
    }
}
`;

// Cached template string. Read once at startup, cleared by _reloadTemplate()
// for test/operational use.
let vhostTemplateCache = null;
function loadVhostTemplate() {
    if (vhostTemplateCache !== null) return vhostTemplateCache;
    if (cfg.vhostTemplatePath) {
        try {
            vhostTemplateCache = fs.readFileSync(cfg.vhostTemplatePath, 'utf8');
            return vhostTemplateCache;
        } catch (e) {
            if (e.code !== 'ENOENT') {
                audit({ event: 'vhost_template_read_failed',
                        path: cfg.vhostTemplatePath, message: e.message });
            }
        }
    }
    vhostTemplateCache = DEFAULT_VHOST_TEMPLATE;
    return vhostTemplateCache;
}

// Substitute {{placeholder}} tokens. Unknown placeholders left alone so
// nginx $variables pass through unaltered.
function substituteTemplate(template, values) {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        if (Object.prototype.hasOwnProperty.call(values, key)) {
            return values[key];
        }
        return match;
    });
}

function vhostConfigFor(host) {
    const certPath = path.join(cfg.vhostCertDir, `${host}.crt`);
    const keyPath  = path.join(cfg.vhostCertDir, `${host}.key`);
    // The catch-all serves ACME tokens from this root; per-host vhosts use
    // the same root so renewals work even when the per-host vhost is the
    // one nginx routes to. Tokens sit under <root>/.well-known/acme-challenge/.
    const acmeChallengesRoot = cfg.acmeChallengesDir;

    const header = `# Auto-provisioned by safebox-autovhost on ${new Date().toISOString()}\n` +
                   `# Customer hostname: ${host}\n`;
    const body = substituteTemplate(loadVhostTemplate(), {
        hostname:           host,
        certPath:           certPath,
        keyPath:            keyPath,
        proxyTarget:        cfg.proxyTarget,
        acmeChallengesRoot: acmeChallengesRoot,
    });
    return header + body;
}

async function installVhost(host, cert, key) {
    // Write cert + key to per-host files (mode 0640 root:nginx).
    await fs.promises.mkdir(cfg.vhostCertDir, { recursive: true, mode: 0o750 });
    const certPath = path.join(cfg.vhostCertDir, `${host}.crt`);
    const keyPath  = path.join(cfg.vhostCertDir, `${host}.key`);
    const certTmp  = certPath + '.tmp.' + process.pid;
    const keyTmp   = keyPath  + '.tmp.' + process.pid;

    await fs.promises.writeFile(certTmp, cert, { mode: 0o640 });
    await fs.promises.writeFile(keyTmp,  key,  { mode: 0o640 });
    await fs.promises.rename(certTmp, certPath);
    await fs.promises.rename(keyTmp,  keyPath);

    // Write the server block to /var/lib/safebox/nginx/vhosts/<host>.conf
    await fs.promises.mkdir(cfg.vhostConfDir, { recursive: true, mode: 0o755 });
    const confPath = path.join(cfg.vhostConfDir, `${host}.conf`);
    const confTmp  = confPath + '.tmp.' + process.pid;
    await fs.promises.writeFile(confTmp, vhostConfigFor(host), { mode: 0o644 });
    await fs.promises.rename(confTmp, confPath);

    audit({ event: 'vhost_installed', host });
    // Queue an nginx reload
    queueReload();
}

function queueReload() {
    if (reloadInFlight) {
        pendingReload = true;
        return;
    }
    const sinceLastMs = Date.now() - lastReloadAt;
    if (sinceLastMs < RELOAD_DEBOUNCE_MS) {
        // Schedule a reload for the end of the debounce window
        if (!pendingReload) {
            pendingReload = true;
            setTimeout(doReload, RELOAD_DEBOUNCE_MS - sinceLastMs);
        }
        return;
    }
    doReload();
}

function doReload() {
    if (reloadInFlight) { pendingReload = true; return; }
    reloadInFlight = true;
    pendingReload = false;
    lastReloadAt = Date.now();

    const finish = () => {
        reloadInFlight = false;
        // If a request arrived during this reload, run another one after debounce.
        if (pendingReload) {
            pendingReload = false;
            setTimeout(doReload, RELOAD_DEBOUNCE_MS);
        }
    };

    if (Array.isArray(cfg.nginxReloadCommand) && cfg.nginxReloadCommand.length > 0) {
        // Production path: one call to the root wrapper, which runs `nginx -t`
        // and then `nginx -s reload` itself and exits non-zero if either
        // fails. No arguments are passed: the sudoers entry allows the bare
        // path only.
        const [bin, ...args] = cfg.nginxReloadCommand;
        execFile(bin, args, { timeout: 20000, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C.UTF-8' } },
            (err, stdout, stderr) => {
                if (err) {
                    audit({ event: 'nginx_reload_failed', message: err.message,
                            stderr: (stderr || '').slice(0, 512) });
                } else {
                    audit({ event: 'nginx_reload_ok' });
                }
                finish();
            });
        return;
    }

    // Direct path (nginxReloadCommand null; only works as root).
    // Step 1: nginx -t pre-flight. If the new config is malformed (shouldn't
    // happen, but defense-in-depth), we want to log and skip rather than
    // run nginx -s reload which would silently keep the old config alive
    // and we'd lose the chance to notice.
    execFile(cfg.nginxBinary, ['-t'], { timeout: 10000 }, (tErr, tStdout, tStderr) => {
        if (tErr) {
            audit({ event: 'nginx_config_invalid',
                    stderr: (tStderr || '').slice(0, 512) });
            finish();
            return;
        }
        // Step 2: signal reload. SIGHUP to master is what -s reload sends.
        execFile(cfg.nginxBinary, ['-s', 'reload'], { timeout: 10000 }, (err, stdout, stderr) => {
            if (err) {
                audit({ event: 'nginx_reload_failed', message: err.message,
                        stderr: (stderr || '').slice(0, 256) });
            } else {
                audit({ event: 'nginx_reload_ok' });
            }
            finish();
        });
    });
}

// ── The main provisioning entry point ────────────────────────────────────────
//
// Called from the Unix socket HTTP handler when nginx forwards an unknown
// Host. Returns a result the handler can pass back to nginx (which uses it
// to decide whether to serve a "provisioning..." splash or 404).

async function tryProvision(host) {
    // ── Validation ───────────────────────────────────────────────────────────
    if (!isValidHostname(host)) {
        return { status: 'error', code: 'INVALID_HOST', message: 'bad hostname format' };
    }

    // ── Already installed (in this process lifetime) ─────────────────────────
    if (installedHosts.has(host)) {
        return { status: 'ok', code: 'ALREADY_INSTALLED' };
    }

    // ── Negative cache hit ───────────────────────────────────────────────────
    const negReason = negativeCacheCheck(host);
    if (negReason) {
        return { status: 'error', code: 'NEGATIVE_CACHE', message: negReason };
    }

    // ── Concurrent request for same host? Join the in-flight one ────────────
    const existing = inflight.get(host);
    if (existing) return existing;

    // Start a new provisioning attempt
    const promise = (async () => {
        try {
            // DNS check
            const ourIps = await cfg.discoverOurIps();
            const dnsResult = await dnsPointsAtUs(host, ourIps);
            if (!dnsResult.ok) {
                negativeCacheAdd(host, dnsResult.reason, DNS_MISMATCH_TTL_MS);
                audit({ event: 'provision_skipped_dns', host, reason: dnsResult.reason });
                return { status: 'error', code: 'DNS_MISMATCH', message: dnsResult.reason };
            }

            // ACME
            audit({ event: 'provision_starting_acme', host });
            const { cert, key } = await provisionCert(host);
            await installVhost(host, cert, key);
            installedHosts.add(host);
            audit({ event: 'provision_completed', host });
            return { status: 'ok', code: 'INSTALLED' };
        } catch (e) {
            const reason = `acme_failed:${(e.message || '').slice(0, 128)}`;
            negativeCacheAdd(host, reason, ACME_FAIL_TTL_MS);
            audit({ event: 'provision_failed', host, message: e.message,
                    stack: (e.stack || '').slice(0, 512) });
            return { status: 'error', code: 'ACME_FAILED', message: reason };
        } finally {
            inflight.delete(host);
        }
    })();
    inflight.set(host, promise);
    return promise;
}

// ── Unix socket HTTP server ──────────────────────────────────────────────────
//
// nginx posts to this socket with { host: "<unknown-host>" } when it sees
// a Host it doesn't have a server_name for. We respond with the result.
// nginx can then either:
//   - 200/INSTALLED: re-resolve and serve via the new vhost (or proxy the
//     waiting request directly through this Node process which would have
//     to know how to forward to the customer's app — simpler to just have
//     nginx retry once the config is reloaded)
//   - 200/ALREADY_INSTALLED: the same; nginx reloads and serves
//   - error: nginx returns 404 to the user or serves the default splash

function startServer() {
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/provision') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{"status":"error","code":"NOT_FOUND"}');
            return;
        }
        let body = '';
        req.on('data', (c) => {
            body += c;
            if (body.length > 4096) { res.writeHead(413); res.end(); req.destroy(); }
        });
        req.on('end', async () => {
            let parsed;
            try { parsed = JSON.parse(body); }
            catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end('{"status":"error","code":"BAD_REQUEST","message":"invalid JSON"}');
                return;
            }
            const result = await module.exports.tryProvision(parsed.host);
            res.writeHead(result.status === 'ok' ? 200 : 200,  // always 200 so nginx can read body
                { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        });
    });

    // Remove any stale socket file
    try { fs.unlinkSync(cfg.socketPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fs.mkdirSync(path.dirname(cfg.socketPath), { recursive: true, mode: 0o755 });
    server.listen(cfg.socketPath, () => {
        // nginx's workers run as www-data, which shares no group with
        // safebox-infra; the directory is the unit's 0755 RuntimeDirectory.
        try { fs.chmodSync(cfg.socketPath, 0o666); } catch {}
        audit({ event: 'autovhost_listening', socket: cfg.socketPath });
    });
    server.on('error', (e) => audit({ event: 'server_error', message: e.message }));
    return server;
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
    startServer();
}

module.exports = {
    // exposed for tests
    _isValidHostname:  isValidHostname,
    _dnsPointsAtUs:    dnsPointsAtUs,
    _negativeCacheAdd: negativeCacheAdd,
    _negativeCacheCheck: negativeCacheCheck,
    _vhostConfigFor:   vhostConfigFor,
    _queueReload:      queueReload,
    _resetReloadState: () => {
        pendingReload = false;
        reloadInFlight = false;
        lastReloadAt = 0;
    },
    _reloadTemplate:   () => { vhostTemplateCache = null; },
    _substituteTemplate: substituteTemplate,
    _DEFAULT_VHOST_TEMPLATE: DEFAULT_VHOST_TEMPLATE,
    tryProvision,
    startServer,
};
