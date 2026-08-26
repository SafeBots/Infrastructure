# Governance Integration Guide

**For Safebox team: How to control Infrastructure dependencies via governance**

## Overview

Infrastructure's `system-protocol-api` can be controlled by Safebox governance through the `system-registry.json` file. This allows M-of-N admin approval for:
- Dependency versions (npm packages)
- Dependency integrity hashes
- Container configurations

## Architecture

```
Safebox Governance (M-of-N)
    ↓ Writes approved config
/etc/safebox/system-registry.json
    ↓ Read by infrastructure
system-protocol-api
    ↓ Verifies and enforces
Dependencies + Containers
```

## File Format: system-registry.json

**Location:** `/etc/safebox/system-registry.json`

**Structure:**

```json
{
  "dependencies": {
    "dockerode": {
      "version": "4.0.2",
      "integrity": "sha512-KqsaR7hFeLa0gytYWZSD8XcvLy5PjO+0gk7E2A7ELl2bqY+AvdBmFZ2DQlDGdm05FcG/Q4a9blTYwJL0s3ioTQ==",
      "source": "npm",
      "approvedBy": ["admin1", "admin2", "admin3"],
      "approvedAt": 1745880000,
      "reason": "Security patch for CVE-2024-12345"
    }
  },
  "containers": {
    "safebox-mariadb": {
      "imagePattern": "^mariadb:11\\.[0-9]+$",
      "allowedActions": ["start", "stop", "status", "restart"],
      "exponentialBackoff": true
    }
  }
}
```

## What Infrastructure Does

### On Startup

1. Reads `/etc/safebox/system-registry.json` (if exists)
2. For each dependency:
   - Checks installed version matches `dependencies.{pkg}.version`
   - If `integrity` specified, verifies package hash
   - Logs any mismatches
   - **EXITS with error** if integrity verification fails

3. Logs dependency verification status

### On SIGHUP

```bash
sudo kill -HUP $(pgrep -f system-protocol-api)
```

1. Reloads `system-registry.json`
2. Re-checks dependencies
3. Logs if updates needed

### Security

If integrity hash **doesn't match**:
- ✅ Logs error with full hashes
- ✅ **Exits immediately** (refuses to start)
- ✅ Operator must investigate (possible supply chain attack)

## What Safebox Should Implement

### 1. Dependency Update Action

**Handler:** `Safebox/handlers/Safebox/system/updateDependency/post.php`

```php
<?php

function Safebox_system_updateDependency_post()
{
    if (!Q_Request::isFromNode()) {
        throw new Q_Exception_Unauthorized("System handlers are Node-only");
    }
    
    $claim = $_REQUEST['claim'];
    
    // Extract dependency spec
    $stm = $claim['stm'];
    $package = $stm['package'];      // e.g. "dockerode"
    $version = $stm['version'];      // e.g. "4.0.3"
    $integrity = $stm['integrity'];  // e.g. "sha512-..."
    $reason = $stm['reason'];        // e.g. "Security patch"
    
    // Verify M-of-N signatures
    $verification = Safebox_System_Governance::verifySigners($claim);
    
    if (!$verification['valid']) {
        throw new Exception("Insufficient signatures");
    }
    
    // Load current registry
    $registryPath = '/etc/safebox/system-registry.json';
    $registry = json_decode(file_get_contents($registryPath), true);
    
    // Update dependency
    $registry['dependencies'][$package] = [
        'version' => $version,
        'integrity' => $integrity,
        'source' => 'npm',
        'approvedBy' => $verification['signers'],
        'approvedAt' => time(),
        'reason' => $reason
    ];
    
    // Write atomically
    $tmpPath = $registryPath . '.tmp';
    file_put_contents($tmpPath, json_encode($registry, JSON_PRETTY_PRINT));
    rename($tmpPath, $registryPath);
    
    // Trigger infrastructure reload
    exec('sudo kill -HUP $(pgrep -f system-protocol-api)');
    
    // Log to audit
    Safebox_System_Log::record([
        'action' => 'updateDependency',
        'package' => $package,
        'version' => $version,
        'signers' => $verification['signers']
    ]);
    
    Q_Response::setSlot('result', [
        'success' => true,
        'package' => $package,
        'version' => $version
    ]);
}
```

### 2. Generate Integrity Hash

**Helper function:**

```php
<?php

class Safebox_System_Dependencies
{
    /**
     * Compute integrity hash for an npm package
     * 
     * @param string $package Package name
     * @param string $version Version
     * @return string SHA-512 hash in format: sha512-{base64}
     */
    static function computeIntegrity($package, $version)
    {
        // Download package.json from npm registry
        $url = "https://registry.npmjs.org/{$package}/{$version}";
        $packageInfo = json_decode(file_get_contents($url), true);
        
        // Get tarball URL
        $tarballUrl = $packageInfo['dist']['tarball'];
        
        // Download tarball
        $tarball = file_get_contents($tarballUrl);
        
        // Compute SHA-512
        $hash = base64_encode(hash('sha512', $tarball, true));
        
        return "sha512-{$hash}";
    }
}
```

