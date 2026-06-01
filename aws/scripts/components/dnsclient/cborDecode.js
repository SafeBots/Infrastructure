// /opt/safebox/system/cborDecode.js
//
// Minimal CBOR decoder. Supports only the subset RFC 8949 features that
// appear in AWS Nitro attestation documents:
//
//   - Unsigned integers (major type 0)
//   - Negative integers (major type 1)
//   - Byte strings (major type 2)
//   - Text strings (major type 3)
//   - Arrays (major type 4)
//   - Maps (major type 5)
//   - Simple values: false, true, null, undefined (major type 7, short)
//
// Not supported (and will throw): tags (major type 6), floats, indefinite
// lengths, big integers beyond Number.MAX_SAFE_INTEGER.
//
// Map keys can be integers or strings; the decoder produces a Map (not a
// plain object) so integer keys stay distinct from string keys. The PCR
// extraction code in nsmClient knows to look in the Map.
//
// Byte strings are returned as Node Buffer (NOT Uint8Array). This is
// deliberate — the rest of the codebase passes Buffers, and uniformity
// here removes branch points.

'use strict';

class CborError extends Error {
    constructor(msg, offset) {
        super(`CBOR decode error at offset ${offset}: ${msg}`);
        this.code = 'CBOR_DECODE_ERROR';
    }
}

function decode(buf, offsetRef) {
    if (!Buffer.isBuffer(buf)) throw new CborError('input must be Buffer', 0);
    const off = offsetRef || { pos: 0 };
    const result = readItem(buf, off);
    return { value: result, bytesConsumed: off.pos };
}

function readItem(buf, off) {
    if (off.pos >= buf.length) throw new CborError('unexpected end of input', off.pos);
    const ib = buf[off.pos++];
    const majorType = ib >> 5;
    const ai = ib & 0x1f;

    // For major types 0–5, ai is the argument or its length indicator
    let arg;
    if (majorType < 7) {
        if (ai < 24)        arg = ai;
        else if (ai === 24) arg = readU8(buf, off);
        else if (ai === 25) arg = readU16(buf, off);
        else if (ai === 26) arg = readU32(buf, off);
        else if (ai === 27) arg = readU64(buf, off);
        else throw new CborError(`unsupported additional info ${ai} for major type ${majorType}`, off.pos - 1);
    }

    switch (majorType) {
        case 0: return arg;
        case 1: return -1 - arg;
        case 2: {
            if (off.pos + arg > buf.length) throw new CborError('byte string truncated', off.pos);
            const out = Buffer.from(buf.subarray(off.pos, off.pos + arg));
            off.pos += arg;
            return out;
        }
        case 3: {
            if (off.pos + arg > buf.length) throw new CborError('text string truncated', off.pos);
            const out = buf.toString('utf8', off.pos, off.pos + arg);
            off.pos += arg;
            return out;
        }
        case 4: {
            const arr = new Array(arg);
            for (let i = 0; i < arg; i++) arr[i] = readItem(buf, off);
            return arr;
        }
        case 5: {
            const map = new Map();
            for (let i = 0; i < arg; i++) {
                const k = readItem(buf, off);
                const v = readItem(buf, off);
                map.set(k, v);
            }
            return map;
        }
        case 6:
            throw new CborError('CBOR tags not supported', off.pos - 1);
        case 7:
            if (ai === 20) return false;
            if (ai === 21) return true;
            if (ai === 22) return null;
            if (ai === 23) return undefined;
            throw new CborError(`unsupported simple value ${ai}`, off.pos - 1);
        default:
            throw new CborError(`unreachable major type ${majorType}`, off.pos - 1);
    }
}

function readU8(buf, off) {
    if (off.pos + 1 > buf.length) throw new CborError('truncated u8', off.pos);
    const v = buf.readUInt8(off.pos);
    off.pos += 1;
    return v;
}
function readU16(buf, off) {
    if (off.pos + 2 > buf.length) throw new CborError('truncated u16', off.pos);
    const v = buf.readUInt16BE(off.pos);
    off.pos += 2;
    return v;
}
function readU32(buf, off) {
    if (off.pos + 4 > buf.length) throw new CborError('truncated u32', off.pos);
    const v = buf.readUInt32BE(off.pos);
    off.pos += 4;
    return v;
}
function readU64(buf, off) {
    if (off.pos + 8 > buf.length) throw new CborError('truncated u64', off.pos);
    const hi = buf.readUInt32BE(off.pos);
    const lo = buf.readUInt32BE(off.pos + 4);
    off.pos += 8;
    // Combine. We only support values up to Number.MAX_SAFE_INTEGER (2^53 - 1).
    if (hi >= 0x200000) throw new CborError('u64 exceeds MAX_SAFE_INTEGER', off.pos - 8);
    return hi * 0x100000000 + lo;
}

// Minimal CBOR encoder — only what we need to reconstruct the Sig_structure
// for signature verification. Same subset (uint, byte string, text string,
// array).

function encodeUint(n) {
    if (n < 0 || !Number.isInteger(n) || n > Number.MAX_SAFE_INTEGER) {
        throw new Error('encodeUint: out of range');
    }
    return encodeTypeArg(0, n);
}
function encodeByteString(buf) {
    const head = encodeTypeArg(2, buf.length);
    return Buffer.concat([head, buf]);
}
function encodeTextString(str) {
    const b = Buffer.from(str, 'utf8');
    const head = encodeTypeArg(3, b.length);
    return Buffer.concat([head, b]);
}
function encodeArray(items) {
    const head = encodeTypeArg(4, items.length);
    return Buffer.concat([head, ...items]);
}

function encodeTypeArg(major, n) {
    const m = major << 5;
    if (n < 24)            return Buffer.from([m | n]);
    if (n < 0x100)         return Buffer.from([m | 24, n]);
    if (n < 0x10000)       { const b = Buffer.alloc(3); b[0] = m | 25; b.writeUInt16BE(n, 1); return b; }
    if (n < 0x100000000)   { const b = Buffer.alloc(5); b[0] = m | 26; b.writeUInt32BE(n, 1); return b; }
    const b = Buffer.alloc(9);
    b[0] = m | 27;
    b.writeUInt32BE(Math.floor(n / 0x100000000), 1);
    b.writeUInt32BE(n % 0x100000000, 5);
    return b;
}

module.exports = { decode, encodeUint, encodeByteString, encodeTextString, encodeArray, CborError };
