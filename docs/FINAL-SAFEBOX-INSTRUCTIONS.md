# Final Safebox Implementation Instructions

**Complete guide for the Safebox team**

---

## 🎯 Overview

Infrastructure provides a governed API for managing containers via the System protocol. Package managers (npm/composer/git/dnf) and nginx configuration are controlled via M-of-N governance.

---

## 📂 Qbix Directory Structure

**IMPORTANT:** Qbix apps do NOT go in `/var/www`. Each app has its own `web/` folder inside.

```
/opt/qbix/
├── platform/                    ← Qbix Platform core (shared)
│   ├── platform/
│   │   ├── classes/
│   │   ├── handlers/
│   │   └── plugins/
│   │       ├── Streams/         ← Git submodule
│   │       ├── Safebox/         ← Git submodule
│   │       ├── Users/           ← Git submodule
│   │       └── Assets/          ← Git submodule
│   └── composer.json
│
└── apps/                        ← Individual Qbix apps
    ├── Safebox/
    │   ├── web/                 ← Nginx points HERE
    │   │   └── index.php
    │   ├── config/
    │   └── local/
    │
    ├── Intercoin/
    │   ├── web/                 ← Nginx points HERE
    │   │   └── index.php
    │   ├── config/
    │   └── local/
    │
    └── Groups/
        ├── web/                 ← Nginx points HERE
        │   └── index.php
        ├── config/
        └── local/
```

**Key points:**
- `/opt/qbix/platform` = Qbix Platform core (one copy, shared by all apps)
- `/opt/qbix/apps/{AppName}` = Individual app repositories
- `/opt/qbix/apps/{AppName}/web` = Document root for nginx
- Each app has its own git repo, config, and web folder

---

## 🔧 Actions Available

| Action | Purpose | Example |
|--------|---------|---------|
| **npm** | Update Node.js packages | `express@4.18.2` |
| **composer** | Update PHP packages | `qbix/platform:1.0.0` |
| **git** | Clone/update repos | Platform, apps, plugins |
| **dnf** | Update RPM packages | `nodejs-18.0.0` |
| **nginx-config** | Configure app site | Enable Safebox app |
| **nginx-cert** | Update SSL certs | Let's Encrypt or Cloudflare |

---

## 📦 Package Manager Actions

### npm - Node.js Packages

```json
{
  "action": "npm",
  "container": "safebox-node-exec",
  "package": "express",
  "version": "4.18.2",
  "integrity": "sha512-...",
  "workdir": "/app"
}
```

### composer - PHP Packages

```json
{
  "action": "composer",
  "container": "safebox-php-fpm",
  "package": "symfony/console",
  "version": "6.3.0",
  "workdir": "/opt/qbix/platform"
}
```

### git - Repository Operations

**Clone Qbix Platform:**
```json
{
  "action": "git",
  "container": "safebox-php-fpm",
  "url": "https://github.com/Qbix/Platform.git",
  "dest": "/opt/qbix/platform",
  "commit": "a1b2c3d4...",
  "submodules": true
}
```

**Clone Safebox App:**
```json
{
  "action": "git",
  "container": "safebox-php-fpm",
  "url": "https://github.com/Qbix/Safebox-app.git",
  "dest": "/opt/qbix/apps/Safebox",
  "commit": "xyz789..."
}
```

**Update Platform + All Plugins:**
```json
{
  "action": "git",
  "container": "safebox-php-fpm",
  "repo": "/opt/qbix/platform",
  "ref": "origin/master",
  "commit": "b2c3d4e5...",
  "submodules": true
}
```

**Update Single Plugin:**
```json
{
  "action": "git",
  "container": "safebox-php-fpm",
  "repo": "/opt/qbix/platform",
  "submodules": ["platform/plugins/Streams"],
  "commits": {
    "platform/plugins/Streams": "def456..."
  }
}
```

---

## 🌐 Nginx Configuration Management

### nginx-config - Enable App Site

**Enable Safebox app with Let's Encrypt:**
```json
{
  "action": "nginx-config",
  "container": "safebox-nginx",
  "app": "safebox",
  "domain": "safebox.example.com",
  "root": "/opt/qbix/apps/Safebox/web",
  "phpFpmHost": "safebox-php-fpm:9000",
  "sslProvider": "letsencrypt"
}
```

**Enable Intercoin app with Cloudflare SSL:**
```json
{
  "action": "nginx-config",
  "container": "safebox-nginx",
  "app": "intercoin",
  "domain": "intercoin.example.com",
  "root": "/opt/qbix/apps/Intercoin/web",
  "phpFpmHost": "safebox-php-fpm:9000",
  "sslProvider": "cloudflare"
}
```

**What Infrastructure does:**
1. Generates nginx site config from template
2. Writes to `/etc/nginx/sites-available/{app}`
3. Symlinks to `/etc/nginx/sites-enabled/{app}`
4. Runs `nginx -t` to verify config
5. Returns: `{ verified: true }` if config is valid