### 3. Admin CLI Tool

**Script:** `scripts/safebox-admin.php`

```php
<?php

// Propose dependency update
$package = $argv[1];  // e.g. "dockerode"
$version = $argv[2];  // e.g. "4.0.3"
$reason = $argv[3];   // e.g. "Security patch"

// Compute integrity hash
$integrity = Safebox_System_Dependencies::computeIntegrity($package, $version);

echo "Package: {$package}@{$version}\n";
echo "Integrity: {$integrity}\n";
echo "Reason: {$reason}\n\n";

// Create OpenClaim
$claim = [
    'ocp' => 1,
    'stm' => [
        'action' => 'updateDependency',
        'package' => $package,
        'version' => $version,
        'integrity' => $integrity,
        'reason' => $reason,
        'issuedAt' => time()
    ],
    'jti' => bin2hex(random_bytes(16))
];

// Collect M-of-N signatures
echo "Collecting signatures...\n";
$signers = [];
$signatures = [];

foreach (['admin1', 'admin2', 'admin3'] as $admin) {
    echo "Sign with {$admin} key? (y/n): ";
    $answer = trim(fgets(STDIN));
    
    if ($answer === 'y') {
        // Load private key
        $privateKey = file_get_contents("/home/{$admin}/.safebox/private.key");
        
        // Sign claim
        $signature = Q_Crypto_OpenClaim::sign($claim, $privateKey);
        
        $signers[] = $admin;
        $signatures[] = $signature;
        
        echo "✓ Signed by {$admin}\n";
    }
}

$claim['key'] = $signers;
$claim['sig'] = $signatures;

echo "\nSubmitting to Safebox...\n";

// POST to handler
$ch = curl_init('https://safebox.local/Safebox/system/updateDependency');
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(['claim' => $claim]));
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);

$response = curl_exec($ch);
$result = json_decode($response, true);

if ($result['success']) {
    echo "✓ Dependency updated successfully\n";
    echo "Infrastructure will verify on next SIGHUP or restart\n";
} else {
    echo "✗ Update failed: {$result['error']}\n";
}
```

## Usage Example

### Update dockerode to 4.0.3

```bash
# 1. Admin proposes update
php scripts/safebox-admin.php dockerode 4.0.3 "Security patch CVE-2024-12345"

# Output:
# Package: dockerode@4.0.3
# Integrity: sha512-abc123...
# Reason: Security patch CVE-2024-12345
# 
# Collecting signatures...
# Sign with admin1 key? (y/n): y
# ✓ Signed by admin1
# Sign with admin2 key? (y/n): y
# ✓ Signed by admin2
# Sign with admin3 key? (y/n): y
# ✓ Signed by admin3
#
# Submitting to Safebox...
# ✓ Dependency updated successfully
# Infrastructure will verify on next SIGHUP or restart

# 2. Safebox updates /etc/safebox/system-registry.json
# 3. Safebox sends SIGHUP to system-protocol-api
# 4. Infrastructure logs version mismatch
# 5. Operator runs: npm install dockerode@4.0.3
# 6. Operator restarts: systemctl restart safebox-system-api
# 7. Infrastructure verifies hash on startup → SUCCESS
```

## Integration Checklist

For Safebox team to implement:

- [ ] Create `Safebox/handlers/Safebox/system/updateDependency/post.php`
- [ ] Add `Safebox_System_Dependencies::computeIntegrity()` helper
- [ ] Create admin CLI tool for proposing updates
- [ ] Add dependency update to governance UI (optional)
- [ ] Test full flow: propose → approve → update → verify

## Files Safebox Controls

| File | Owner | Purpose |
|------|-------|---------|
| `/etc/safebox/system-registry.json` | Safebox | Approved dependency versions + hashes |
| `/etc/safebox/managed-containers.json` | Operator | Container allowlist (can be moved to registry) |

## Migration Path

### Phase 1 (Current)
- Infrastructure reads optional `system-registry.json`
- Falls back to installed versions if file missing
- Logs dependency status

### Phase 2 (Future)
- Safebox implements governance handlers
- Admins use CLI tool to propose updates
- system-registry.json becomes required

### Phase 3 (Full Governance)
- Merge managed-containers.json into system-registry.json
- All infrastructure config governed by M-of-N
- Single source of truth

## Security Model

**Safebox verifies:** M-of-N signatures approve the dependency update

**Infrastructure verifies:** Installed package hash matches approved hash

**Both layers must pass** for system to start.

If either fails:
- Safebox: Rejects proposal (insufficient signatures)
- Infrastructure: Exits (integrity mismatch)

🔒 **Defense in depth: governance + verification**
