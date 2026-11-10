// test/preload.js
//
// Resolves dnsclient.js's require('./attestationClient') to the fake in this
// directory. On an image the real file is installed beside dnsclient.js by
// install-system.sh; in the source tree it does not exist. Load this before
// requiring ../dnsclient in-process, or pass it as `node --require` when
// spawning dnsclient.js as a child.

'use strict';

const Module = require('module');
const path = require('path');

const DNSCLIENT = path.resolve(__dirname, '..', 'dnsclient.js');
const FAKE = path.join(__dirname, 'fakeAttestationClient.js');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === './attestationClient' && parent && parent.filename === DNSCLIENT) {
        return FAKE;
    }
    return origResolve.call(this, request, parent, isMain, options);
};
