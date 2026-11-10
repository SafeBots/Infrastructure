// /opt/safebox/docker/stmValidators.js
//
// Input validators for values that get interpolated into `sh -c` command
// strings and argv in system-protocol-api.js. Extracted into a standalone
// module (no side effects, no server start) so they can be unit-tested
// directly and reused without pulling in dockerode / config loading.
//
// The caller of system-protocol-api is already UID- and HMAC-gated (only
// Safebox itself can reach the API), but a bug in Safebox's STM construction
// must not become container RCE. These validators reject shell metacharacters,
// path traversal, and anything outside a tight per-field allowlist.

'use strict';

const V = {
    // package name: npm scoped (@scope/name), pip (name[extras]), composer (vendor/pkg)
    packageName:  /^[@a-zA-Z0-9._/-]{1,214}$/,
    // version / semver range: digits, dots, and the common range operators
    version:      /^[a-zA-Z0-9._~^><=!*+-]{1,128}$/,
    // absolute POSIX path, no traversal, no shell metachars
    absPath:      /^\/[a-zA-Z0-9._/-]{0,254}$/,
    // git commit: 40-char (or 64 for sha256) lowercase hex
    commit:       /^[a-f0-9]{40}$|^[a-f0-9]{64}$/,
    // integrity: subresource-integrity string
    integrity:    /^sha(256|384|512)-[A-Za-z0-9+/=]{20,}$/,
    // git url: https or git@ ssh form. Charset deliberately EXCLUDES shell
    // metacharacters ($ ( ) ` ; & | < > space quotes) even though some are
    // technically valid in URLs — these URLs get interpolated into `git clone
    // ${url}` in a shell string, so a `$(id)` in the path would execute. Real
    // git remotes never need those characters.
    gitUrl:       /^(https:\/\/[a-zA-Z0-9._~:/?#@!*+,=%-]{1,512}|git@[a-zA-Z0-9._-]+:[a-zA-Z0-9._/-]{1,256})$/,
    // domain name for nginx configs
    domain:       /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
    // app / short identifier
    ident:        /^[a-zA-Z0-9._-]{1,128}$/,
    // ZFS dataset under the safebox pool: safebox-pool/<segments>
    zfsDataset:   /^safebox-pool\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/,
    // ZFS snapshot name (the part after @): 1-64 chars, no traversal
    zfsSnapName:  /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,63}$/,
};

// Throw unless `value` is a string, matches `re`, and contains no `..`.
// The `..` check is belt-and-suspenders on top of the regexes (several of
// which already exclude it) so no field can smuggle path traversal.
function must(value, re, label) {
    if (typeof value !== 'string' || !re.test(value) || value.includes('..')) {
        throw new Error(`invalid ${label}`);
    }
    return value;
}

// Verify that a git checkout landed on exactly the pinned commit. `rawOutput`
// is the stdout of a command that ends in `git rev-parse HEAD`; the actual HEAD
// is the last non-empty line. A pinned commit is only a real content-address if
// a mismatch is a HARD FAILURE — otherwise a tampered mirror or a moved ref
// could serve a different tree under the same pin and look like success. Returns
// { ok: true, head } on match; throws Error on mismatch. `label` names the op
// for the error message (e.g. 'git-clone').
function verifyCommit(rawOutput, pinnedCommit, label) {
    const head = String(rawOutput || '').trim().split('\n').filter(Boolean).pop() || '';
    if (head !== pinnedCommit) {
        throw new Error(
            `${label} commit mismatch: pinned ${pinnedCommit}, got ${head} ` +
            `(possible mirror tampering or moved ref)`);
    }
    return { ok: true, head };
}

module.exports = { V, must, verifyCommit };
