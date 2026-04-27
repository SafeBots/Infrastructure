# Package Manager Actions - Safebox Implementation Guide

**For Safebox team: Implementing governed package updates with hash verification**

## Overview

Instead of generic `exec`, Infrastructure now provides **specific package manager actions**:
- **`npm`** - Update Node.js packages with integrity verification
- **`composer`** - Update PHP packages with hash verification
- **`git`** - Update git repos to specific commit hashes
- **`dnf`** - Update RPM packages (signatures verified by DNF)

Each action is **hash-verified** and **audit-logged** with package+version+hash visible in governance.

---

## Action Formats

### npm - Node.js Packages

```json
{
  "action": "npm",
  "container": "safebox-node-exec",
  "package": "express",
  "version": "4.18.2",
  "integrity": "sha512-5/PsL6iGPdfQ/lKM1UuielYgv3BUoJfz1aUwU9vHZ+J7gyvwdQXFEBIEIaxeGf0GIcreATNyBExtalisDbuMqQ==",
  "workdir": "/app"  // optional, defaults to /app
}
```

**What Infrastructure does:**
1. Creates package.json with `{ "dependencies": { "express": "4.18.2" } }`
2. Creates package-lock.json with integrity hash
3. Runs `npm ci --production`
4. **npm verifies integrity hash automatically**
5. Returns: `{ package, version, verified: true }`

**How to get integrity hash:**
```bash
npm view express@4.18.2 dist.integrity
# Returns: sha512-5/PsL6iGPdfQ/lKM1UuielYgv3BUoJfz1aUwU9vHZ+J7gyvwdQXFEBIEIaxeGf0GIcreATNyBExtalisDbuMqQ==
```

### composer - PHP Packages

```json
{
  "action": "composer",
  "container": "safebox-php-fpm",
  "package": "symfony/console",
  "version": "6.3.0",
  "hash": "8788f...",  // optional SHA-256 from composer.lock
  "workdir": "/var/www"  // optional, defaults to /var/www
}
```

**What Infrastructure does:**
1. Runs `composer require symfony/console:6.3.0`
2. Composer downloads and verifies package
3. If `hash` provided, reads composer.lock and verifies
4. Returns: `{ package, version, verified: true/false }`

**How to get hash:**
```bash
composer show symfony/console 6.3.0 --format=json | jq '.dist.shasum'
```

### git - Git Repositories

```json
{
  "action": "git",
  "container": "safebox-node-exec",
  "repo": "/var/www/qbix",
  "commit": "a1b2c3d4e5f6789012345678901234567890abcd"  // 40-char hex
}
```

**What Infrastructure does:**
1. Validates commit is 40-character hex hash
2. Runs `git fetch origin && git checkout {commit}`
3. Verifies `git rev-parse HEAD` matches requested commit
4. Returns: `{ repo, commit, verified: true, currentCommit }`

**How to get commit hash:**
```bash
git rev-parse HEAD
# Or: git log -1 --format=%H
```

### dnf - RPM Packages (RHEL/CentOS)

```json
{
  "action": "dnf",
  "container": "safebox-rhel-app",
  "package": "nodejs",
  "version": "18.0.0-1.el9"
}
```

**What Infrastructure does:**
1. Runs `dnf update -y nodejs-18.0.0-1.el9`
2. DNF verifies package signatures automatically
3. Returns: `{ package, version, verified: true }`

---

## Safebox Implementation

### 1. Handler for Package Updates

**File:** `Safebox/handlers/Safebox/system/packageUpdate/post.php`

```php
<?php

function Safebox_system_packageUpdate_post()
{
    // Node-only check
    if (!Q_Request::isFromNode()) {
        throw new Q_Exception_Unauthorized("System handlers are Node-only");
    }
    
    $claim = $_REQUEST['claim'];
    $stm = $claim['stm'];
    
    // Extract package manager action
    $action = $stm['action'];  // npm, composer, git, dnf
    $container = $stm['container'];
    
    // Verify M-of-N signatures
    $verification = Safebox_System_Governance::verifySigners($claim);
    
    if (!$verification['valid']) {
        throw new Exception("Insufficient signatures");
    }
    
    // Execute via Protocol.System (Node.js)
    $result = Safebox_System_Governance::execute($claim);
    
    // Log to audit
    Safebox_System_Log::record([
        'action' => $action,
        'container' => $container,
        'package' => $stm['package'] ?? $stm['repo'],
        'version' => $stm['version'] ?? $stm['commit'],
        'verified' => $result['result']['verified'],
        'signers' => $verification['signers']
    ]);
    
    Q_Response::setSlot('result', $result);
}
```

