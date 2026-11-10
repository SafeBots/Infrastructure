'use strict';
//
// lib/api.js — HTTP client for the Safebox System component.
//
// The System component listens on 127.0.0.1:7780 by default. Every request
// is POST with a JSON body that includes managedContainer: '_host'. Auth is
// HMAC-SHA256 over (timestamp + '.' + nonce + '.' + body).
//

const http = require('http');
const url = require('url');
const { signHmac, readHmacKey } = require('./util');

const DEFAULT_URL = 'http://127.0.0.1:7780';
const DEFAULT_KEY_PATH = '/etc/safebox/system.hmac';

class ApiClient {
    constructor(opts) {
        opts = opts || {};
        this.baseUrl  = opts.systemUrl || process.env.SAFEBOX_SYSTEM_URL || DEFAULT_URL;
        this.keyPath  = opts.hmacKeyPath || process.env.SAFEBOX_HMAC_KEY || DEFAULT_KEY_PATH;
        this.timeout  = opts.timeout || 600_000;
        this._key     = null;
    }

    _ensureKey() {
        if (this._key) return this._key;
        const k = readHmacKey(this.keyPath);
        if (!k) throw new Error(`HMAC key not found at ${this.keyPath}. `
                              + `Run with --hmac-key-path <path> or set SAFEBOX_HMAC_KEY.`);
        this._key = k;
        return k;
    }

    async _request(method, pathname, body) {
        const bodyStr = body ? JSON.stringify(body) : '';
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr).toString(),
        };
        // Sign whenever a body is present
        if (bodyStr) {
            Object.assign(headers, signHmac(bodyStr, this._ensureKey()));
        }
        const parsed = new url.URL(pathname, this.baseUrl);
        const opts = {
            method,
            hostname: parsed.hostname,
            port:     parsed.port,
            path:     parsed.pathname + parsed.search,
            headers,
            timeout:  this.timeout,
        };
        return new Promise((resolve, reject) => {
            const req = http.request(opts, res => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let data = null;
                    try { data = text ? JSON.parse(text) : null; }
                    catch { data = { rawText: text }; }
                    resolve({ status: res.statusCode, headers: res.headers, data });
                });
            });
            req.on('timeout', () => req.destroy(new Error(`Request timed out after ${this.timeout}ms`)));
            req.on('error',   reject);
            if (bodyStr) req.write(bodyStr);
            req.end();
        });
    }

    async install(manifest, manifestHash) {
        return this._request('POST', '/models/install', {
            managedContainer: '_host',
            manifestHash,
            manifest,
        });
    }

    async list() {
        return this._request('POST', '/models/list', { managedContainer: '_host' });
    }

    async verify(manifestHash) {
        return this._request('POST', `/models/${manifestHash}/verify`,
                              { managedContainer: '_host' });
    }

    async remove(manifestHash) {
        return this._request('POST', `/models/${manifestHash}/remove`,
                              { managedContainer: '_host' });
    }

    async ping() {
        // System component has /health on the same port (no HMAC required)
        const parsed = new url.URL('/health', this.baseUrl);
        return new Promise(resolve => {
            const req = http.request({
                method: 'GET',
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname,
                timeout: 2000,
            }, res => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body }));
            });
            req.on('error',   () => resolve({ ok: false, error: 'connection refused' }));
            req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
            req.end();
        });
    }
}

module.exports = { ApiClient, DEFAULT_URL, DEFAULT_KEY_PATH };
