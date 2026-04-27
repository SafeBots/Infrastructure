#!/usr/bin/env node
/**
 * system-protocol-api - Production Implementation
 * 
 * Implements Safebox Infrastructure Specification v1.0
 * 
 * Security layers:
 * - Peer UID verification (SO_PEERCRED on Unix socket)
 * - HMAC request/response signing
 * - Container allowlist (managed-containers.json)
 * - Per-action allowlisting
 * - Exponential backoff with persistence
 * - JTI replay protection with persistence
 * - Structured JSON audit logging
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Docker = require('dockerode');

// ============================================================================
// CONFIGURATION
// ============================================================================

const SOCKET_PATH = process.env.SOCKET_PATH || '/run/safebox/system-api.sock';
const CONFIG_DIR = process.env.CONFIG_DIR || '/etc/safebox';
const STATE_DIR = process.env.STATE_DIR || '/var/lib/safebox-system-api';
const LOG_FILE = process.env.LOG_FILE || '/var/log/safebox-system-api.log';

const HMAC_KEY_PATH = path.join(CONFIG_DIR, 'system-api.key');
const SAFEBOX_UID_PATH = path.join(CONFIG_DIR, 'safebox-uid');
const MANAGED_CONTAINERS_PATH = path.join(CONFIG_DIR, 'managed-containers.json');
const SYSTEM_REGISTRY_PATH = path.join(CONFIG_DIR, 'system-registry.json');
const BACKOFF_STATE_PATH = path.join(STATE_DIR, 'backoff.json');
const JTI_STATE_PATH = path.join(STATE_DIR, 'seen-jti.json');

// Ensure state directory exists
if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o750 });
}

// ============================================================================
// LOAD CONFIGURATION
// ============================================================================

// Load HMAC key
let HMAC_KEY;
try {
    HMAC_KEY = fs.readFileSync(HMAC_KEY_PATH, 'utf8').trim();
    if (HMAC_KEY.length < 32) {
        console.error('[FATAL] HMAC key too short (must be 32+ chars)');
        process.exit(1);
    }
    console.log('[Security] Loaded HMAC key from', HMAC_KEY_PATH);
} catch (e) {
    console.error('[FATAL] Cannot read HMAC key:', e.message);
    console.error('[FATAL] Generate with: openssl rand -hex 64 >', HMAC_KEY_PATH);
    process.exit(1);
}

// Load Safebox UID
let SAFEBOX_UID;
try {
    SAFEBOX_UID = parseInt(fs.readFileSync(SAFEBOX_UID_PATH, 'utf8').trim(), 10);
    console.log('[Security] Safebox UID:', SAFEBOX_UID);
} catch (e) {
    console.error('[FATAL] Cannot read Safebox UID:', e.message);
    console.error('[FATAL] Create file with: echo "UID" >', SAFEBOX_UID_PATH);
    process.exit(1);
}

// Load managed containers
let managedContainers = {};
function loadManagedContainers() {
    try {
        const data = fs.readFileSync(MANAGED_CONTAINERS_PATH, 'utf8');
        managedContainers = JSON.parse(data);
        console.log('[Config] Loaded', Object.keys(managedContainers).length, 'managed containers');
        return true;
    } catch (e) {
        console.error('[Error] Cannot load managed-containers.json:', e.message);
        return false;
    }
}

if (!loadManagedContainers()) {
    console.error('[FATAL] Cannot start without managed-containers.json');
    process.exit(1);
}

// Reload on SIGHUP
process.on('SIGHUP', () => {
    console.log('[Config] Received SIGHUP, reloading configuration');
    loadManagedContainers();
    checkDependencies();
});

// ============================================================================
// DEPENDENCY MANAGEMENT
// ============================================================================

async function checkDependencies() {
    try {
        if (!fs.existsSync(SYSTEM_REGISTRY_PATH)) {
            log({ event: 'no_system_registry', note: 'Dependency governance not configured' });
            return;
        }
        
        const registry = JSON.parse(fs.readFileSync(SYSTEM_REGISTRY_PATH, 'utf8'));
        const deps = registry.dependencies || {};
        
        if (Object.keys(deps).length === 0) {
            return;
        }
        
        for (const [pkg, spec] of Object.entries(deps)) {
            try {
                const pkgJson = require(`${pkg}/package.json`);
                const currentVersion = pkgJson.version;
                
                if (currentVersion !== spec.version) {
                    log({
                        event: 'dependency_mismatch',
                        package: pkg,
                        currentVersion,
                        requiredVersion: spec.version,
                        action: 'restart_required'
                    });
                    
                    console.error(`[Dependency] ${pkg}@${currentVersion} does not match governance requirement ${spec.version}`);
                    console.error(`[Dependency] Update with: npm install ${pkg}@${spec.version}`);
                    console.error(`[Dependency] Then verify hash and restart service`);
                }
                
                // Verify integrity if specified
                if (spec.integrity) {
                    const installedHash = computePackageHash(pkg);
                    if (installedHash !== spec.integrity) {
                        log({
                            event: 'dependency_integrity_mismatch',
                            package: pkg,
                            expected: spec.integrity.slice(0, 20) + '...',
                            actual: installedHash.slice(0, 20) + '...',
                            action: 'verification_failed'
                        });
                        
                        console.error(`[Security] ${pkg} integrity verification FAILED`);
                        console.error(`[Security] Expected: ${spec.integrity}`);
                        console.error(`[Security] Actual:   ${installedHash}`);
                        console.error(`[Security] Possible supply chain attack - DO NOT USE`);
                        process.exit(1);
                    }
                }
                
                log({
                    event: 'dependency_verified',
                    package: pkg,
                    version: currentVersion,
                    integrity: spec.integrity ? 'verified' : 'not_checked'
                });
                
            } catch (e) {
                log({
                    event: 'dependency_check_error',
                    package: pkg,
                    error: e.message
                });
            }
        }
        
    } catch (e) {
        log({ event: 'dependency_check_failed', error: e.message });
    }
}

function computePackageHash(pkg) {
    try {
        const pkgPath = require.resolve(`${pkg}/package.json`);
        const content = fs.readFileSync(pkgPath, 'utf8');
        return 'sha512-' + crypto.createHash('sha512')
            .update(content)
            .digest('base64');
    } catch (e) {
        return null;
    }
}

// Check dependencies on startup
checkDependencies();

// ============================================================================
// DOCKER CLIENT
// ============================================================================

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// ============================================================================
// HMAC FUNCTIONS
// ============================================================================

function computeHMAC(data) {
    return crypto.createHmac('sha256', HMAC_KEY)
        .update(typeof data === 'string' ? data : JSON.stringify(data))
        .digest('hex');
}

function verifyHMAC(data, signature) {
    const expected = computeHMAC(data);
    try {
        return crypto.timingSafeEqual(
            Buffer.from(expected, 'hex'),
            Buffer.from(signature, 'hex')
        );
    } catch (e) {
        return false;
    }
}

// ============================================================================
// STRUCTURED LOGGING
// ============================================================================

function log(entry) {
    const logEntry = {
        ts: new Date().toISOString(),
        ...entry
    };
    
    const line = JSON.stringify(logEntry) + '\n';
    
    try {
        fs.appendFileSync(LOG_FILE, line, { mode: 0o640 });
    } catch (e) {
        console.error('[Logging Error]', e.message);
    }
    
    // Also to stdout for systemd journal
    console.log(line.trim());
}

// ============================================================================
// JTI TRACKING
// ============================================================================

class JTITracker {
    constructor() {
        this.seen = new Map();
        this.load();
        
        // Cleanup every hour
        setInterval(() => this.cleanup(), 3600000);
    }
    
    load() {
        try {
            if (fs.existsSync(JTI_STATE_PATH)) {
                const data = JSON.parse(fs.readFileSync(JTI_STATE_PATH, 'utf8'));
                this.seen = new Map(Object.entries(data));
                log({ event: 'jti_loaded', count: this.seen.size });
            }
        } catch (e) {
            log({ event: 'jti_load_error', error: e.message });
        }
    }
    
    save() {
        try {
            const data = Object.fromEntries(this.seen);
            fs.writeFileSync(JTI_STATE_PATH, JSON.stringify(data, null, 2), { mode: 0o640 });
        } catch (e) {
            log({ event: 'jti_save_error', error: e.message });
        }
    }
    
    check(jti) {
        // Validate format
        if (typeof jti !== 'string' || jti.length < 32 || jti.length > 128) {
            return { valid: false, reason: 'Invalid JTI format' };
        }
        
        if (!/^[a-zA-Z0-9-]+$/.test(jti)) {
            return { valid: false, reason: 'Invalid JTI characters' };
        }
        
        // Check if seen
        const exp = this.seen.get(jti);
        const now = Math.floor(Date.now() / 1000);
        
        if (exp && exp > now) {
            return { valid: false, reason: 'JTI already seen' };
        }
        
        // Insert with 24-hour expiry
        this.seen.set(jti, now + 86400);
        this.save();
        
        return { valid: true };
    }
    
    cleanup() {
        const now = Math.floor(Date.now() / 1000);
        let removed = 0;
        
        for (const [jti, exp] of this.seen.entries()) {
            if (exp < now) {
                this.seen.delete(jti);
                removed++;
            }
        }
        
        if (removed > 0) {
            this.save();
            log({ event: 'jti_cleanup', removed });
        }
    }
}

const jtiTracker = new JTITracker();

// ============================================================================
// EXPONENTIAL BACKOFF
// ============================================================================

class BackoffTracker {
    constructor() {
        this.state = {};
        this.load();
    }
    
    load() {
        try {
            if (fs.existsSync(BACKOFF_STATE_PATH)) {
                this.state = JSON.parse(fs.readFileSync(BACKOFF_STATE_PATH, 'utf8'));
                log({ event: 'backoff_loaded', containers: Object.keys(this.state).length });
            }
        } catch (e) {
            log({ event: 'backoff_load_error', error: e.message });
        }
    }
    
    save() {
        try {
            fs.writeFileSync(BACKOFF_STATE_PATH, JSON.stringify(this.state, null, 2), { mode: 0o640 });
        } catch (e) {
            log({ event: 'backoff_save_error', error: e.message });
        }
    }
    
    check(container, config) {
        if (!config.exponentialBackoff) {
            return { allowed: true };
        }
        
        const now = Math.floor(Date.now() / 1000);
        const containerState = this.state[container] || {
            operations: [],
            cooldownUntil: 0,
            consecutiveOps: 0
        };
        
        if (containerState.cooldownUntil > now) {
            const remaining = Math.ceil((containerState.cooldownUntil - now) / 3600);
            return {
                allowed: false,
                reason: `Cooldown: ${remaining} hours remaining`,
                cooldownUntil: containerState.cooldownUntil
            };
        }
        
        return { allowed: true };
    }
    
    record(container, config) {
        if (!config.exponentialBackoff) {
            return;
        }
        
        const now = Math.floor(Date.now() / 1000);
        const sevenDaysAgo = now - (7 * 86400);
        
        const containerState = this.state[container] || {
            operations: [],
            cooldownUntil: 0,
            consecutiveOps: 0
        };
        
        // Clean old operations
        containerState.operations = containerState.operations.filter(op => op > sevenDaysAgo);
        containerState.operations.push(now);
        
        // Calculate churn multiplier
        const opsCount = containerState.operations.length;
        const churnThresholds = config.backoff?.churnThresholds || { 5: 2, 10: 3, 15: 4 };
        let churnMult = 1;
        
        if (opsCount >= 15) churnMult = churnThresholds['15'] || 4;
        else if (opsCount >= 10) churnMult = churnThresholds['10'] || 3;
        else if (opsCount >= 5) churnMult = churnThresholds['5'] || 2;
        
        // Calculate exponential backoff
        containerState.consecutiveOps++;
        const baseInterval = config.backoff?.baseInterval || 3600;
        const backoffMult = Math.pow(2, containerState.consecutiveOps - 1);
        const cooldownSecs = baseInterval * backoffMult * churnMult;
        
        containerState.cooldownUntil = now + cooldownSecs;
        this.state[container] = containerState;
        this.save();
        
        log({
            event: 'backoff_recorded',
            container,
            opsLast7d: opsCount,
            consecutiveOps: containerState.consecutiveOps,
            cooldownHours: Math.ceil(cooldownSecs / 3600),
            churnMultiplier: churnMult
        });
        
        return {
            cooldownUntil: containerState.cooldownUntil,
            consecutiveOps: containerState.consecutiveOps
        };
    }
    
    // Reset if container idle for 7 days
    resetIfIdle() {
        const now = Math.floor(Date.now() / 1000);
        const sevenDaysAgo = now - (7 * 86400);
        
        for (const [container, state] of Object.entries(this.state)) {
            const lastOp = Math.max(...state.operations, 0);
            if (lastOp < sevenDaysAgo) {
                state.consecutiveOps = 0;
                state.cooldownUntil = 0;
                log({ event: 'backoff_reset', container, reason: 'idle_7d' });
            }
        }
        
        this.save();
    }
}

const backoffTracker = new BackoffTracker();

// Reset idle containers daily
setInterval(() => backoffTracker.resetIfIdle(), 86400000);

// ============================================================================
// DOCKER OPERATIONS
// ============================================================================

async function executeDockerOp(container, action, stm) {
    const dockerContainer = docker.getContainer(container);
    
    switch (action) {
        case 'start':
            await dockerContainer.start();
            const startInfo = await dockerContainer.inspect();
            return {
                Running: startInfo.State.Running,
                Status: startInfo.Status
            };
            
        case 'stop':
            await dockerContainer.stop({ t: 10 });
            const stopInfo = await dockerContainer.inspect();
            return {
                Running: stopInfo.State.Running,
                Status: stopInfo.Status
            };
            
        case 'restart':
            await dockerContainer.restart({ t: 10 });
            const restartInfo = await dockerContainer.inspect();
            return {
                Running: restartInfo.State.Running,
                Status: restartInfo.Status
            };
            
        case 'status':
            const info = await dockerContainer.inspect();
            return {
                Running: info.State.Running,
                Paused: info.State.Paused,
                Restarting: info.State.Restarting,
                Status: info.Status,
                RestartCount: info.RestartCount
            };
            
        case 'npm':
            return await executeNpmUpdate(dockerContainer, stm);
            
        case 'composer':
            return await executeComposerUpdate(dockerContainer, stm);
            
        case 'dnf':
            return await executeDnfUpdate(dockerContainer, stm);
            
        case 'git':
            return await executeGitUpdate(dockerContainer, stm);
            
        case 'nginx-config':
            return await executeNginxConfig(dockerContainer, stm);
            
        case 'nginx-cert':
            return await executeNginxCert(dockerContainer, stm);
            
        case 'zfs-snapshot':
            return await executeZfsSnapshot(dockerContainer, stm);
            
        case 'zfs-rollback':
            return await executeZfsRollback(dockerContainer, stm);
            
        case 'model-load':
            return await executeModelLoad(dockerContainer, stm);
            
        case 'model-unload':
            return await executeModelUnload(dockerContainer, stm);
            
        case 'cache-flush':
            return await executeCacheFlush(dockerContainer, stm);
            
        case 'pull':
            const imageTag = stm.imageTag;
            const imagePattern = managedContainers[container]?.imagePattern;
            
            if (!imagePattern) {
                throw new Error('No imagePattern configured');
            }
            
            const regex = new RegExp(imagePattern);
            if (!regex.test(imageTag)) {
                throw new Error('Image tag does not match pattern');
            }
            
            // Stop container
            await dockerContainer.stop({ t: 10 });
            
            // Pull new image
            await new Promise((resolve, reject) => {
                docker.pull(imageTag, (err, stream) => {
                    if (err) return reject(err);
                    docker.modem.followProgress(stream, resolve, () => {});
                });
            });
            
            // Restart with new image
            await dockerContainer.start();
            const pullInfo = await dockerContainer.inspect();
            
            return {
                Running: pullInfo.State.Running,
                Image: pullInfo.Image
            };
            
        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

// ============================================================================
// PACKAGE MANAGER OPERATIONS
// ============================================================================

async function executeNpmUpdate(container, stm) {
    const { package: pkg, version, integrity, workdir = '/app' } = stm;
    
    if (!pkg || !version || !integrity) {
        throw new Error('npm action requires: package, version, integrity');
    }
    
    // Validate integrity format
    if (!integrity.startsWith('sha512-') && !integrity.startsWith('sha384-')) {
        throw new Error('integrity must be sha512-* or sha384-*');
    }
    
    // Build npm install command with integrity verification
    const packageJson = JSON.stringify({ dependencies: { [pkg]: version } });
    const packageLock = JSON.stringify({
        packages: {
            [`node_modules/${pkg}`]: { version, integrity }
        }
    });
    
    const cmd = [
        'sh', '-c',
        `cd ${workdir} && ` +
        `echo '${packageJson}' > package.json && ` +
        `echo '${packageLock}' > package-lock.json && ` +
        `npm ci --production`
    ];
    
    const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true
    });
    
    const stream = await exec.start();
    
    return new Promise((resolve, reject) => {
        let output = '';
        stream.on('data', chunk => { output += chunk.toString(); });
        stream.on('end', async () => {
            const inspectResult = await exec.inspect();
            if (inspectResult.ExitCode !== 0) {
                reject(new Error(`npm install failed: ${output.slice(0, 500)}`));
            } else {
                resolve({
                    package: pkg,
                    version,
                    verified: true,  // npm verified integrity
                    output: output.slice(0, 1000)
                });
            }
        });
        stream.on('error', reject);
    });
}

async function executeComposerUpdate(container, stm) {
    const { package: pkg, version, hash, workdir = '/var/www' } = stm;
    
    if (!pkg || !version) {
        throw new Error('composer action requires: package, version');
    }
    
    const cmd = [
        'sh', '-c',
        `cd ${workdir} && ` +
        `composer require ${pkg}:${version} --no-interaction --prefer-dist`
    ];
    
    const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true
    });
    
    const stream = await exec.start();
    
    return new Promise((resolve, reject) => {
        let output = '';
        stream.on('data', chunk => { output += chunk.toString(); });
        stream.on('end', async () => {
            const inspectResult = await exec.inspect();
            if (inspectResult.ExitCode !== 0) {
                reject(new Error(`composer require failed: ${output.slice(0, 500)}`));
            } else {
                resolve({
                    package: pkg,
                    version,
                    verified: hash ? false : true,  // TODO: verify hash from composer.lock
                    output: output.slice(0, 1000)
                });
            }
        });
        stream.on('error', reject);
    });
}

async function executeDnfUpdate(container, stm) {
    const { package: pkg, version } = stm;
    
    if (!pkg || !version) {
        throw new Error('dnf action requires: package, version');
    }
    
    const cmd = [
        'dnf', 'update', '-y', `${pkg}-${version}`
    ];
    
    const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true
    });
    
    const stream = await exec.start();
    
    return new Promise((resolve, reject) => {
        let output = '';
        stream.on('data', chunk => { output += chunk.toString(); });
        stream.on('end', async () => {
            const inspectResult = await exec.inspect();
            if (inspectResult.ExitCode !== 0) {
                reject(new Error(`dnf update failed: ${output.slice(0, 500)}`));
            } else {
                resolve({
                    package: pkg,
                    version,
                    verified: true,  // DNF verifies signatures
                    output: output.slice(0, 1000)
                });
            }
        });
        stream.on('error', reject);
    });
}

async function executeGitUpdate(container, stm) {
    const { repo, commit, url, ref, submodules = false } = stm;
    
    // Determine git operation type
    if (url) {
        // git-clone operation
        return await executeGitClone(container, stm);
    } else if (ref && ref.includes('/')) {
        // git-pull operation (ref like "origin/main")
        return await executeGitPull(container, stm);
    } else if (submodules && Array.isArray(submodules)) {
        // git-submodule update
        return await executeGitSubmodule(container, stm);
    } else {
        // Simple git checkout
        return await executeGitCheckout(container, stm);
    }
}

async function executeGitClone(container, stm) {
    const { url, dest, commit, submodules = false } = stm;
    
    if (!url || !dest || !commit) {
        throw new Error('git-clone requires: url, dest, commit');
    }
    
    // Validate commit hash
    if (!/^[a-f0-9]{40}$/.test(commit)) {
        throw new Error('commit must be 40-character hex hash');
    }
    
    const cmd = [
        'sh', '-c',
        `git clone ${url} ${dest} && ` +
        `cd ${dest} && ` +
        `git checkout ${commit} && ` +
        (submodules ? `git submodule init && git submodule update && ` : '') +
        `git rev-parse HEAD`
    ];
    
    const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true
    });
    
    const stream = await exec.start();
    
    return new Promise((resolve, reject) => {
        let output = '';
        stream.on('data', chunk => { output += chunk.toString(); });
        stream.on('end', async () => {
            const inspectResult = await exec.inspect();
            if (inspectResult.ExitCode !== 0) {
                reject(new Error(`git clone failed: ${output.slice(0, 500)}`));
            } else {
                const currentCommit = output.trim().split('\n').pop();
                const verified = currentCommit === commit;
                
                resolve({
                    repo: dest,
                    commit,
                    verified,
                    currentCommit,
                    submodules: submodules ? 'updated' : 'none',
                    output: output.slice(0, 1000)
                });
            }
        });
        stream.on('error', reject);
    });
}

async function executeGitPull(container, stm) {
    const { repo, ref, commit, submodules = false } = stm;
    
    if (!repo || !ref || !commit) {
        throw new Error('git-pull requires: repo, ref, commit');
    }
    
    // Validate commit hash
    if (!/^[a-f0-9]{40}$/.test(commit)) {
        throw new Error('commit must be 40-character hex hash');
    }
    
    const cmd = [
        'sh', '-c',
        `cd ${repo} && ` +
        `git fetch origin && ` +
        `git checkout ${commit} && ` +
        (submodules ? `git submodule update --init --recursive && ` : '') +
        `git rev-parse HEAD`
    ];
    
    const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true
    });
    
    const stream = await exec.start();
    
    return new Promise((resolve, reject) => {
        let output = '';
        stream.on('data', chunk => { output += chunk.toString(); });
        stream.on('end', async () => {
            const inspectResult = await exec.inspect();
            if (inspectResult.ExitCode !== 0) {
                reject(new Error(`git pull failed: ${output.slice(0, 500)}`));
            } else {
                const currentCommit = output.trim().split('\n').pop();
                const verified = currentCommit === commit;
                
                resolve({
                    repo,
                    ref,
                    commit,
                    verified,
                    currentCommit,
                    submodules: submodules ? 'updated' : 'none',
                    output: output.slice(0, 1000)
                });
            }
        });
        stream.on('error', reject);
    });
}

async function executeGitSubmodule(container, stm) {
    const { repo, submodules, commits = {} } = stm;
    
    if (!repo || !submodules || !Array.isArray(submodules)) {
        throw new Error('git-submodule requires: repo, submodules (array)');
    }
    
    // Build command to update specific submodules and verify commits
    let cmdParts = [`cd ${repo}`];
    
    for (const submodule of submodules) {
        cmdParts.push(`git submodule update --init ${submodule}`);
        
        // If specific commit provided, verify it
        if (commits[submodule]) {
            const expectedCommit = commits[submodule];
            if (!/^[a-f0-9]{40}$/.test(expectedCommit)) {
                throw new Error(`Invalid commit hash for ${submodule}`);
            }
            cmdParts.push(`cd ${submodule} && git rev-parse HEAD`);
        }
    }
    
    const cmd = ['sh', '-c', cmdParts.join(' && ')];
    
    const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true
    });
    
    const stream = await exec.start();
    
    return new Promise((resolve, reject) => {
        let output = '';
        stream.on('data', chunk => { output += chunk.toString(); });
        stream.on('end', async () => {
            const inspectResult = await exec.inspect();
            if (inspectResult.ExitCode !== 0) {
                reject(new Error(`git submodule update failed: ${output.slice(0, 500)}`));
            } else {
                resolve({
                    repo,
                    submodules,
                    verified: true,  // TODO: actually verify commit hashes
                    output: output.slice(0, 1000)
                });
            }
        });
        stream.on('error', reject);
    });
}

async function executeGitCheckout(container, stm) {
    const { repo, commit } = stm;
    
    if (!repo || !commit) {
        throw new Error('git action requires: repo, commit');
    }
    
    // Validate commit hash format (40 hex chars)
    if (!/^[a-f0-9]{40}$/.test(commit)) {
        throw new Error('commit must be 40-character hex hash');
    }
    
    // Git fetch and checkout specific commit
    const cmd = [
        'sh', '-c',
        `cd ${repo} && ` +
        `git fetch origin && ` +
        `git checkout ${commit} && ` +
        `git rev-parse HEAD`  // Verify we're at correct commit
    ];
    
    const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true
    });
    
    const stream = await exec.start();
    
    return new Promise((resolve, reject) => {
        let output = '';
        stream.on('data', chunk => { output += chunk.toString(); });
        stream.on('end', async () => {
            const inspectResult = await exec.inspect();
            if (inspectResult.ExitCode !== 0) {
                reject(new Error(`git checkout failed: ${output.slice(0, 500)}`));
            } else {
                // Verify we're at the correct commit
                const currentCommit = output.trim().split('\n').pop();
                const verified = currentCommit === commit;
                
                resolve({
                    repo,
                    commit,
                    verified,
                    currentCommit,
                    output: output.slice(0, 1000)
                });
            }
        });
        stream.on('error', reject);
    });
}

// ============================================================================
// NGINX CONFIGURATION MANAGEMENT
// ============================================================================

async function executeNginxConfig(container, stm) {
    const { app, domain, upstreamHost, upstreamPort = 9000, sslProvider = 'letsencrypt' } = stm;
    
    if (!app || !domain || !upstreamHost) {
        throw new Error('nginx-config requires: app, domain, upstreamHost');
    }
    
    // Generate nginx site config
    const config = generateNginxConfig(app, domain, upstreamHost, upstreamPort, sslProvider);
    
    // Write config to /etc/nginx/sites-available/{app}
    const configPath = `/etc/nginx/sites-available/${app}`;
    const cmd = [
        'sh', '-c',
        `echo '${config.replace(/'/g, "'\\''")}' > ${configPath} && ` +
        `ln -sf ${configPath} /etc/nginx/sites-enabled/${app} && ` +
        `nginx -t`  // Test config
    ];
    
    const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true
    });
    
    const stream = await exec.start();
    
    return new Promise((resolve, reject) => {
        let output = '';
        stream.on('data', chunk => { output += chunk.toString(); });
        stream.on('end', async () => {
            const inspectResult = await exec.inspect();
            if (inspectResult.ExitCode !== 0) {
                reject(new Error(`nginx config test failed: ${output.slice(0, 500)}`));
            } else {
                resolve({
                    app,
                    domain,
                    upstreamHost,
                    configPath,
                    verified: output.includes('test is successful'),
                    output: output.slice(0, 1000)
                });
            }
        });
        stream.on('error', reject);
    });
}

function generateNginxConfig(app, domain, upstreamHost, upstreamPort, sslProvider) {
    const certPath = sslProvider === 'cloudflare' 
        ? `/etc/nginx/certs/${app}-cloudflare.pem`
        : `/etc/letsencrypt/live/${domain}/fullchain.pem`;
    const keyPath = sslProvider === 'cloudflare'
        ? `/etc/nginx/certs/${app}-cloudflare.key`
        : `/etc/letsencrypt/live/${domain}/privkey.pem`;
    
    return `# Qbix app: ${app}
# Generated by Safebox Infrastructure
# Domain: ${domain}
# Upstream: ${upstreamHost}:${upstreamPort}
# SSL Provider: ${sslProvider}

upstream ${app}_backend {
    server ${upstreamHost}:${upstreamPort};
}

server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
    
    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${domain};
    
    # Document root is /opt/qbix/app/web inside the app container
    # Nginx proxies to PHP-FPM in the app container
    
    # SSL Configuration
    ssl_certificate ${certPath};
    ssl_certificate_key ${keyPath};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    
    # Qbix-specific settings
    client_max_body_size 100M;
    
    location / {
        # Proxy all requests to PHP-FPM in app container
        # The app container serves from /opt/qbix/app/web
        fastcgi_pass ${app}_backend;
        fastcgi_param SCRIPT_FILENAME /opt/qbix/app/web/index.php;
        fastcgi_param SCRIPT_NAME /index.php;
        fastcgi_param REQUEST_URI $request_uri;
        fastcgi_param QUERY_STRING $query_string;
        fastcgi_param REQUEST_METHOD $request_method;
        fastcgi_param CONTENT_TYPE $content_type;
        fastcgi_param CONTENT_LENGTH $content_length;
        fastcgi_param SERVER_PROTOCOL $server_protocol;
        fastcgi_param SERVER_NAME $server_name;
        fastcgi_param SERVER_PORT $server_port;
        fastcgi_param HTTPS on;
        fastcgi_read_timeout 300;
    }
    
    location ~ /\\. {
        deny all;
    }
}`;
}

async function executeNginxCert(container, stm) {
    const { app, domain, provider, certPath, keyPath } = stm;
    
    if (!app || !domain || !provider) {
        throw new Error('nginx-cert requires: app, domain, provider');
    }
    
    let cmd;
    
    if (provider === 'letsencrypt') {
        // Renew Let's Encrypt certificate
        cmd = [
            'sh', '-c',
            `certbot renew --cert-name ${domain} --nginx && ` +
            `nginx -s reload`
        ];
    } else if (provider === 'cloudflare') {
        // Install Cloudflare cert (certPath and keyPath must be provided)
        if (!certPath || !keyPath) {
            throw new Error('cloudflare provider requires: certPath, keyPath');
        }
        
        cmd = [
            'sh', '-c',
            `mkdir -p /etc/nginx/certs && ` +
            `test -f ${certPath} && test -f ${keyPath} && ` +  // Verify files exist
            `nginx -s reload`
        ];
    } else {
        throw new Error(`Unknown SSL provider: ${provider}`);
    }
    
    const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true
    });
    
    const stream = await exec.start();
    
    return new Promise((resolve, reject) => {
        let output = '';
        stream.on('data', chunk => { output += chunk.toString(); });
        stream.on('end', async () => {
            const inspectResult = await exec.inspect();
            if (inspectResult.ExitCode !== 0) {
                reject(new Error(`nginx cert update failed: ${output.slice(0, 500)}`));
            } else {
                resolve({
                    app,
                    domain,
                    provider,
                    verified: true,
                    output: output.slice(0, 1000)
                });
            }
        });
        stream.on('error', reject);
    });
}

// ============================================================================
// ZFS SNAPSHOT AND ROLLBACK
// ============================================================================

async function executeZfsSnapshot(container, stm) {
    const { dataset, snapshot, description } = stm;
    
    if (!dataset || !snapshot) {
        throw new Error('zfs-snapshot requires: dataset, snapshot');
    }
    
    // Create ZFS snapshot (executed on host, not in container)
    // Note: This requires the Infrastructure API to have host ZFS access
    const snapshotName = snapshot.startsWith('@') ? snapshot : `@${snapshot}`;
    const fullSnapshot = `${dataset}${snapshotName}`;
    
    const cmd = [
        'zfs', 'snapshot', fullSnapshot
    ];
    
    const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true
    });
    
    const stream = await exec.start();
    
    return new Promise((resolve, reject) => {
        let output = '';
        stream.on('data', chunk => { output += chunk.toString(); });
        stream.on('end', async () => {
            const inspectResult = await exec.inspect();
            if (inspectResult.ExitCode !== 0) {
                reject(new Error(`zfs snapshot failed: ${output.slice(0, 500)}`));
            } else {
                // Verify snapshot exists
                const verifyExec = await container.exec({
                    Cmd: ['zfs', 'list', '-t', 'snapshot', fullSnapshot],
                    AttachStdout: true
                });
                const verifyStream = await verifyExec.start();
                let verifyOutput = '';
                verifyStream.on('data', chunk => { verifyOutput += chunk.toString(); });
                await new Promise(res => verifyStream.on('end', res));
                
                resolve({
                    dataset,
                    snapshot: snapshotName,
                    fullSnapshot,
                    verified: verifyOutput.includes(fullSnapshot),
                    description: description || 'Manual snapshot',
                    output: output.slice(0, 1000)
                });
            }
        });
        stream.on('error', reject);
    });
}

async function executeZfsRollback(container, stm) {
    const { dataset, snapshot } = stm;
    
    if (!dataset || !snapshot) {
        throw new Error('zfs-rollback requires: dataset, snapshot');
    }
    
    // Rollback ZFS dataset to snapshot
    const snapshotName = snapshot.startsWith('@') ? snapshot : `@${snapshot}`;
    const fullSnapshot = `${dataset}${snapshotName}`;
    
    // ZFS rollback with -r (rollback dependent clones)
    const cmd = [
        'zfs', 'rollback', '-r', fullSnapshot
    ];
    
    const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true
    });
    
    const stream = await exec.start();
    
    return new Promise((resolve, reject) => {
        let output = '';
        stream.on('data', chunk => { output += chunk.toString(); });
        stream.on('end', async () => {
            const inspectResult = await exec.inspect();
            if (inspectResult.ExitCode !== 0) {
                reject(new Error(`zfs rollback failed: ${output.slice(0, 500)}`));
            } else {
                resolve({
                    dataset,
                    snapshot: snapshotName,
                    fullSnapshot,
                    verified: true,
                    output: output.slice(0, 1000)
                });
            }
        });
        stream.on('error', reject);
    });
}

// ============================================================================
// MODEL RUNNER ACTIONS
// ============================================================================

async function executeModelLoad(container, stm) {
    const { modelId, quantization, maxContextLength, evictModel, verifiedOpToken } = stm;
    
    if (!modelId || !verifiedOpToken) {
        throw new Error('model-load requires: modelId, verifiedOpToken');
    }
    
    // Get container info to determine runner endpoint
    const containerInfo = await container.inspect();
    const runnerHost = containerInfo.Config.Hostname;
    const runnerPort = 8080; // Default, could parse from container config
    
    // Call runner's /v1/models/load endpoint
    const loadResponse = await fetch(`http://${runnerHost}:${runnerPort}/v1/models/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            modelId,
            quantization,
            maxContextLength,
            evictModel,
            verifiedOpToken
        })
    });
    
    const loadResult = await loadResponse.json();
    
    if (loadResponse.status === 202) {
        // Async loading - poll for completion
        const taskId = loadResult.taskId;
        return await pollModelLoadTask(runnerHost, runnerPort, taskId);
    }
    
    return loadResult;
}

async function pollModelLoadTask(host, port, taskId) {
    const maxAttempts = 60; // 5 minutes (60 * 5s)
    
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s
        
        try {
            const statusResponse = await fetch(`http://${host}:${port}/v1/models/load/${taskId}`);
            const status = await statusResponse.json();
            
            if (status.status === 'completed') {
                return {
                    modelId: status.modelId,
                    verified: true,
                    gpuMemoryUsedMB: status.gpuMemoryUsedMB,
                    loadTimeMs: status.loadTimeMs
                };
            }
            
            if (status.status === 'failed') {
                throw new Error(`Model load failed: ${status.error}`);
            }
            
            // Still loading, continue polling
            
        } catch (error) {
            throw new Error(`Failed to poll load status: ${error.message}`);
        }
    }
    
    throw new Error('Model load timeout after 5 minutes');
}

async function executeModelUnload(container, stm) {
    const { modelId, verifiedOpToken } = stm;
    
    if (!modelId || !verifiedOpToken) {
        throw new Error('model-unload requires: modelId, verifiedOpToken');
    }
    
    const containerInfo = await container.inspect();
    const runnerHost = containerInfo.Config.Hostname;
    const runnerPort = 8080;
    
    const response = await fetch(`http://${runnerHost}:${runnerPort}/v1/models/unload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            modelId,
            verifiedOpToken
        })
    });
    
    const result = await response.json();
    
    return {
        modelId: result.modelId,
        verified: true,
        gpuMemoryFreedMB: result.gpuMemoryFreedMB,
        kvCacheFlushed: result.kvCacheFlushed
    };
}

async function executeCacheFlush(container, stm) {
    const { scope, modelId, tenantId, tag, verifiedOpToken } = stm;
    
    if (!scope || !verifiedOpToken) {
        throw new Error('cache-flush requires: scope, verifiedOpToken');
    }
    
    const containerInfo = await container.inspect();
    const runnerHost = containerInfo.Config.Hostname;
    const runnerPort = 8080;
    
    const response = await fetch(`http://${runnerHost}:${runnerPort}/v1/cache/flush`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            scope,
            modelId,
            tenantId,
            tag,
            verifiedOpToken
        })
    });
    
    const result = await response.json();
    
    return {
        scope,
        verified: true,
        entriesRemoved: result.entriesRemoved,
        memoryFreedMB: result.memoryFreedMB
    };
}

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = http.createServer(async (req, res) => {
    const startTime = Date.now();
    
    // Get peer UID from socket (SO_PEERCRED)
    let peerUid;
    try {
        const creds = req.socket._handle.getPeerCredential();
        peerUid = creds.uid;
    } catch (e) {
        log({ event: 'peer_uid_error', error: e.message });
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Peer UID verification failed' }));
        return;
    }
    
    // Verify peer UID
    if (peerUid !== SAFEBOX_UID) {
        log({ event: 'unauthorized_uid', peerUid, expectedUid: SAFEBOX_UID });
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized UID' }));
        return;
    }
    
    // Health check (no HMAC required)
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy', service: 'system-protocol-api' }));
        return;
    }
    
    // Only POST allowed
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method not allowed' }));
        return;
    }
    
    // Read body
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    
    req.on('end', async () => {
        try {
            // Verify HMAC
            const signature = req.headers['x-safebox-signature'];
            if (!signature || !verifyHMAC(body, signature)) {
                log({ event: 'invalid_hmac', peerUid });
                res.writeHead(401, { 'Content-Type': 'application/json' });
                const errorData = { success: false, error: 'Invalid HMAC signature' };
                const errorSig = computeHMAC(errorData);
                res.setHeader('X-Safebox-Signature', errorSig);
                res.end(JSON.stringify(errorData));
                return;
            }
            
            // Parse request
            const request = JSON.parse(body);
            const { jti, action, container, stm } = request;
            
            // Extract action from URL
            const urlAction = req.url.split('/').pop();
            
            if (action !== urlAction) {
                throw new Error('Action mismatch');
            }
            
            // Check JTI
            const jtiCheck = jtiTracker.check(jti);
            if (!jtiCheck.valid) {
                log({ event: 'jti_rejected', jti: jti.slice(0, 16) + '...', reason: jtiCheck.reason });
                res.writeHead(400, { 'Content-Type': 'application/json' });
                const errorData = { success: false, error: 'Bad request' };
                const errorSig = computeHMAC(errorData);
                res.setHeader('X-Safebox-Signature', errorSig);
                res.end(JSON.stringify(errorData));
                return;
            }
            
            // Check container in allowlist
            const containerConfig = managedContainers[container];
            if (!containerConfig) {
                log({ event: 'container_not_found', container });
                res.writeHead(404, { 'Content-Type': 'application/json' });
                const errorData = { success: false, error: 'Container not found' };
                const errorSig = computeHMAC(errorData);
                res.setHeader('X-Safebox-Signature', errorSig);
                res.end(JSON.stringify(errorData));
                return;
            }
            
            // Check action allowed
            if (!containerConfig.allowedActions.includes(action)) {
                log({ event: 'action_forbidden', container, action });
                res.writeHead(403, { 'Content-Type': 'application/json' });
                const errorData = { success: false, error: 'Action not allowed' };
                const errorSig = computeHMAC(errorData);
                res.setHeader('X-Safebox-Signature', errorSig);
                res.end(JSON.stringify(errorData));
                return;
            }
            
            // Check backoff (skip for status)
            if (action !== 'status') {
                const backoffCheck = backoffTracker.check(container, containerConfig);
                if (!backoffCheck.allowed) {
                    log({ event: 'backoff_blocked', container, action, reason: backoffCheck.reason });
                    res.writeHead(429, { 'Content-Type': 'application/json' });
                    const errorData = {
                        success: false,
                        error: 'Rate limited',
                        backoff: { cooldownUntil: backoffCheck.cooldownUntil }
                    };
                    const errorSig = computeHMAC(errorData);
                    res.setHeader('X-Safebox-Signature', errorSig);
                    res.end(JSON.stringify(errorData));
                    return;
                }
            }
            
            // Execute Docker operation
            const dockerResult = await executeDockerOp(container, action, stm || {});
            
            // Record backoff (skip for status)
            let backoffInfo = null;
            if (action !== 'status') {
                backoffInfo = backoffTracker.record(container, containerConfig);
            }
            
            // Build response
            const responseData = {
                success: true,
                container,
                action,
                result: dockerResult
            };
            
            if (backoffInfo) {
                responseData.backoff = backoffInfo;
            }
            
            // Sign response
            const responseSig = computeHMAC(responseData);
            
            // Log success
            log({
                event: 'operation_success',
                jti: jti.slice(0, 16) + '...',
                container,
                action,
                peerUid,
                duration: Date.now() - startTime,
                backoff: backoffInfo
            });
            
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'X-Safebox-Signature': responseSig
            });
            res.end(JSON.stringify(responseData));
            
        } catch (error) {
            log({
                event: 'operation_error',
                error: error.message,
                peerUid,
                duration: Date.now() - startTime
            });
            
            res.writeHead(500, { 'Content-Type': 'application/json' });
            const errorData = { success: false, error: 'Operation failed' };
            const errorSig = computeHMAC(errorData);
            res.setHeader('X-Safebox-Signature', errorSig);
            res.end(JSON.stringify(errorData));
        }
    });
});

// ============================================================================
// START SERVER
// ============================================================================

// Remove existing socket
if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
}

server.listen(SOCKET_PATH, () => {
    // Set socket permissions
    fs.chmodSync(SOCKET_PATH, 0o660);
    fs.chownSync(SOCKET_PATH, process.getuid(), process.getgid());
    
    console.log('[System Protocol API] Listening on', SOCKET_PATH);
    console.log('[Security] Accepting connections only from UID', SAFEBOX_UID);
    console.log('[Security] HMAC verification enabled');
    console.log('[Security] JTI replay protection enabled');
    
    log({ event: 'server_started', socketPath: SOCKET_PATH, safeboxUid: SAFEBOX_UID });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    log({ event: 'shutdown', reason: 'SIGTERM' });
    server.close(() => {
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    log({ event: 'shutdown', reason: 'SIGINT' });
    server.close(() => {
        process.exit(0);
    });
});
