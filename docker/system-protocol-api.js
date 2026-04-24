#!/usr/bin/env node
/**
 * Safebox System Protocol API
 * M-of-N OpenClaim governance for Docker container management
 */

const express = require('express');
const bodyParser = require('body-parser');
const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');

const PORT = 4000;
const CONFIG_DIR = '/config';
const STATE_DIR = '/state';
const BACKOFF_STATE_DIR = path.join(STATE_DIR, 'backoff');

if (!fs.existsSync(BACKOFF_STATE_DIR)) {
    fs.mkdirSync(BACKOFF_STATE_DIR, { recursive: true });
}

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

class ExponentialBackoffTracker {
    constructor(containerName) {
        this.containerName = containerName;
        this.statePath = path.join(BACKOFF_STATE_DIR, `${containerName}.json`);
        this.state = this.loadState();
    }
    
    loadState() {
        try {
            if (fs.existsSync(this.statePath)) {
                return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
            }
        } catch (e) {}
        return { operations: [], cooldownUntil: 0, consecutiveOps: 0 };
    }
    
    saveState() {
        fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    }
    
    verifyOperationAllowed(now) {
        if (this.state.cooldownUntil > now) {
            const hrs = Math.ceil((this.state.cooldownUntil - now) / 3600);
            throw new Error(`Cooldown: ${hrs} hours remaining`);
        }
    }
    
    recordOperation(now, baseInterval) {
        const sevenDaysAgo = now - (7 * 86400);
        this.state.operations = this.state.operations.filter(op => op > sevenDaysAgo);
        this.state.operations.push(now);
        
        const opsCount = this.state.operations.length;
        let churnMult = opsCount >= 15 ? 4 : opsCount >= 10 ? 3 : opsCount >= 5 ? 2 : 1;
        
        this.state.consecutiveOps++;
        const backoffMult = Math.pow(2, this.state.consecutiveOps - 1);
        const cooldownSecs = baseInterval * backoffMult * churnMult;
        
        this.state.cooldownUntil = now + cooldownSecs;
        this.saveState();
        
        console.log(`[${this.containerName}] ${opsCount} ops/7d, cooldown ${Math.ceil(cooldownSecs/3600)}h (${churnMult}x churn)`);
    }
}

function loadContainerRegistry() {
    try {
        return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'container-registry.json'), 'utf8'));
    } catch (e) {
        return {};
    }
}

async function executeDockerOp(containerName, action, params) {
    const container = docker.getContainer(containerName);
    switch (action) {
        case 'start':
            await container.start();
            return { action: 'start' };
        case 'stop':
            await container.stop({ t: 10 });
            return { action: 'stop' };
        case 'restart':
            await container.restart({ t: 10 });
            return { action: 'restart' };
        case 'exec':
            const cmd = params.command || [];
            const exec = await container.exec({
                Cmd: Array.isArray(cmd) ? cmd : ['/bin/sh', '-c', cmd],
                AttachStdout: true,
                AttachStderr: true
            });
            const stream = await exec.start();
            return new Promise((resolve) => {
                let output = '';
                stream.on('data', chunk => { output += chunk.toString(); });
                stream.on('end', () => resolve({ action: 'exec', output }));
            });
        case 'status':
            const info = await container.inspect();
            return { action: 'status', state: info.State };
        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

app.get('/health', (req, res) => res.json({ status: 'healthy' }));

app.post('/container/:action', async (req, res) => {
    try {
        const { action } = req.params;
        const claim = req.body;
        const containerName = claim.stm?.container;
        
        if (!containerName) {
            return res.status(400).json({ error: 'Missing container' });
        }
        
        const registry = loadContainerRegistry();
        const config = registry[containerName];
        
        if (!config) {
            return res.status(404).json({ error: `Unknown container: ${containerName}` });
        }
        
        // NOTE: Full OpenClaim verification happens in Safebox.Protocol.System (PHP)
        
        if (config.governance?.exponentialBackoff && 
            ['start', 'stop', 'restart', 'exec'].includes(action)) {
            
            const tracker = new ExponentialBackoffTracker(containerName);
            const now = claim.stm?.issuedAt || Math.floor(Date.now() / 1000);
            
            tracker.verifyOperationAllowed(now);
            
            const result = await executeDockerOp(containerName, action, claim.stm?.params || {});
            
            const baseInterval = config.governance?.rateLimit?.intervalSeconds || 3600;
            tracker.recordOperation(now, baseInterval);
            
            return res.json({
                success: true,
                container: containerName,
                result,
                backoff: {
                    cooldownUntil: tracker.state.cooldownUntil,
                    consecutiveOps: tracker.state.consecutiveOps
                }
            });
        } else {
            const result = await executeDockerOp(containerName, action, claim.stm?.params || {});
            return res.json({ success: true, container: containerName, result });
        }
        
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`System Protocol API on port ${PORT} (bind to localhost via Docker)`);
});