### 2. Helper to Get Integrity Hashes

**File:** `Safebox/classes/Safebox/System/PackageManager.php`

```php
<?php

class Safebox_System_PackageManager
{
    /**
     * Get npm package integrity hash
     */
    static function getNpmIntegrity($package, $version)
    {
        $url = "https://registry.npmjs.org/{$package}/{$version}";
        $info = json_decode(file_get_contents($url), true);
        
        return $info['dist']['integrity'];
    }
    
    /**
     * Get composer package hash
     */
    static function getComposerHash($package, $version)
    {
        $url = "https://repo.packagist.org/p2/{$package}.json";
        $info = json_decode(file_get_contents($url), true);
        
        $versionInfo = $info['packages'][$package][$version] ?? null;
        if (!$versionInfo) {
            throw new Exception("Version not found");
        }
        
        return $versionInfo['dist']['shasum'];
    }
    
    /**
     * Get current git commit
     */
    static function getGitCommit($repo)
    {
        return trim(shell_exec("cd {$repo} && git rev-parse HEAD"));
    }
}
```

### 3. Admin CLI Tool

**File:** `scripts/safebox-package-update.php`

```php
<?php

// Usage: php safebox-package-update.php npm express 4.18.2

$manager = $argv[1];  // npm, composer, git, dnf
$package = $argv[2];  // package name or repo path
$version = $argv[3];  // version or commit hash

// Get integrity hash automatically
$integrity = null;
switch ($manager) {
    case 'npm':
        $integrity = Safebox_System_PackageManager::getNpmIntegrity($package, $version);
        break;
    case 'composer':
        $integrity = Safebox_System_PackageManager::getComposerHash($package, $version);
        break;
    case 'git':
        // Validate commit hash format
        if (!preg_match('/^[a-f0-9]{40}$/', $version)) {
            die("Error: Git commit must be 40-character hex hash\n");
        }
        break;
}

echo "Package Manager: {$manager}\n";
echo "Package: {$package}\n";
echo "Version: {$version}\n";
if ($integrity) {
    echo "Integrity: {$integrity}\n";
}
echo "\n";

// Create OpenClaim
$claim = [
    'ocp' => 1,
    'stm' => [
        'action' => $manager,
        'container' => 'safebox-node-exec',  // TODO: auto-detect or prompt
        'package' => $package,
        'version' => $version
    ],
    'jti' => bin2hex(random_bytes(16))
];

// Add integrity/commit based on manager
switch ($manager) {
    case 'npm':
        $claim['stm']['integrity'] = $integrity;
        break;
    case 'composer':
        $claim['stm']['hash'] = $integrity;
        break;
    case 'git':
        $claim['stm']['repo'] = $package;
        $claim['stm']['commit'] = $version;
        unset($claim['stm']['package'], $claim['stm']['version']);
        break;
}

// Collect M-of-N signatures
echo "Collecting signatures...\n";
$signers = [];
$signatures = [];

foreach (['admin1', 'admin2', 'admin3'] as $admin) {
    echo "Sign with {$admin} key? (y/n): ";
    $answer = trim(fgets(STDIN));
    
    if ($answer === 'y') {
        $privateKey = file_get_contents("/home/{$admin}/.safebox/private.key");
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
$ch = curl_init('https://safebox.local/Safebox/system/packageUpdate');
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(['claim' => $claim]));
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);

$response = curl_exec($ch);
$result = json_decode($response, true);

if ($result['success']) {
    echo "✓ Package updated successfully\n";
    echo "  Verified: " . ($result['result']['verified'] ? 'YES' : 'NO') . "\n";
} else {
    echo "✗ Update failed: {$result['error']}\n";
}
```

