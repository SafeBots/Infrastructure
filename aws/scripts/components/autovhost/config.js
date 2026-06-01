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
    vhostConfDir: '/etc/nginx/conf.d/auto',
    // Where vhost certs/keys get written.
    vhostCertDir: '/etc/nginx/conf.d/auto-certs',
    // ACME state
    acmeAccountKeyPath: '/var/lib/safebox/autovhost/acme-account.key',
    acmeChallengesDir:  '/var/lib/safebox/autovhost/challenges',
    acmeStaging: false,  // set true in test environments
    acmeContactEmail: null,  // optional; LE encourages but doesn't require
    // What to do with traffic after the vhost is installed. By default,
    // proxy to the local app on 127.0.0.1:3000. Customer can override.
    proxyTarget: '127.0.0.1:3000',
    // nginx binary
    nginxBinary: '/usr/sbin/nginx',
    // Unix socket where nginx posts unknown-Host requests
    socketPath: '/run/safebox/autovhost.sock',
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
// On EC2 we get this from IMDS. We cache for 5 minutes since it shouldn't
// change often.
//
// Falls back to a static list from config if IMDS is unavailable, useful for
// non-EC2 deployments or testing.

let ourIpsCache = null;
let ourIpsExpiry = 0;
const OUR_IPS_TTL_MS = 5 * 60 * 1000;

function imdsGet(urlPath, token) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            method: 'GET',
            host: '169.254.169.254',
            path: urlPath,
            headers: token ? { 'X-aws-ec2-metadata-token': token } : {},
            timeout: 3000,
        }, (res) => {
            let buf = '';
            res.on('data', (c) => buf += c);
            res.on('end', () => {
                if (res.statusCode === 200) resolve(buf);
                else reject(new Error(`IMDS returned ${res.statusCode}`));
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('IMDS timeout')); });
        req.end();
    });
}

function imdsToken() {
    return new Promise((resolve, reject) => {
        const req = http.request({
            method: 'PUT',
            host: '169.254.169.254',
            path: '/latest/api/token',
            headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' },
            timeout: 3000,
        }, (res) => {
            let buf = '';
            res.on('data', (c) => buf += c);
            res.on('end', () => {
                if (res.statusCode === 200) resolve(buf);
                else reject(new Error(`IMDS token returned ${res.statusCode}`));
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('IMDS token timeout')); });
        req.end();
    });
}

async function discoverOurIpsFromImds() {
    const token = await imdsToken();
    const ip = (await imdsGet('/latest/meta-data/public-ipv4', token)).trim();
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
                ourIpsCache = new Set(await discoverOurIpsFromImds());
            } catch (e) {
                throw new Error(`could not determine our public IP (IMDS failed: ${e.message}); set ourIps in autovhost config`);
            }
        }
        ourIpsExpiry = now + OUR_IPS_TTL_MS;
        return ourIpsCache;
    };

    return merged;
}

module.exports = { load, DEFAULTS, CONFIG_PATH, _imdsToken: imdsToken, _imdsGet: imdsGet };