**Generated config includes:**
- HTTP → HTTPS redirect
- SSL certificate paths (Let's Encrypt or Cloudflare)
- PHP-FPM proxy to specified host
- Qbix-specific settings (client_max_body_size, etc.)
- Document root pointing to app's `web/` folder

### nginx-cert - Update SSL Certificates

**Renew Let's Encrypt certificate:**
```json
{
  "action": "nginx-cert",
  "container": "safebox-nginx",
  "app": "safebox",
  "domain": "safebox.example.com",
  "provider": "letsencrypt"
}
```

**Install Cloudflare certificate:**
```json
{
  "action": "nginx-cert",
  "container": "safebox-nginx",
  "app": "intercoin",
  "domain": "intercoin.example.com",
  "provider": "cloudflare",
  "certPath": "/etc/nginx/certs/intercoin-cloudflare.pem",
  "keyPath": "/etc/nginx/certs/intercoin-cloudflare.key"
}
```

**What Infrastructure does:**

**For Let's Encrypt:**
```bash
certbot renew --cert-name {domain} --nginx
nginx -s reload
```

**For Cloudflare:**
```bash
# Verifies cert files exist at certPath and keyPath
# (Files must be uploaded separately via docker cp or mounted)
nginx -s reload
```

---

## 🔐 Safebox Implementation

### 1. Handler for All Actions

**File:** `Safebox/handlers/Safebox/system/action/post.php`

```php
<?php

function Safebox_system_action_post()
{
    if (!Q_Request::isFromNode()) {
        throw new Q_Exception_Unauthorized("System handlers are Node-only");
    }
    
    $claim = $_REQUEST['claim'];
    $stm = $claim['stm'];
    $action = $stm['action'];  // npm, composer, git, nginx-config, nginx-cert
    
    // Verify M-of-N signatures
    $verification = Safebox_System_Governance::verifySigners($claim);
    
    if (!$verification['valid']) {
        throw new Exception("Insufficient signatures");
    }
    
    // Execute via Protocol.System (Node.js)
    $result = Safebox_System_Governance::execute($claim);
    
    // Log action with details
    Safebox_System_Log::record([
        'action' => $action,
        'container' => $stm['container'],
        'details' => self::getActionDetails($stm),
        'verified' => $result['result']['verified'] ?? false,
        'signers' => $verification['signers']
    ]);
    
    Q_Response::setSlot('result', $result);
}

private static function getActionDetails($stm)
{
    $action = $stm['action'];
    
    switch ($action) {
        case 'npm':
        case 'composer':
            return "{$stm['package']}@{$stm['version']}";
        case 'git':
            if (isset($stm['url'])) {
                return "clone {$stm['url']} → {$stm['dest']}";
            } elseif (isset($stm['submodules'])) {
                return "update submodules: " . implode(', ', $stm['submodules']);
            } else {
                return "checkout {$stm['commit']}";
            }
        case 'nginx-config':
            return "{$stm['app']} @ {$stm['domain']} ({$stm['sslProvider']})";
        case 'nginx-cert':
            return "{$stm['domain']} ({$stm['provider']})";
        default:
            return json_encode($stm);
    }
}
```

### 2. Helper Functions

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
     * Get current git commit
     */
    static function getGitCommit($repo)
    {
        return trim(shell_exec("cd {$repo} && git rev-parse HEAD"));
    }
    
    /**
     * Get submodule commit
     */
    static function getSubmoduleCommit($repo, $submodule)
    {
        return trim(shell_exec("cd {$repo}/{$submodule} && git rev-parse HEAD"));
    }
}
```

### 3. Admin CLI Tool

**File:** `scripts/safebox-admin.php`

```php
<?php

// Usage:
// php safebox-admin.php git clone-platform a1b2c3d4...
// php safebox-admin.php git clone-safebox-app xyz789...
// php safebox-admin.php git update-streams def456...
// php safebox-admin.php nginx enable-safebox safebox.example.com
// php safebox-admin.php nginx renew-cert safebox.example.com

$category = $argv[1];  // git, npm, nginx
$command = $argv[2];   // clone-platform, update-streams, enable-safebox, etc.
$params = array_slice($argv, 3);

// Load default command templates
$containers = json_decode(
    file_get_contents('/etc/safebox/managed-containers.json'),
    true
);

switch ($category) {
    case 'git':
        handleGitCommand($command, $params, $containers);
        break;
    case 'npm':
        handleNpmCommand($command, $params, $containers);
        break;
    case 'nginx':
        handleNginxCommand($command, $params, $containers);
        break;
}