---

## Usage Examples

### Update npm Package

```bash
# 1. Admin proposes update
php scripts/safebox-package-update.php npm express 4.18.2

# Output:
# Package Manager: npm
# Package: express
# Version: 4.18.2
# Integrity: sha512-5/PsL6iGPdfQ/lKM1UuielYgv3BUoJfz1aUwU9vHZ+J7gyvwdQXFEBIEIaxeGf0GIcreATNyBExtalisDbuMqQ==
# 
# Collecting signatures...
# Sign with admin1 key? (y/n): y
# ✓ Signed by admin1
# Sign with admin2 key? (y/n): y
# ✓ Signed by admin2
# 
# Submitting to Safebox...
# ✓ Package updated successfully
#   Verified: YES
```

**Audit log shows:**
```
Action: npm
Container: safebox-node-exec
Package: express
Version: 4.18.2
Integrity: sha512-5/PsL6iG...
Verified: ✅ YES (npm verified integrity)
Approved by: admin1, admin2
```

### Update Git Repo

```bash
# Get current commit
cd /var/www/qbix
git log -1 --format=%H
# Output: a1b2c3d4e5f6789012345678901234567890abcd

# Propose update to specific commit
php scripts/safebox-package-update.php git /var/www/qbix a1b2c3d4e5f6789012345678901234567890abcd

# After M-of-N approval:
# Infrastructure executes git checkout
# Verifies current commit matches requested commit
# Returns verified: true
```

---

## Comparison: exec vs Package Managers

### OLD (exec - too broad):

**Proposal:**
```json
{
  "action": "exec",
  "cmd": ["npm", "install", "express@4.18.2"]
}
```

❌ **Problems:**
- Can run ANY command
- No hash verification
- Audit log shows "exec" not "updated express"
- Governance approves "run this command" not "update this package"

### NEW (package manager - specific):

**Proposal:**
```json
{
  "action": "npm",
  "package": "express",
  "version": "4.18.2",
  "integrity": "sha512-..."
}
```

✅ **Benefits:**
- Can ONLY update packages
- Hash automatically verified by npm
- Audit log: "updated express to 4.18.2 (verified)"
- Governance: "approve express 4.18.2" (clear intent)

---

## Implementation Checklist

For Safebox team:

- [ ] Create `Safebox/handlers/Safebox/system/packageUpdate/post.php`
- [ ] Create `Safebox/classes/Safebox/System/PackageManager.php`
- [ ] Create admin CLI tool `scripts/safebox-package-update.php`
- [ ] Update `Safebox_System_Governance` to handle package manager actions
- [ ] Add package manager actions to governance UI (optional)
- [ ] Test full flow: propose → M-of-N sign → execute → verify

---

## Security Model

**Two-layer verification:**

| Layer | Verifies | Action |
|-------|----------|--------|
| **Safebox (PHP)** | M-of-N signatures valid | Rejects if insufficient |
| **Infrastructure (Node)** | Package hash matches | npm/composer/dnf verify |

**Both must pass** for update to succeed.

**Example attack scenario:**

```
Attacker compromises npm registry, replaces express 4.18.2 with malicious version
    ↓
Admin runs: php safebox-package-update.php npm express 4.18.2
    ↓
CLI fetches integrity from npm: sha512-MALICIOUS...
    ↓
M-of-N admins sign (they see the hash in the claim)
    ↓
Infrastructure executes: npm install express@4.18.2
    ↓
npm downloads package
    ↓
npm computes integrity hash of downloaded package
    ↓
❌ Hash mismatch: sha512-LEGITIMATE vs sha512-MALICIOUS
    ↓
npm install FAILS
    ↓
Infrastructure returns: { success: false, error: "integrity checksum failed" }
    ↓
Safebox logs: Package update FAILED - integrity mismatch
    ↓
Admins investigate, discover attack
```

**Defense:** Package manager's built-in verification catches the attack.

---

## Summary

**Infrastructure provides (already implemented):**
✅ npm action with integrity verification  
✅ composer action with hash verification  
✅ git action with commit verification  
✅ dnf action with signature verification  

