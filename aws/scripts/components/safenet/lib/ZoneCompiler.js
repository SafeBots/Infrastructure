'use strict';

/**
 * @module ZoneCompiler
 *
 * Pure-function zone compiler: reads registry state (all box announces +
 * name claims) and outputs a standard DNS zone file. Every nameserver
 * computes the same zone from the same registry state.
 *
 * The zone is deterministic: given the same inputs, it always produces
 * identical output. SOA serial is derived from the registry root hash
 * (or an explicit height/timestamp) so every nameserver agrees.
 *
 * Usage:
 *   const zone = await ZoneCompiler.compile(registry, {
 *     origin: 'safenet.org.',
 *     nameservers: ['ns1.safenet.org.', 'ns2.safenet.org.'],
 *     ttl: 300,
 *     soaContact: 'hostmaster.safenet.org.',
 *     staticRecords: [
 *       { name: '@', type: 'MX', value: '10 mail.safenet.org.' },
 *       { name: '@', type: 'TXT', value: '"v=spf1 -all"' },
 *     ],
 *   });
 */

const { nowISO } = require('./utils');

const DEFAULT_TTL = 300;  // 5 minutes - short for fast failover
const DEFAULT_SOA_REFRESH = 300;
const DEFAULT_SOA_RETRY = 60;
const DEFAULT_SOA_EXPIRE = 604800;   // 1 week
const DEFAULT_SOA_MINIMUM = 60;

class ZoneCompiler {
  /**
   * Compile a DNS zone file from registry state.
   *
   * @param {Registry} registry - Registry instance with name claims and box announces
   * @param {object} options
   * @param {string}   options.origin       - Zone origin (e.g. "safenet.org.")
   * @param {string[]} options.nameservers  - NS record values (e.g. ["ns1.safenet.org."])
   * @param {number}  [options.ttl=300]     - Default TTL in seconds
   * @param {string}  [options.soaContact]  - SOA rname (e.g. "hostmaster.safenet.org.")
   * @param {string}  [options.soaPrimary]  - SOA mname (primary NS)
   * @param {number}  [options.soaRefresh]  - SOA refresh interval
   * @param {number}  [options.soaRetry]    - SOA retry interval
   * @param {number}  [options.soaExpire]   - SOA expire interval
   * @param {number}  [options.soaMinimum]  - SOA minimum (negative cache TTL)
   * @param {Array}   [options.staticRecords] - Extra records [{name, type, value}]
   * @param {string}  [options.serial]      - Explicit serial; if omitted, derived from rootHash
   * @returns {Promise<{zone: string, serial: string, recordCount: number, nameCount: number}>}
   */
  static async compile(registry, options = {}) {
    const {
      origin = 'safenet.org.',
      nameservers = [],
      ttl = DEFAULT_TTL,
      soaContact = 'hostmaster.' + origin,
      soaPrimary = nameservers[0] || 'ns1.' + origin,
      soaRefresh = DEFAULT_SOA_REFRESH,
      soaRetry = DEFAULT_SOA_RETRY,
      soaExpire = DEFAULT_SOA_EXPIRE,
      soaMinimum = DEFAULT_SOA_MINIMUM,
      staticRecords = [],
      serial: explicitSerial,
      attestationMaxAge = 600,  // 10 minutes: max age before failover kicks in
      caaIssuers = ['letsencrypt.org'],
    } = options;

    // 1. Get all name claims and box announces from registry
    const nameClaims = await registry.getAllNameClaims();
    const boxAnnounces = await registry.getAllBoxAnnounces();

    // 2. Derive SOA serial from registry root hash (deterministic)
    const serial = explicitSerial || ZoneCompiler._deriveSerial(registry.rootHash);

    // 3. Build zone lines
    const lines = [];

    // Header comment
    lines.push('; Zone file compiled from Safenet registry state');
    lines.push('; Serial: ' + serial);
    lines.push('; Generated: ' + nowISO());
    lines.push('; Name claims: ' + nameClaims.length);
    lines.push('; Active boxes: ' + boxAnnounces.size);
    lines.push('');

    // $ORIGIN and $TTL
    lines.push('$ORIGIN ' + origin);
    lines.push('$TTL ' + ttl);
    lines.push('');

    // SOA record
    lines.push(`@  IN  SOA  ${soaPrimary} ${soaContact} (`);
    lines.push(`    ${serial}   ; serial`);
    lines.push(`    ${soaRefresh}        ; refresh`);
    lines.push(`    ${soaRetry}         ; retry`);
    lines.push(`    ${soaExpire}    ; expire`);
    lines.push(`    ${soaMinimum}         ; minimum (negative cache TTL)`);
    lines.push(')');
    lines.push('');

    let recordCount = 1; // SOA

    // NS records
    for (const ns of nameservers) {
      lines.push(`@  IN  NS  ${ns}`);
      recordCount++;
    }
    if (nameservers.length > 0) lines.push('');

    // CAA records (restrict certificate issuance)
    for (const issuer of caaIssuers) {
      lines.push(`@  IN  CAA  0 issue "${issuer}"`);
      lines.push(`@  IN  CAA  0 issuewild "${issuer}"`);
      recordCount += 2;
    }
    lines.push(`@  IN  CAA  0 iodef "mailto:caa@${origin.replace(/\.$/, '')}"`);
    recordCount++;
    lines.push('');

    // Static records (MX, TXT, etc.)
    for (const rec of staticRecords) {
      const name = rec.name || '@';
      const type = (rec.type || 'A').toUpperCase();
      const recTtl = rec.ttl ? rec.ttl + '  ' : '';
      lines.push(`${name}  ${recTtl}IN  ${type}  ${rec.value}`);
      recordCount++;
    }
    if (staticRecords.length > 0) lines.push('');

    // Dynamic A records from name claims
    lines.push('; --- Dynamic records from name claims ---');
    lines.push('');

    // Sort name claims alphabetically for deterministic output
    const sortedClaims = [...nameClaims].sort((a, b) => {
      const nameA = a.name || a.claim?.stm?.name || '';
      const nameB = b.name || b.claim?.stm?.name || '';
      return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
    });

    let nameCount = 0;

    for (const entry of sortedClaims) {
      const name = entry.name || entry.claim?.stm?.name;
      const safeboxId = entry.safeboxId || entry.claim?.stm?.safeboxId;
      const failoverId = entry.failoverSafeboxId || entry.claim?.stm?.failoverSafeboxId;

      if (!name || !safeboxId) continue;

      // Look up the primary box's IP from announces
      const primaryBox = boxAnnounces.get(safeboxId);
      const failoverBox = failoverId ? boxAnnounces.get(failoverId) : null;

      // Derive the label relative to the zone origin
      const label = ZoneCompiler._labelFromName(name, origin);

      // Check attestation freshness for automatic failover
      const now = Math.floor(Date.now() / 1000);
      const primaryFresh = ZoneCompiler._isFresh(primaryBox, now, attestationMaxAge);
      const failoverFresh = ZoneCompiler._isFresh(failoverBox, now, attestationMaxAge);

      if (primaryFresh) {
        const ipType = primaryBox.publicIp.includes(':') ? 'AAAA' : 'A';
        lines.push(`${label}  IN  ${ipType}  ${primaryBox.publicIp}  ; ${safeboxId}`);
        recordCount++;
        nameCount++;
      } else if (failoverFresh) {
        // Primary stopped attesting — automatic failover
        const ipType = failoverBox.publicIp.includes(':') ? 'AAAA' : 'A';
        lines.push(`${label}  IN  ${ipType}  ${failoverBox.publicIp}  ; FAILOVER ${failoverId} (primary ${safeboxId} stale)`);
        recordCount++;
        nameCount++;
      } else if (primaryBox && primaryBox.publicIp) {
        // Both stale but primary has an IP — emit with warning
        // (operator may want stale records vs. no records)
        lines.push(`; WARNING: ${label} - primary ${safeboxId} attestation stale`);
        lines.push(`${label}  IN  A  ${primaryBox.publicIp}  ; ${safeboxId} (STALE)`);
        recordCount++;
        nameCount++;
      } else {
        // No box reachable at all
        lines.push(`; OFFLINE: ${label} - no attesting box (primary=${safeboxId}${failoverId ? ', failover=' + failoverId : ''})`);
      }
    }

    lines.push('');
    lines.push('; --- End of zone ---');

    return {
      zone: lines.join('\n') + '\n',
      serial,
      recordCount,
      nameCount,
    };
  }

