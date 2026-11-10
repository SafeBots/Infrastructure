// /opt/safebox/autovhost/config.js
//
// Loads configuration for the autovhost service. Most paths are
// well-known defaults; the operator can override via /etc/safebox/autovhost.json
// if they want to point at custom directories (testing, hardened
// deployments, etc.).

'use strict';

const fs   = require('fs');
const http = require('http');

const CONFIG_PATH = process.env.SAFEBOX_AUTOVHOST_CONFIG
    || '/etc/safebox/autovhost.json';

const DEFAULTS = {
    // Where vhost server blocks get written. nginx must `include` this dir.
    // On the encrypted pool: /etc is a read-only overlay that resets every
    // boot (docs/HARDENING-PLAN.md fix 1).
    vhostConfDir: '/var/lib/safebox/nginx/vhosts',
    // Where vhost certs/keys get written.
    vhostCertDir: '/var/lib/safebox/nginx/certs',
    // ACME state
    acmeAccountKeyPath: '/var/lib/safebox/autovhost/acme-account.key',
    // HTTP-01 document root. Tokens are written to
    // <acmeChallengesDir>/.well-known/acme-challenge/<token> so that an
    // nginx `root <acmeChallengesDir>` serves the request URI directly.
    // It is on tmpfs under the unit's RuntimeDirectory (mode 0755) rather
    // than on the pool: tokens live for one validation, and nginx's workers
    // (www-data) must be able to traverse to them, which /var/lib/safebox
    // (0770 root:safebox-infra) deliberately does not allow.
    acmeChallengesDir:  '/run/safebox-autovhost/challenges',
    acmeStaging: false,  // set true in test environments
    acmeContactEmail: null,  // optional; LE encourages but doesn't require
    // What to do with traffic after the vhost is installed. By default,
    // proxy to the local app on 127.0.0.1:3000. Customer can override.
    proxyTarget: '127.0.0.1:3000',
    // How a vhost change reaches nginx. The default is the root wrapper
    // through sudo: `nginx -t` and `nginx -s reload` both need root on the
    // box (the pid file and the master process are root's, and -t opens
    // root-owned log and temp paths), and the sudoers file allows exactly
    // this path with no arguments (docs/HARDENING-PLAN.md fix 5). The
    // wrapper runs the test and, only if it passes, the reload. Set to
    // null to fall back to calling nginxBinary -t / -s reload directly
    // (only meaningful when autovhost itself runs as root, e.g. in a
    // development container).
    nginxReloadCommand: ['/usr/bin/sudo', '-n', '/opt/safebox/bin/safebox-nginx-reload'],
    // nginx binary, used only when nginxReloadCommand is null.
    nginxBinary: '/usr/sbin/nginx',
    // Unix socket where nginx posts unknown-Host requests. In the unit's
    // RuntimeDirectory (0755), not /run/safebox (0750 root:safebox-infra,
    // which nginx's www-data workers cannot traverse). The socket itself is
    // 0666: the only other principals on the box are root and the service
    // users, and containers never see /run.
    socketPath: '/run/safebox-autovhost/autovhost.sock',
    // Per-host vhost template path. If null or the file doesn't exist, the
    // built-in DEFAULT_VHOST_TEMPLATE in autovhost.js is used. Operators
    // edit this file (typically /etc/safebox/autovhost-vhost-template.conf)
    // to customize what generated per-host vhosts look like. Available
    // placeholders: {{hostname}}, {{certPath}}, {{keyPath}}, {{proxyTarget}},
    // {{acmeChallengesRoot}}. Restart autovhost after editing.
    vhostTemplatePath: '/etc/safebox/autovhost-vhost-template.conf',
};

// ── Public IP discovery ──────────────────────────────────────────────────────
//
// To check if DNS for a host points at us, we need to know our own public IPs.
// Read from the cloud metadata service; which cloud this is comes from the
// `cloud` field of /var/lib/safebox/instance.json, the token-free copy of
// the first-boot metadata that safebox-firstboot writes root 0644 beside
// the dnsclient state (dnsclient.json itself lives under
// /var/lib/safebox/dns, owned by safebox-dns, and carries the registration
// token, so this uid cannot and must not read it). Cached for 5 minutes
// since it shouldn't change often.
//
// Falls back to a static list from config (ourIps) if the metadata service
// is unavailable, useful for non-cloud deployments or testing.