**Safebox needs to implement:**
❌ Handler: `packageUpdate/post.php`  
❌ Helper: `Safebox_System_PackageManager`  
❌ Admin CLI tool  
❌ Integration with `Safebox_System_Governance`  

**Result:** Governed package updates with hash verification, clear audit trail, no arbitrary command execution.

🎉 **Ready for implementation!**

---

## Default Commands

The `managed-containers.json` includes **default commands** for common operations. These are templates that Safebox admins can use to propose updates.

### How Default Commands Work

Each container can define common operations in `defaultCommands`:

```json
{
  "safebox-php-fpm": {
    "defaultCommands": {
      "git-clone-qbix": {
        "action": "git",
        "url": "https://github.com/Qbix/Platform.git",
        "dest": "/var/www/qbix",
        "commit": "REPLACE_WITH_CURRENT_COMMIT_HASH",
        "submodules": true
      }
    }
  }
}
```

### Using Default Commands in Safebox

**CLI tool with defaults:**

```php
// scripts/safebox-default-command.php
$container = $argv[1];  // "safebox-php-fpm"
$command = $argv[2];    // "git-clone-qbix"
$commit = $argv[3];     // "a1b2c3d4..."

// Load default command template
$containers = json_decode(file_get_contents('/etc/safebox/managed-containers.json'), true);
$template = $containers[$container]['defaultCommands'][$command];

// Fill in the commit hash
$template['commit'] = $commit;

// Create OpenClaim
$claim = [
    'ocp' => 1,
    'stm' => array_merge(['container' => $container], $template),
    'jti' => bin2hex(random_bytes(16))
];

// Collect M-of-N signatures and submit...
```

**Usage:**

```bash
# Clone Qbix Platform
php safebox-default-command.php safebox-php-fpm git-clone-qbix a1b2c3d4...

# Update Streams plugin
php safebox-default-command.php safebox-php-fpm git-update-streams-plugin xyz789...

# Update SafeBots
php safebox-default-command.php safebox-node-exec git-update-safebots abc123...
```

---

## Git Operations Reference

### git-clone (Initial Setup)

**Use when:** Setting up a new container with a fresh repository clone.

```json
{
  "action": "git",
  "url": "https://github.com/Qbix/Platform.git",
  "dest": "/var/www/qbix",
  "commit": "a1b2c3d4e5f6789012345678901234567890abcd",
  "submodules": true
}
```

**Infrastructure executes:**
```bash
git clone https://github.com/Qbix/Platform.git /var/www/qbix
cd /var/www/qbix
git checkout a1b2c3d4e5f6789012345678901234567890abcd
git submodule init
git submodule update
git rev-parse HEAD  # Verify commit
```

### git-pull (Update Existing)

**Use when:** Updating an existing repository to a newer commit.

```json
{
  "action": "git",
  "repo": "/var/www/qbix",
  "ref": "origin/master",
  "commit": "b2c3d4e5f6789012345678901234567890abcde1",
  "submodules": true
}
```

**Infrastructure executes:**
```bash
cd /var/www/qbix
git fetch origin
git checkout b2c3d4e5f6789012345678901234567890abcde1
git submodule update --init --recursive
git rev-parse HEAD  # Verify commit
```

### git-submodule (Update Plugins)

**Use when:** Updating specific submodules (e.g., Qbix plugins) without touching main repo.

```json
{
  "action": "git",
  "repo": "/var/www/qbix",
  "submodules": ["platform/plugins/Streams", "platform/plugins/Safebox"],
  "commits": {
    "platform/plugins/Streams": "xyz123...",
    "platform/plugins/Safebox": "abc456..."
  }
}
```

**Infrastructure executes:**
```bash
cd /var/www/qbix
git submodule update --init platform/plugins/Streams
cd platform/plugins/Streams && git rev-parse HEAD  # Verify
cd ../..
git submodule update --init platform/plugins/Safebox
cd platform/plugins/Safebox && git rev-parse HEAD  # Verify
```

---

## Current Qbix/Safebox Setup

### Typical Repository Structure

