// /opt/safebox/dnsclient/config.js
//
// Loads dnsclient configuration from the encrypted pool. One file under
// /var/lib/safebox/dns (a 0750 safebox-dns:safebox-dns subdirectory of
// dataset safebox-pool/safebox, created by the initramfs unseal script on
// first boot; see docs/HARDENING-PLAN.md "Runtime paths"). dnsclient runs
// as safebox-dns (uid 992) and nothing else writes here except
// safebox-firstboot (root), which drops dnsclient.json owned by that uid.
//
//   dnsclient.json — written by safebox-firstboot.service from the cloud
//                    metadata service (first-boot step 4):
//     {
//       "safeboxId":           "<^[a-z0-9-]{3,64}$>",
//       "ownerPubkey":         "<64 lowercase hex: the owner's Safenet Ed25519 public key>",
//       "launchAuthorization": { ...signed launch_authorization OCP claim... },
//       "cloud":               "aws" | "gcp" | "azure" | "oci"
//     }
//
//   /etc/safebox/defaults.json — baked into the image by install-base.sh
//                    (read-only verity root, so it cannot be changed on a
//                    running box):
//     {
//       "dnsRelays":   ["https://dns.safebots.ai/api/v1", ...],  relying parties that get a copy of every announce
//       "safenetLogs": ["https://safenet.safebots.ai", ...],      Safenet peers whose transparency log receives it
//       "allowUnencryptedMemory": false   (true only for images built to run
//                                          on non-confidential shapes)
//     }
//
// There is no registration, no account credential and no metadata fallback:
// the box announces itself with a signed claim and every relying party
// verifies it independently. allowUnencryptedMemory is the one relaxation,
// and it is a build-time property of the image, not a runtime setting.

'use strict';

const fs = require('fs');
const path = require('path');
// Installed beside this file by install-dnsclient.sh; in the source tree it
// lives in common/attestation/.
const ocp = (() => {
    try { return require('./ocpClaim'); }
    catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; return require('../attestation/ocpClaim'); }
})();

const STATE_DIR    = process.env.SAFEBOX_DNSCLIENT_STATE_DIR || '/var/lib/safebox/dns';
const CONFIG_PATH  = process.env.SAFEBOX_DNSCLIENT_CONFIG  || path.join(STATE_DIR, 'dnsclient.json');
const DEFAULTS_PATH = process.env.SAFEBOX_DNSCLIENT_DEFAULTS || '/etc/safebox/defaults.json';

const SAFEBOX_ID_RE = ocp.SAFEBOX_ID_RE;
const PUBKEY_HEX_RE = ocp.PUBKEY_HEX_RE;
const CLOUDS = ['aws', 'gcp', 'azure', 'oci'];
const DEFAULT_DNS_RELAYS = ['https://dns.safebots.ai/api/v1'];

function readJsonObject(p, what) {
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); }
    catch (e) {
        const err = new Error(`${what} not readable at ${p}: ${e.message}`);
        err.code = e.code;
        throw err;
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { throw new Error(`${what} malformed JSON: ${e.message}`); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${what} must be a JSON object`);
    }
    return parsed;
}

function load() {
    const parsed = readJsonObject(CONFIG_PATH, 'dnsclient config');

    if (typeof parsed.safeboxId !== 'string' || !SAFEBOX_ID_RE.test(parsed.safeboxId)) {
        throw new Error('dnsclient config: safeboxId must match /^[a-z0-9-]{3,64}$/');
    }
    if (typeof parsed.ownerPubkey !== 'string' || !PUBKEY_HEX_RE.test(parsed.ownerPubkey)) {
        throw new Error('dnsclient config: ownerPubkey must be 64 lowercase hex characters');
    }
    if (typeof parsed.cloud !== 'string' || !CLOUDS.includes(parsed.cloud)) {
        throw new Error(`dnsclient config: cloud must be one of ${CLOUDS.join(', ')}`);
    }
    // The authorization may arrive as the claim object or as the base64 the
    // metadata carried; either way it must be a well-formed claim for this
    // box signed by ownerPubkey. The validity window is checked at announce
    // time against the clock, not here.
    let auth = parsed.launchAuthorization;
    if (typeof auth === 'string') auth = ocp.decodeAuthorizationBase64(auth);
    const check = ocp.checkLaunchAuthorization(auth, {
        safeboxId: parsed.safeboxId, ownerPubkey: parsed.ownerPubkey, now: null,
    });
    if (!check.ok) {
        throw new Error('dnsclient config: launchAuthorization invalid: ' + check.reasons.join('; '));
    }

    const defaults = loadDefaults();
    return {
        safeboxId:           parsed.safeboxId,
        ownerPubkey:         parsed.ownerPubkey,
        launchAuthorization: auth,
        cloud:               parsed.cloud,
        dnsRelays:           defaults.dnsRelays,
        safenetLogs:         defaults.safenetLogs,
        allowUnencryptedMemory: defaults.allowUnencryptedMemory,
    };
}

function httpsList(value, fallback) {
    if (!Array.isArray(value)) return fallback.slice();
    const out = [];
    for (const u of value) {
        if (typeof u !== 'string' || !/^https:\/\/[^\s]+$/.test(u)) continue;
        try { new URL(u); } catch { continue; }
        out.push(u.replace(/\/+$/, ''));
    }
    return out;
}

// Image-level defaults. allowUnencryptedMemory is falsy unless the image's
// defaults.json says exactly true: a missing or unreadable file, or any
// other value, means the box must present a memory-encryption report to
// announce. dnsRelays falls back to the built-in list when the key is
// missing; safenetLogs falls back to empty (no log configured).
function loadDefaults() {
    let parsed;
    try { parsed = readJsonObject(DEFAULTS_PATH, 'image defaults'); }
    catch { parsed = {}; }
    return {
        dnsRelays:   httpsList(parsed.dnsRelays, DEFAULT_DNS_RELAYS),
        safenetLogs: httpsList(parsed.safenetLogs, []),
        allowUnencryptedMemory: parsed.allowUnencryptedMemory === true,
    };
}

function loadAllowUnencryptedMemory() {
    return loadDefaults().allowUnencryptedMemory;
}

// Atomic write helper. mode is applied explicitly after the write so umask
// cannot widen it.
function writeJsonAtomic(p, obj, mode) {
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, p);
}

module.exports = {
    load, loadDefaults, loadAllowUnencryptedMemory, writeJsonAtomic,
    STATE_DIR, CONFIG_PATH, DEFAULTS_PATH,
    SAFEBOX_ID_RE, PUBKEY_HEX_RE, CLOUDS, DEFAULT_DNS_RELAYS,
};