let ourIpsCache = null;
let ourIpsExpiry = 0;
const OUR_IPS_TTL_MS = 5 * 60 * 1000;
const DNSCLIENT_CONFIG_PATH = process.env.SAFEBOX_DNSCLIENT_CONFIG || '/var/lib/safebox/instance.json';

function imdsCall(method, urlPath, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            method,
            host: '169.254.169.254',
            path: urlPath,
            headers: headers || {},
            timeout: 3000,
        }, (res) => {
            let buf = '';
            res.on('data', (c) => buf += c);
            res.on('end', () => {
                if (res.statusCode === 200) resolve(buf);
                else reject(new Error(`IMDS ${method} ${urlPath} returned ${res.statusCode}`));
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('IMDS timeout')); });
        req.end();
    });
}

function imdsGet(urlPath, token) {
    return imdsCall('GET', urlPath, token ? { 'X-aws-ec2-metadata-token': token } : {});
}

function imdsToken() {
    return imdsCall('PUT', '/latest/api/token', { 'X-aws-ec2-metadata-token-ttl-seconds': '60' });
}

const PUBLIC_IP_BY_CLOUD = {
    aws: async () => imdsGet('/latest/meta-data/public-ipv4', await imdsToken()),
    gcp: () => imdsCall('GET',
        '/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip',
        { 'Metadata-Flavor': 'Google' }),
    azure: () => imdsCall('GET',
        '/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text',
        { 'Metadata': 'true' }),
    oci: async () => {
        const vnics = JSON.parse(await imdsCall('GET', '/opc/v2/vnics/', { 'Authorization': 'Bearer Oracle' }));
        if (!Array.isArray(vnics) || !vnics[0] || typeof vnics[0].publicIp !== 'string') {
            throw new Error('OCI vnics[0].publicIp missing');
        }
        return vnics[0].publicIp;
    },
};

function detectCloud() {
    try {
        const parsed = JSON.parse(fs.readFileSync(DNSCLIENT_CONFIG_PATH, 'utf8'));
        if (parsed && typeof parsed.cloud === 'string' && PUBLIC_IP_BY_CLOUD[parsed.cloud]) return parsed.cloud;
    } catch { /* fall through */ }
    return null;
}

async function discoverOurIpsFromImds(cloudOverride) {
    const cloud = cloudOverride || detectCloud();
    if (!cloud) throw new Error(`cloud unknown (no 'cloud' in ${DNSCLIENT_CONFIG_PATH})`);
    const ip = (await PUBLIC_IP_BY_CLOUD[cloud]()).trim();
    if (!/^(\d{1,3})(\.\d{1,3}){3}$/.test(ip)) throw new Error(`metadata returned unexpected IP: ${ip.slice(0, 64)}`);
    return [ip];
}

function load() {
    let userOverrides = {};
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        userOverrides = JSON.parse(raw);
        if (typeof userOverrides !== 'object' || userOverrides === null || Array.isArray(userOverrides)) {
            throw new Error('autovhost config must be a JSON object');
        }
    } catch (e) {
        if (e.code !== 'ENOENT') {
            // If a config file is present but malformed, fail loudly. ENOENT is OK — use defaults.
            throw new Error(`autovhost config malformed: ${e.message}`);
        }
    }

    const merged = Object.assign({}, DEFAULTS, userOverrides);

    // discoverOurIps: prefer config-provided list, else IMDS, else cached.
    merged.discoverOurIps = async () => {
        const now = Date.now();
        if (ourIpsCache && ourIpsExpiry > now) return ourIpsCache;
        if (Array.isArray(userOverrides.ourIps) && userOverrides.ourIps.length > 0) {
            ourIpsCache = new Set(userOverrides.ourIps);
        } else {
            try {
                ourIpsCache = new Set(await discoverOurIpsFromImds(userOverrides.cloud));
            } catch (e) {
                throw new Error(`could not determine our public IP (metadata failed: ${e.message}); set ourIps in autovhost config`);
            }
        }
        ourIpsExpiry = now + OUR_IPS_TTL_MS;
        return ourIpsCache;
    };

    return merged;
}

module.exports = { load, DEFAULTS, CONFIG_PATH, _imdsToken: imdsToken, _imdsGet: imdsGet, _detectCloud: detectCloud, _discoverOurIpsFromImds: discoverOurIpsFromImds };