```
/var/www/qbix/
├── platform/
│   ├── classes/
│   ├── handlers/
│   └── plugins/
│       ├── Streams/          ← Git submodule
│       ├── Safebox/          ← Git submodule
│       ├── Users/            ← Git submodule
│       ├── Assets/           ← Git submodule
│       └── Calendars/        ← Git submodule
├── local/
└── composer.json
```

### How to Get Current Commit Hashes

```bash
# Main platform commit
cd /var/www/qbix
git rev-parse HEAD
# Output: a1b2c3d4e5f6789012345678901234567890abcd

# Streams plugin commit
cd platform/plugins/Streams
git rev-parse HEAD
# Output: xyz123abc456def789012345678901234567890

# Safebox plugin commit
cd ../Safebox
git rev-parse HEAD
# Output: abc456def789012345678901234567890xyz123
```

### Typical Update Workflow

**Scenario:** Update Qbix Platform to latest master + update all plugins

```bash
# 1. Get target commit hashes
cd /var/www/qbix && git log -1 origin/master --format=%H
# Output: b2c3d4e5...

cd platform/plugins/Streams && git log -1 origin/master --format=%H
# Output: def789...

cd ../Safebox && git log -1 origin/master --format=%H
# Output: ghi012...

# 2. Propose update via CLI
php safebox-default-command.php safebox-platform-app git-update-all-plugins \
  --platform-commit=b2c3d4e5... \
  --streams-commit=def789... \
  --safebox-commit=ghi012...

# 3. M-of-N admins sign
# 4. Infrastructure executes git operations
# 5. Verifies all commit hashes match
```

---

## Container-Specific Commands

### safebox-php-fpm (Qbix Platform)

**Common operations:**
- `git-clone-qbix` - Initial clone with submodules
- `git-update-qbix` - Pull latest, update submodules
- `git-update-streams-plugin` - Update Streams only
- `git-update-safebox-plugin` - Update Safebox only
- `composer-update-qbix` - Update PHP dependencies

### safebox-node-exec (SafeBots)

**Common operations:**
- `git-clone-safebots` - Initial clone
- `git-update-safebots` - Update to specific commit
- `npm-update-safebots` - Update npm package

### safebox-platform-app (Full Platform)

**Common operations:**
- `git-clone-platform` - Clone with ALL submodules
- `git-pull-platform` - Update platform + ALL plugins
- `git-update-all-plugins` - Update 5+ plugins to specific commits
- `composer-install-platform` - Install dependencies

### safebox-intercoin-node (Intercoin)

**Common operations:**
- `git-clone-intercoin` - Initial clone
- `npm-update-web3` - Update web3.js library
- `npm-update-ethers` - Update ethers.js library

---

## FAQ

**Q: What if I don't know the commit hash yet?**

A: The default commands have `REPLACE_WITH_*_COMMIT_HASH` placeholders. Use the CLI tool which fetches current hashes and prompts you.

**Q: Can I update just one plugin without touching the main repo?**

A: Yes! Use `git-update-streams-plugin` or `git-update-safebox-plugin` commands.

**Q: How do I verify what commit is currently deployed?**

A: SSH into container:
```bash
docker exec safebox-php-fpm sh -c "cd /var/www/qbix && git rev-parse HEAD"
```

**Q: What's the difference between git-pull and git-checkout?**

A: 
- `git-pull` updates from remote (`git fetch + checkout`)
- `git-checkout` just switches to a commit (for containers with existing repos)

**Q: Do submodules update automatically?**

A: Only if `"submodules": true` in the command. Otherwise they stay at their current commits.

**Q: Can I clone from a private repo?**

A: Yes, but the container needs SSH keys or access tokens configured.

---

## Next Steps

1. **Fill in commit hashes** - Replace placeholders with actual commit hashes from your repos
2. **Test git-clone** - Use default command to clone Qbix Platform
3. **Test git-update** - Update to a newer commit
4. **Test submodule updates** - Update Streams or Safebox plugin independently
5. **Add more defaults** - Create templates for your specific workflows

**All git operations are hash-verified and M-of-N governed!** 🔒
