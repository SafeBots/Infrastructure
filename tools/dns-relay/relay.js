#!/usr/bin/env node
// tools/dns-relay/relay.js
//
// Reference relying party for safebox announces. No dependencies.
//
//   node relay.js --blessed blessed-images.json [--listen 127.0.0.1:8080]
//                 [--state ./relay-state.json] [--zone example.net] [--apply]
//                 [--owners owners.json] [--allow-unencrypted]
//
// Accepts POST /announce with a safebox_announce claim in the body, runs
// common/attestation/verifyAnnounce.js against the blessed-image set,
// applies the first-seen rule (the first boxPubkey seen under a safeboxId
// owns it; a later announce under the same id from another key is refused
// and logged), and prints the DNS record it would set:
//
//   <safeboxId>.<zone>.  60  IN  A  <publicIp>
//
// --owners is a JSON array of owner public keys (64 hex each); when given,
// announces whose launch authorization is signed by any other owner are
// refused. A relay that serves one organisation's zone wants this; a
// public relay may leave it off and let every verified box through.
//
// --apply is a stub: wire it to your DNS provider. GET /announces/<id>
// returns the accepted record for an id (404 before the first accepted
// announce), which is what tests/redteam/<cloud>.sh polls.
//
// blessed-images.json is either the output shape of buildBlessedImages
// ({ "<rootHash>": { "pcrs": {...}, "measurement"?: hex } }) or
// { "trustedKeys": [spki-b64...], "minSigners": 2, "blessings": [claims...] }
// to build the set from M-of-N image_blessing claims at start.

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const { verifyAnnounce, buildBlessedImages } = require(path.join(__dirname, '..', '..', 'common', 'attestation', 'verifyAnnounce.js'));

const args = process.argv.slice(2);
function opt(name, dflt) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; }
const BLESSED_PATH = opt('--blessed', 'blessed-images.json');
const LISTEN = opt('--listen', '127.0.0.1:8080');
const STATE_PATH = opt('--state', 'relay-state.json');
const ZONE = opt('--zone', 'safebox.example');
const APPLY = args.includes('--apply');
const ALLOW_UNENCRYPTED = args.includes('--allow-unencrypted');
const OWNERS_PATH = opt('--owners', null);
const OWNERS = OWNERS_PATH ? new Set(JSON.parse(fs.readFileSync(OWNERS_PATH, 'utf8'))) : null;

function log(obj) { process.stderr.write('[relay] ' + JSON.stringify(obj) + '\n'); }

function loadBlessed() {
    const raw = JSON.parse(fs.readFileSync(BLESSED_PATH, 'utf8'));
    if (Array.isArray(raw.blessings)) {
        const set = buildBlessedImages(raw.blessings, {
            trustedKeys: new Set(raw.trustedKeys || []), minSigners: raw.minSigners || 1,
        });
        for (const r of set._rejected) log({ event: 'blessing_rejected', reason: r.reason });
        return set;
    }
    return raw;
}

function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
    catch { return { boxes: {} }; }
}
function saveState(state) {
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
}

function applyRecord(record) {
    // Stub. Replace with a call to your DNS provider's API (Route 53
    // ChangeResourceRecordSets, Cloud DNS, your own zone file). The relay
    // prints the record either way so an operator can set it by hand.
    log({ event: 'apply_stub', record, note: 'wire --apply to a DNS provider' });
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let buf = '';
        req.on('data', (c) => { buf += c; if (buf.length > 1_000_000) { req.destroy(); reject(new Error('body too large')); } });
        req.on('end', () => resolve(buf));
        req.on('error', reject);
    });
}

function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

const blessed = loadBlessed();
const state = loadState();
log({ event: 'start', listen: LISTEN, blessedImages: Object.keys(blessed).length, knownBoxes: Object.keys(state.boxes).length,
      zone: ZONE, owners: OWNERS ? OWNERS.size : 'any' });