  /**
   * Derive a SOA serial from the registry Merkle root hash.
   * Takes the first 10 hex characters and converts to a decimal
   * that fits in a 32-bit unsigned integer (max 4294967295).
   *
   * @param {string|null} rootHash
   * @returns {string} Serial number as string
   */
  static _deriveSerial(rootHash) {
    if (!rootHash) {
      // No registry state yet; use a timestamp-based serial
      const now = new Date();
      return String(
        now.getUTCFullYear() * 1000000 +
        (now.getUTCMonth() + 1) * 10000 +
        now.getUTCDate() * 100 +
        1
      );
    }
    // Take first 8 hex chars (32 bits) from the root hash
    const hex8 = rootHash.slice(0, 8);
    const num = parseInt(hex8, 16);
    return String(num);
  }

  /**
   * Check if a box announce is fresh (within attestationMaxAge seconds).
   *
   * @param {object|null} boxEntry - Box announce record
   * @param {number} now          - Current unix timestamp
   * @param {number} maxAge       - Maximum age in seconds
   * @returns {boolean}
   */
  static _isFresh(boxEntry, now, maxAge) {
    if (!boxEntry || !boxEntry.publicIp) return false;
    const attestedAt = boxEntry.attestedAt;
    let ts;
    if (typeof attestedAt === 'number') {
      ts = attestedAt;
    } else if (typeof attestedAt === 'string') {
      ts = Math.floor(Date.parse(attestedAt) / 1000);
    } else {
      // No attestation timestamp — treat as fresh (first announce)
      return true;
    }
    if (isNaN(ts)) return true; // Can't parse → assume fresh
    return (now - ts) <= maxAge;
  }

  /**
   * Derive a DNS label from a full domain name relative to the zone origin.
   * e.g. "myapp.safenet.org" with origin "safenet.org." -> "myapp"
   *      "deep.sub.safenet.org" with origin "safenet.org." -> "deep.sub"
   *      "other.example.com" with origin "safenet.org." -> "other.example.com."
   *
   * @param {string} name - Full domain name
   * @param {string} origin - Zone origin with trailing dot
   * @returns {string} DNS label
   */
  static _labelFromName(name, origin) {
    const cleanOrigin = origin.replace(/\.$/, '');
    if (name === cleanOrigin) return '@';
    if (name.endsWith('.' + cleanOrigin)) {
      return name.slice(0, -(cleanOrigin.length + 1));
    }
    // Name is outside the zone; use FQDN
    return name + '.';
  }
}

module.exports = ZoneCompiler;
