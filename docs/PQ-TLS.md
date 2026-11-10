# Post-Quantum TLS for Safebox Container Images

## Purpose

Safecloud clients running inside Safeboxes hold encryption keys (rootKeys) for data stored across the Safecloud network. The chunk ciphertext is AES-256-GCM, which resists quantum attack — Grover's algorithm reduces effective key strength to 128 bits, still infeasible. But the TLS connections between Safeboxes and Jet servers use ECDHE key exchange (P-256 or X25519), which Shor's algorithm breaks. An adversary recording Safebox↔Jet traffic today could decrypt it once a cryptographically relevant quantum computer exists, recovering rootKeys and every chunk they protect.

Both ends of these connections are servers we control. No browser compatibility constraints apply. Upgrading to hybrid post-quantum TLS is a container image change — no Safecloud application code changes required.

## What needs to happen

Node.js in the Safebox base image must be linked against OpenSSL 3.5+, which includes ML-KEM (the NIST post-quantum key encapsulation standard, FIPS 203). The hybrid `X25519MLKEM768` key exchange group combines classical X25519 with ML-KEM-768 in a single TLS 1.3 handshake — security holds if either primitive survives.

Node's TLS API does not expose a way to select TLS 1.3 key exchange groups from JavaScript. The group negotiation happens inside OpenSSL at handshake time, driven by OpenSSL's configuration. This is why it must be done at the image level, not in Safecloud's application code.

## Building Node.js with OpenSSL 3.5

The Safebox image should build Node from source against a shared OpenSSL 3.5.5+ installation. This replaces the bundled OpenSSL that Node ships with by default (currently 3.0.x in Node 22 LTS).

### Step 1: Install OpenSSL 3.5

```dockerfile
ARG OPENSSL_VERSION=3.5.5

RUN apt-get update && apt-get install -y build-essential perl wget && \
    cd /tmp && \
    wget https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz && \
    tar xzf openssl-${OPENSSL_VERSION}.tar.gz && \
    cd openssl-${OPENSSL_VERSION} && \
    ./Configure --prefix=/usr/local/openssl-${OPENSSL_VERSION} \
                --libdir=lib \
                shared \
                linux-x86_64 \
                enable-ktls && \
    make -j$(nproc) && \
    make install_sw install_ssldirs && \
    rm -rf /tmp/openssl-*

ENV OPENSSL_DIR=/usr/local/openssl-${OPENSSL_VERSION}
ENV LD_LIBRARY_PATH=${OPENSSL_DIR}/lib:${LD_LIBRARY_PATH}
```

### Step 2: Build Node.js against it

```dockerfile
ARG NODE_VERSION=22.22.2

RUN cd /tmp && \
    wget https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}.tar.gz && \
    tar xzf node-v${NODE_VERSION}.tar.gz && \
    cd node-v${NODE_VERSION} && \
    ./configure --shared-openssl \
                --shared-openssl-includes=${OPENSSL_DIR}/include \
                --shared-openssl-libpath=${OPENSSL_DIR}/lib \
                --prefix=/usr/local && \
    make -j$(nproc) && \
    make install && \
    rm -rf /tmp/node-*
```

The `--shared-openssl` flag tells Node to link against the system OpenSSL rather than its bundled copy. Node still behaves identically for all other applications — `require('http')`, `require('crypto')`, `require('tls')` all work the same way. The only difference is that TLS now has access to post-quantum key exchange groups during negotiation.

### Step 3: Configure the preferred key exchange groups

Create `/etc/ssl/openssl-pq.cnf`:

```ini
# Post-quantum hybrid TLS key exchange configuration for Safebox
# Prefers X25519MLKEM768 (hybrid PQ), falls back to classical if peer doesn't support it

openssl_conf = openssl_init

[openssl_init]
ssl_conf = ssl_sect

[ssl_sect]
system_default = system_default_sect

[system_default_sect]
Groups = X25519MLKEM768:X25519:P-256
```

Set it in the container entrypoint or Dockerfile:

```dockerfile
COPY openssl-pq.cnf /etc/ssl/openssl-pq.cnf
ENV OPENSSL_CONF=/etc/ssl/openssl-pq.cnf
```

This configuration applies to every TLS connection made by any process in the container. The group list is a preference order — if the remote peer supports `X25519MLKEM768`, both sides use the hybrid PQ handshake. If not, they fall back to `X25519`, then `P-256`. Existing applications that don't know or care about PQ groups continue to work without changes.

## Verification

After building the image, verify the setup:

```bash
# Confirm OpenSSL version
node -e "console.log('OpenSSL:', process.versions.openssl)"
# Expected: 3.5.5 or higher

# Confirm ML-KEM is available
openssl list -kem-algorithms 2>&1 | grep -i mlkem
# Expected: mlkem768 (and possibly mlkem512, mlkem1024)

# Confirm the hybrid group is available
openssl ecparam -list_curves 2>&1 | grep -i mlkem || \
  openssl list -providers 2>&1
# The group won't show in ecparam — it's a TLS group, not an EC curve.
# Instead, test with a live handshake:

# Start a test server
openssl s_server -accept 4433 -cert /path/to/cert.pem -key /path/to/key.pem -groups X25519MLKEM768 &

# Connect and check
openssl s_client -connect localhost:4433 -groups X25519MLKEM768 2>&1 | grep "Server Temp Key"
# Expected: Server Temp Key: X25519MLKEM768 (or similar)

kill %1
```

To verify from a running Safebox against a live Jet:

```bash
openssl s_client -connect <jet-host>:<port> -groups X25519MLKEM768 2>&1 | grep "Server Temp Key"
```

If the Jet hasn't been upgraded yet, this will fall back to `X25519` — that's correct and expected. Upgrade Jets with the same OpenSSL 3.5 build to activate the hybrid handshake on both sides.

## What this changes and what it doesn't

**Changes:**
- TLS handshakes between Safeboxes and Jets (and between Safeboxes) use hybrid post-quantum key exchange when both sides support it
- Recorded traffic from after this upgrade cannot be decrypted by a future quantum computer

**Does not change:**
- Safecloud application code — no modifications to any `.js` file
- Socket.io protocol, Safecloud chunk format, Merkle trees, grants, or payment tokens
- Behavior of any other application running in the Safebox — Node.js is fully backward-compatible; the only difference is that TLS can now negotiate PQ groups
- Connections to peers that haven't upgraded — graceful fallback to classical key exchange

## Rollout order

1. **Jet server images first** (or simultaneously with Safeboxes). Both sides need OpenSSL 3.5+ for the hybrid handshake to activate. A single upgraded side just falls back to classical — no breakage, but no PQ protection either.
2. **Safebox images** with the same OpenSSL 3.5 build.
3. **Verify** with the `s_client` command above against a live Jet.

## Why this matters for Safecloud specifically

Safecloud is designed to store encrypted data for long periods — potentially decades. Model weights, enterprise datasets, and private media stored today must remain confidential against adversaries who may have quantum capabilities in 10–20 years. The chunk encryption (AES-256-GCM) already resists quantum attack. This change closes the remaining gap: the TLS key exchange that protects rootKey material in transit between Safeboxes and Jets.

Every day of Safebox↔Jet traffic recorded before this change is traffic that becomes decryptable once a cryptographically relevant quantum computer exists. The fix is a dependency upgrade and a config file — low risk, backward-compatible, and no application code to modify.