async function handleAnnounce(req, res) {
    let claim;
    try { claim = JSON.parse(await readBody(req)); }
    catch (e) { return json(res, 400, { ok: false, reasons: ['body is not JSON: ' + e.message] }); }

    const r = verifyAnnounce(claim, { blessedImages: blessed, allowUnencryptedMemory: ALLOW_UNENCRYPTED,
        fetchVcek: (c) => c.vcek || null });
    // Note on fetchVcek: a cached VCEK sent by the box is only trustworthy
    // once chained to the AMD root (ARK -> ASK -> VCEK). Replace this with a
    // KDS fetch plus chain check before relying on chainVerified.
    if (!r.ok) {
        log({ event: 'announce_rejected', safeboxId: r.safeboxId, boxPubkey: r.boxPubkey, reasons: r.reasons });
        return json(res, 403, { ok: false, reasons: r.reasons });
    }

    if (OWNERS && !OWNERS.has(r.ownerPubkey)) {
        log({ event: 'owner_unknown', safeboxId: r.safeboxId, ownerPubkey: r.ownerPubkey });
        return json(res, 403, { ok: false, reasons: ['launch authorization is signed by an owner this relay does not serve'] });
    }

    // First-seen rule: the safeboxId belongs to the first boxPubkey that
    // produced a valid launch announce for it. Anyone else is a second box
    // (or a replay with a new key) and is refused.
    const known = state.boxes[r.safeboxId];
    if (known && known.boxPubkey !== r.boxPubkey) {
        log({ event: 'second_box_for_id', safeboxId: r.safeboxId, firstSeen: known.boxPubkey, now: r.boxPubkey });
        return json(res, 409, { ok: false, reasons: ['safeboxId already bound to another box key (first-seen rule)'] });
    }
    if (!known && !r.launch) {
        log({ event: 'chained_announce_from_unknown_box', safeboxId: r.safeboxId, boxPubkey: r.boxPubkey });
        return json(res, 403, { ok: false, reasons: ['first announce from this box must be a launch announce (prev = null)'] });
    }
    if (known && r.prev !== known.lastAnnounceHash) {
        // A gap: the box announced somewhere we did not see. Accept it (the
        // chain is per box, and we verified this link), but say so.
        log({ event: 'chain_gap', safeboxId: r.safeboxId, expectedPrev: known.lastAnnounceHash, gotPrev: r.prev });
    }

    const record = { name: `${r.safeboxId}.${ZONE}.`, ttl: 60, type: 'A', value: r.publicIp };
    state.boxes[r.safeboxId] = {
        boxPubkey: r.boxPubkey, ownerPubkey: r.ownerPubkey, imageRootHash: r.imageRootHash,
        publicIp: r.publicIp, lastAnnounceHash: r.announceHash, lastIssuedAt: r.issuedAt,
        chainVerified: r.chainVerified, firstSeenAt: known ? known.firstSeenAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(), record,
    };
    saveState(state);
    process.stdout.write(`${record.name}\t${record.ttl}\tIN\t${record.type}\t${record.value}\n`);
    log({ event: 'announce_accepted', safeboxId: r.safeboxId, publicIp: r.publicIp, launch: r.launch, chainVerified: r.chainVerified });
    if (APPLY) applyRecord(record);
    return json(res, 200, { ok: true, record, chainVerified: r.chainVerified });
}

const [host, port] = LISTEN.split(':');
http.createServer(async (req, res) => {
    try {
        if (req.method === 'POST' && req.url === '/announce') return await handleAnnounce(req, res);
        const m = req.url.match(/^\/announces\/([a-z0-9-]{3,64})$/);
        if (req.method === 'GET' && m) {
            const b = state.boxes[m[1]];
            return b ? json(res, 200, Object.assign({ safeboxId: m[1] }, b)) : json(res, 404, { ok: false, reasons: ['no accepted announce for this id'] });
        }
        if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, { ok: true });
        json(res, 404, { ok: false, reasons: ['unknown route'] });
    } catch (e) {
        log({ event: 'handler_error', message: e.message });
        json(res, 500, { ok: false, reasons: [e.message] });
    }
}).listen(parseInt(port, 10), host);
