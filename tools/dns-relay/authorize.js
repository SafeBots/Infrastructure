#!/usr/bin/env node
// tools/dns-relay/authorize.js — owner-side helper: mint an owner key and
// sign a launch authorization for one safebox id.
//
//   node authorize.js keygen owner.key                 # writes PKCS8 PEM (0600), prints owner-pubkey
//   node authorize.js sign owner.key <safebox-id> [hours<=24]   # prints base64 launch-authorization
//
// The output is what Terraform's owner_pubkey / launch_authorization take.

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const ocp = require(path.join(__dirname, '..', '..', 'common', 'attestation', 'ocpClaim.js'));

const [cmd, keyPath, safeboxId, hoursArg] = process.argv.slice(2);
if (cmd === 'keygen' && keyPath) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    process.stdout.write(ocp.publicKeyHexFromKey(privateKey) + '\n');
} else if (cmd === 'sign' && keyPath && safeboxId) {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
    const hours = Math.min(24, Math.max(1 / 60, parseFloat(hoursArg || '1')));
    const now = Math.floor(Date.now() / 1000);
    const auth = ocp.signClaim(ocp.buildLaunchAuthorization({
        safeboxId, ownerPubkey: ocp.publicKeyHexFromKey(privateKey),
        notBefore: now - 300, expiresAt: now + Math.floor(hours * 3600),
    }), privateKey);
    process.stdout.write(ocp.encodeAuthorizationBase64(auth) + '\n');
} else {
    process.stderr.write('usage: authorize.js keygen <owner.key> | sign <owner.key> <safebox-id> [hours]\n');
    process.exit(2);
}