function handleGitCommand($command, $params, $containers)
{
    $commit = $params[0];
    
    $templates = [
        'clone-platform' => $containers['safebox-php-fpm']['defaultCommands']['git-clone-platform'],
        'clone-safebox-app' => $containers['safebox-php-fpm']['defaultCommands']['git-clone-app-safebox'],
        'update-platform' => $containers['safebox-php-fpm']['defaultCommands']['git-update-platform'],
        'update-streams' => $containers['safebox-php-fpm']['defaultCommands']['git-update-all-plugins']
    ];
    
    $template = $templates[$command];
    $template['commit'] = $commit;
    
    submitClaim('safebox-php-fpm', $template);
}

function handleNginxCommand($command, $params, $containers)
{
    $domain = $params[0];
    
    $templates = [
        'enable-safebox' => $containers['safebox-nginx']['defaultCommands']['nginx-enable-safebox-app'],
        'enable-intercoin' => $containers['safebox-nginx']['defaultCommands']['nginx-enable-intercoin-app'],
        'renew-cert' => $containers['safebox-nginx']['defaultCommands']['nginx-update-cert-safebox']
    ];
    
    $template = $templates[$command];
    $template['domain'] = $domain;
    
    submitClaim('safebox-nginx', $template);
}

function submitClaim($container, $stm)
{
    echo "Action: {$stm['action']}\n";
    echo "Container: {$container}\n";
    print_r($stm);
    echo "\n";
    
    // Create OpenClaim
    $claim = [
        'ocp' => 1,
        'stm' => array_merge(['container' => $container], $stm),
        'jti' => bin2hex(random_bytes(16))
    ];
    
    // Collect M-of-N signatures
    echo "Collecting signatures...\n";
    // ... (signature collection code)
    
    // Submit to handler
    $ch = curl_init('https://safebox.local/Safebox/system/action');
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(['claim' => $claim]));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    
    $response = curl_exec($ch);
    $result = json_decode($response, true);
    
    if ($result['success']) {
        echo "✓ Action executed successfully\n";
    } else {
        echo "✗ Action failed: {$result['error']}\n";
    }
}
```

---

## 🚀 Typical Workflows

### Initial Setup: Clone Everything

```bash
# 1. Clone Qbix Platform with all plugins
php safebox-admin.php git clone-platform a1b2c3d4...

# 2. Clone Safebox app
php safebox-admin.php git clone-safebox-app xyz789...

# 3. Clone Intercoin app
php safebox-admin.php git clone-intercoin-app abc123...

# 4. Enable Safebox site with Let's Encrypt
php safebox-admin.php nginx enable-safebox safebox.example.com

# 5. Enable Intercoin site with Cloudflare
php safebox-admin.php nginx enable-intercoin intercoin.example.com
```

### Update Workflow: Platform + Plugins

```bash
# Get current commits
cd /opt/qbix/platform
git log -1 origin/master --format=%H
# Output: b2c3d4e5...

cd platform/plugins/Streams
git log -1 origin/master --format=%H
# Output: def456...

# Propose update
php safebox-admin.php git update-all-plugins \
  --platform=b2c3d4e5... \
  --streams=def456... \
  --safebox=ghi789...

# M-of-N admins sign
# Infrastructure updates repos
# Verifies all commits match
```

### SSL Certificate Renewal

```bash
# Let's Encrypt (automatic renewal)
php safebox-admin.php nginx renew-cert safebox.example.com

# Cloudflare (manual cert upload, then update)
# 1. Upload cert to container: docker cp cert.pem safebox-nginx:/etc/nginx/certs/
# 2. Update nginx
php safebox-admin.php nginx update-cloudflare-cert intercoin.example.com
```

---

## ✅ Implementation Checklist

**For Safebox team:**

- [ ] Create `Safebox/handlers/Safebox/system/action/post.php`
- [ ] Create `Safebox/classes/Safebox/System/PackageManager.php`
- [ ] Create admin CLI tool `scripts/safebox-admin.php`
- [ ] Update `/etc/safebox/managed-containers.json` with real commit hashes
- [ ] Test: Clone Qbix Platform
- [ ] Test: Clone Safebox app
- [ ] Test: Update Streams plugin
- [ ] Test: Enable nginx site for Safebox app
- [ ] Test: Renew Let's Encrypt certificate

---

## 📊 Summary

**Infrastructure provides:**
✅ Package manager actions (npm/composer/git/dnf)  
✅ Nginx site configuration management  
✅ SSL certificate management (Let's Encrypt + Cloudflare)  
✅ Git operations (clone/pull/submodules)  
✅ Hash verification for all operations  

**Safebox implements:**
❌ Handler + helper + CLI tool  
❌ M-of-N governance integration  
❌ Fill in commit hashes in managed-containers.json  

**Result:**
- Governed deployment of Qbix apps
- Managed nginx configuration per app
- Automated SSL certificate renewal
- Hash-verified package updates

🎉 **Complete infrastructure governance for Qbix Platform!**
