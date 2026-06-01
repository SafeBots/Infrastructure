// /opt/safebox/dnsclient/config.js
//
// Loads dnsclient configuration from /etc/safebox/dnsclient.json, which is
// populated by cloud-init from the launch user-data field (see install
// script). The file looks like:
//
//   {
//     "safeboxId":    "sbx_abc123...",
//     "accountToken": "tok_xxxxxxxx...",
//     "dnsApiUrl":    "https://dns-api.safebots.org/v1/announce",
//     "allowUnattested": false
//   }
//
// safeboxId is provisioned by the control plane at launch time. accountToken
// is a per-Safebots-account secret that lets the DNS API associate this box
// with a paying account. dnsApiUrl is configurable so the same AMI works
// against staging and production endpoints. allowUnattested is for dev:
// when true, the dnsclient sends unsigned payloads (no NSM attestation);
// production deployments always have it false.

'use strict';

const fs = require('fs');

const CONFIG_PATH = process.env.SAFEBOX_DNSCLIENT_CONFIG
    || '/etc/safebox/dnsclient.json';

const SAFEBOX_ID_RE    = /^sbx_[a-zA-Z0-9_-]{8,64}$/;
const ACCOUNT_TOKEN_RE = /^tok_[a-zA-Z0-9_-]{16,128}$/;

function load() {
    let raw;
    try { raw = fs.readFileSync(CONFIG_PATH, 'utf8'); }
    catch (e) {
        throw new Error(`dnsclient config not readable at ${CONFIG_PATH}: ${e.message}`);
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) {
        throw new Error(`dnsclient config malformed JSON: ${e.message}`);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('dnsclient config must be a JSON object');
    }
    if (typeof parsed.safeboxId !== 'string' || !SAFEBOX_ID_RE.test(parsed.safeboxId)) {
        throw new Error('dnsclient config: safeboxId must match /^sbx_[a-zA-Z0-9_-]{8,64}$/');
    }
    if (typeof parsed.accountToken !== 'string' || !ACCOUNT_TOKEN_RE.test(parsed.accountToken)) {
        throw new Error('dnsclient config: accountToken must match /^tok_[a-zA-Z0-9_-]{16,128}$/');
    }
    if (typeof parsed.dnsApiUrl !== 'string' || !/^https:\/\/[^\s]+$/.test(parsed.dnsApiUrl)) {
        throw new Error('dnsclient config: dnsApiUrl must be a https URL');
    }
    try { new URL(parsed.dnsApiUrl); }
    catch (e) { throw new Error(`dnsclient config: dnsApiUrl not parseable: ${e.message}`); }

    return {
        safeboxId:       parsed.safeboxId,
        accountToken:    parsed.accountToken,
        dnsApiUrl:       parsed.dnsApiUrl,
        allowUnattested: parsed.allowUnattested === true,
    };
}

module.exports = { load, CONFIG_PATH, SAFEBOX_ID_RE, ACCOUNT_TOKEN_RE };
