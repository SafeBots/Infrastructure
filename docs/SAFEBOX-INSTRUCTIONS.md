# Safebox.Protocol.System Implementation Guide

**For Safebox plugin repository**

This guide shows how to implement the Safebox-side of Protocol.System to work with the infrastructure-side system-protocol-api.

## Architecture

**Infrastructure side (this package):**
- system-protocol-api - Unix socket server at `/run/safebox/system-api.sock`
- Peer UID verification, HMAC, allowlist, backoff, JTI tracking

**Safebox side (to implement):**
- `Safebox_System_Governance` (PHP) - M-of-N verification, verifiedOpToken generation
- `Protocol.System` (Node.js) - HTTP client to Unix socket, HMAC verification
- Node dispatcher - Receive from PHP, call Protocol, return result

## Implementation Checklist

See full implementation guide in Safebox chat for:
- [ ] `Safebox_System_Governance` class (PHP)
- [ ] `Protocol.System` function (Node.js in Protocol.js)
- [ ] Node dispatcher in Safebox.js
- [ ] Migration for `safebox_system_log` table
- [ ] Node-only handlers
- [ ] Admin CLI tool for offline signing

## Key Integration Points

### PHP → Node Handoff

```php
// After M-of-N verification in PHP
Q_Utils::sendToNode(array(
    'Q/method' => 'Safebox/system/dispatch',
    'verifiedOpToken' => $phpSignedToken,
    'action' => 'start',
    'container' => 'safebox-mariadb',
    'jti' => $jti
));
```

### Node → Infrastructure API

```javascript
// Protocol.System in Node
const response = await fetch('http://localhost/container/start', {
    socketPath: '/run/safebox/system-api.sock',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-Safebox-Signature': computeHMAC(body)
    },
    body: JSON.stringify({ jti, action, container, stm })
});
```

### Infrastructure → Node Response

```javascript
// Verify HMAC on response
const responseData = await response.json();
const responseSig = response.headers.get('X-Safebox-Signature');

if (!verifyHMAC(responseData, responseSig)) {
    throw new Error('Invalid response HMAC');
}
```

## Testing

```bash
# Start infrastructure API
sudo systemctl start safebox-system-api

# Test from Safebox Node process (as safebox UID)
sudo -u safebox node test-protocol.js

# Should succeed (correct UID + HMAC)
# Should log to /var/log/safebox-system-api.log
```

See Safebox chat for complete implementation.
