# Safebox Multi-Tenant Architecture

## Overview

Safebox implements a secure, multi-tenant hosting platform on Amazon Linux 2023 with:
- **Triple-layer encryption**: Nitro RAM + EBS + File-level
- **TPM measured boot**: Attestation-gated key provisioning
- **Tenant isolation**: Linux users, PHP-FPM pools, dedicated Node.js processes
- **On-demand scaling**: Auto-spawn/shutdown workers based on activity
- **Deterministic builds**: Byte-identical AMI reproducibility

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Internet / CDN                          │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTPS
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                     Nginx (Reverse Proxy)                    │
│  ┌────────────┬────────────┬────────────┬──────────────┐   │
│  │ tenant1    │ tenant2    │ tenant3    │   ...        │   │
│  │ .conf      │ .conf      │ .conf      │              │   │
│  └────────────┴────────────┴────────────┴──────────────┘   │
└───────────┬──────────────┬──────────────────────────────────┘
            │              │
            │ PHP          │ /api/* → Node.js
            ▼              ▼
┌───────────────────┐  ┌──────────────────────────────────────┐
│   PHP-FPM Pools   │  │       Node.js Processes              │
│                   │  │                                      │
│ ┌───────────────┐ │  │ ┌──────────────────────────────────┐│
│ │ [tenant1]     │ │  │ │ tenant1-node.service             ││
│ │ user=tenant1  │ │  │ │ port: 3001                       ││
│ │ pm=ondemand   │ │  │ │ user: tenant1                    ││
│ │ max=3 workers │ │  │ │ idle_timeout: 5min               ││
│ │ idle: 5min    │ │  │ └──────────────────────────────────┘│
│ └───────────────┘ │  │                                      │
│                   │  │ ┌──────────────────────────────────┐│
│ ┌───────────────┐ │  │ │ tenant2-node.service             ││
│ │ [tenant2]     │ │  │ │ port: 3002                       ││
│ │ user=tenant2  │ │  │ │ user: tenant2                    ││
│ │ pm=ondemand   │ │  │ └──────────────────────────────────┘│
│ └───────────────┘ │  └──────────────────────────────────────┘
└─────────┬─────────┘              │
          │                        │
          │                        │ Internal socket
          ▼                        ▼
┌─────────────────────────────────────────────────────────────┐
│              Safebox Encryption Layer (FLE)                  │
│                                                              │
│  Transparent AES-256-GCM encryption for all file writes     │
│  Key source: TPM-sealed, provisioned after attestation      │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Encrypted Filesystem                               │   │
│  │                                                      │   │
│  │  /srv/encrypted/                                    │   │
│  │  ├── mysql/          (MariaDB datadir)              │   │
│  │  ├── tenants/                                       │   │
│  │  │   ├── tenant1/   (uploads, sessions, data)      │   │
│  │  │   ├── tenant2/                                   │   │
│  │  │   └── ...                                        │   │
│  │  ├── backups/       (XtraBackup streams)           │   │
│  │  └── logs/          (audit logs)                    │   │
│  └─────────────────────────────────────────────────────┘   │
└───────────────────────────┬─────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Encrypted EBS Volume                      │
│                     AES-256 encryption                       │
└───────────────────────────┬─────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              AWS Nitro System (Hardware)                     │
│          RAM encryption + TPM + Attestation                  │
└─────────────────────────────────────────────────────────────┘
```

## Tenant Isolation Model

### Linux User Isolation
Each tenant runs as a dedicated Linux user:
```bash
tenant1:x:1001:1001:Safebox Tenant 1:/home/tenant1:/bin/bash
tenant2:x:1002:1002:Safebox Tenant 2:/home/tenant2:/bin/bash
tenant3:x:1003:1003:Safebox Tenant 3:/home/tenant3:/bin/bash
```

### Directory Structure
```
/srv/safebox/tenants/
├── tenant1/
│   ├── public/          # Nginx document root
│   │   ├── index.php
│   │   └── assets/
│   ├── app/             # Application code
│   │   ├── controllers/
│   │   ├── models/
│   │   └── views/
│   ├── node/            # Node.js backend
│   │   ├── server.js
│   │   └── package.json
│   ├── logs/            # Tenant-specific logs
│   └── tmp/             # Upload temp directory
└── tenant2/
    └── ...

/srv/encrypted/tenants/  # Encrypted storage
├── tenant1/
│   ├── uploads/         # User uploads
│   ├── data/            # Application data
│   └── sessions/        # PHP sessions
└── tenant2/
    └── ...
```

### PHP-FPM Configuration

**Pool file:** `/etc/php-fpm.d/tenant1.conf`
```ini
[tenant1]
user = tenant1
group = tenant1

# Unix socket for nginx communication
listen = /run/php-fpm/tenant1.sock
listen.owner = nginx
listen.group = nginx
listen.mode = 0660

# On-demand process manager
pm = ondemand
pm.max_children = 3              # Max workers
pm.process_idle_timeout = 300s   # 5 min idle → shutdown
pm.max_requests = 500

# Security: chroot-like restriction
chdir = /srv/safebox/tenants/tenant1
php_admin_value[open_basedir] = /srv/safebox/tenants/tenant1:/srv/encrypted/tenants/tenant1:/tmp

# Disable dangerous functions
php_admin_value[disable_functions] = exec,passthru,shell_exec,system,proc_open,popen

# Tenant environment
env[TENANT_NAME] = tenant1
env[TENANT_DATA] = /srv/encrypted/tenants/tenant1
```

**How it works:**
1. Nginx receives request for `tenant1.example.com`
2. Passes to PHP-FPM via unix socket `/run/php-fpm/tenant1.sock`
3. PHP-FPM spawns worker as user `tenant1` (if none running)
4. Worker processes request
5. If idle for 5 minutes → worker shuts down (resource reclaim)

### Node.js Backend

**Systemd service:** `/etc/systemd/system/tenant1-node.service`
```ini
[Unit]
Description=Safebox Node.js for tenant1
After=network.target

[Service]
Type=simple
User=tenant1
Group=tenant1
WorkingDirectory=/srv/safebox/tenants/tenant1/node

Environment="NODE_PORT=3001"
Environment="TENANT_NAME=tenant1"
Environment="TENANT_DATA=/srv/encrypted/tenants/tenant1"

ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

**Server code:** `/srv/safebox/tenants/tenant1/node/server.js`
```javascript
const http = require('http');
const PORT = process.env.NODE_PORT || 3001;

let lastActivity = Date.now();
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

const server = http.createServer((req, res) => {
    lastActivity = Date.now();
    
    // Handle API requests
    // ...
});

// Auto-shutdown after 5 min idle
setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT) {
        console.log('Idle timeout. Exiting...');
        process.exit(0);
    }
}, 60000);

server.listen(PORT, '127.0.0.1');
```

**Communication:**
- PHP → Node.js: HTTP via `http://localhost:3001/api/`
- Nginx → Node.js: Proxy via `/api/*` location
- External: Not accessible (binds to 127.0.0.1 only)

### Nginx Configuration

**Vhost file:** `/etc/nginx/conf.d/tenant1.conf`
```nginx
server {
    listen 80;
    server_name tenant1.example.com;
    
    root /srv/safebox/tenants/tenant1/public;
    
    # PHP requests
    location ~ \.php$ {
        fastcgi_pass unix:/run/php-fpm/tenant1.sock;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include fastcgi_params;
    }
    
    # Node.js API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:3001/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Resource Management

### On-Demand Scaling

**PHP-FPM workers:**
- Start: 0 workers
- On request: Spawn up to 3 workers
- Idle 5 min: Workers exit
- New request: Spawn again

**Node.js processes:**
- Manually started: `systemctl start tenant1-node`
- Or: Use systemd socket activation for auto-start
- Self-terminates after 5 min idle
- systemd restarts on failure (configurable)

### Resource Limits

Per-tenant limits (via systemd):
```ini
[Service]
# CPU limit
CPUQuota=50%

# Memory limit
MemoryLimit=512M

# Process limit
TasksMax=100

# File handles
LimitNOFILE=1024
```

## Data Flow Example

### Scenario: User uploads file via web UI

1. **Browser → Nginx**
   - POST to `https://tenant1.example.com/upload.php`
   - Nginx routes to tenant1 vhost

2. **Nginx → PHP-FPM**
   - Passes request to unix socket `/run/php-fpm/tenant1.sock`
   - PHP-FPM spawns worker as user `tenant1` (if needed)

3. **PHP processes upload**
   ```php
   // In upload.php
   $tmp = $_FILES['file']['tmp_name'];
   $dest = getenv('TENANT_DATA') . '/uploads/' . $filename;
   move_uploaded_file($tmp, $dest);
   ```

4. **Safebox Encryption Layer**
   - Intercepts write to `/srv/encrypted/tenants/tenant1/uploads/`
   - Encrypts file with AES-256-GCM
   - Writes encrypted data to EBS

5. **PHP → Node.js API (optional)**
   ```php
   // Notify background job
   $ch = curl_init('http://localhost:3001/api/process-upload');
   curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
       'filename' => $filename,
       'user_id' => $user_id
   ]));
   curl_exec($ch);
   ```

6. **Node.js processes**
   - Receives notification
   - Queues background task (video transcoding, thumbnail, etc.)
   - Resets idle timer

7. **Database update**
   ```javascript
   const mysql = require('mysql2');
   const db = mysql.createConnection({
       socketPath: '/var/lib/mysql/mysql.sock',
       user: 'tenant1_db',
       password: process.env.DB_PASS,
       database: 'tenant1'
   });
   
   db.query('INSERT INTO uploads ...', ...);
   ```

8. **MariaDB writes**
   - Writes to `/srv/encrypted/mysql/tenant1/`
   - Safebox encrypts data files
   - Stored on encrypted EBS

## Security Layers

### Layer 1: Network Isolation
- Nginx only listens on 80/443
- PHP-FPM: Unix sockets (no network)
- Node.js: 127.0.0.1 only (internal)
- Inter-tenant: No communication

### Layer 2: Process Isolation
- Each tenant runs as different Linux user
- PHP `open_basedir` restricts filesystem access
- systemd resource limits prevent DoS
- SELinux/AppArmor policies (optional)

### Layer 3: Data Encryption
- **At rest**: Safebox FLE + EBS encryption
- **In transit**: HTTPS (Nginx TLS)
- **In memory**: Nitro hardware encryption
- **Keys**: TPM-sealed, attestation-gated

### Layer 4: Measured Boot
- TPM PCR 0-9 track boot integrity
- Kernel, initramfs, rootfs measured
- Safebox binary hash verified
- Keys only released if PCRs match

## Multi-Tenancy Benefits

### Efficiency
- **Single instance** hosts dozens of tenants
- **On-demand workers** → minimal idle resources
- **Shared services** (Nginx, MariaDB) → reduced overhead
- **Auto-scaling** per tenant based on traffic

### Isolation
- **User separation** prevents cross-tenant access
- **Resource limits** prevent one tenant affecting others
- **Separate logs** for debugging
- **Independent deployments** per tenant

### Security
- **Encrypted at rest** (even from root user)
- **Attestation required** before key provisioning
- **Immutable base** (AMI 3 has no package manager)
- **Audit trail** via encrypted logs

## Scaling Strategies

### Vertical Scaling
```bash
# Increase instance size
aws ec2 modify-instance-attribute \
    --instance-id i-xxxxx \
    --instance-type m6i.2xlarge
```

### Horizontal Scaling
```bash
# Launch additional instances from AMI 3
for i in {1..5}; do
    ./deploy-production.sh $(cat ami3-id.txt)
done

# Add load balancer
aws elbv2 create-load-balancer \
    --name safebox-lb \
    --subnets subnet-xxx subnet-yyy
```

### Database Sharding
- **Option 1:** Tenant per database (single MariaDB)
  ```sql
  CREATE DATABASE tenant1;
  GRANT ALL ON tenant1.* TO 'tenant1_db'@'localhost';
  ```

- **Option 2:** Separate MariaDB per tenant group
  - Light tenants: Shared MariaDB instance
  - Heavy tenants: Dedicated RDS instance

- **Option 3:** Distributed (future)
  - Intercoin blockchain for transaction log
  - Decentralized storage for backups

## Deployment Workflow

### Initial Deploy (AMI 3 → Production)
```bash
# 1. Launch instance from AMI 3
./deploy-production.sh $(cat ami3-id.txt)

# 2. Verify TPM measurements
./measure-tpm.sh $INSTANCE_IP

# 3. Run attestation (verify PCRs match AMI 3 baseline)
# Your attestation server validates measurements

# 4. Provision encryption keys (if attestation passes)
# Key server releases master key via TPM-sealed envelope

# 5. Enable services
ssh -i prod-key.pem ec2-user@$INSTANCE_IP
sudo systemctl start mariadb php-fpm nginx

# 6. Add tenants
sudo ./add-tenant.sh tenant1 tenant1.com 3001
sudo ./add-tenant.sh tenant2 tenant2.com 3002
```

### Adding New Tenant
```bash
# On production instance
sudo ./add-tenant.sh acme acme.example.com 3010

# Configure DNS
# acme.example.com → instance IP

# Setup TLS
sudo certbot certonly --nginx -d acme.example.com

# Deploy application
scp -r app-code/ tenant-user@instance:/srv/safebox/tenants/acme/

# Start services
sudo systemctl start acme-node
sudo systemctl reload php-fpm nginx
```

### Tenant Migration
```bash
# Backup tenant data
ssh instance "sudo tar czf /tmp/tenant1-backup.tar.gz \
    /srv/safebox/tenants/tenant1 \
    /srv/encrypted/tenants/tenant1"

# Transfer to new instance
scp instance:/tmp/tenant1-backup.tar.gz new-instance:/tmp/

# Restore
ssh new-instance "cd / && sudo tar xzf /tmp/tenant1-backup.tar.gz"
```

## Monitoring & Observability

### Metrics to Track
- **Per-tenant:**
  - Active PHP-FPM workers
  - Node.js uptime / restarts
  - Request rate, latency
  - Storage usage
  
- **System-wide:**
  - CPU, memory, disk I/O
  - EBS encryption performance
  - Network throughput
  - TPM attestation status

### Logging
```bash
# PHP-FPM logs per tenant
/srv/safebox/tenants/tenant1/logs/php-error.log

# Node.js logs per tenant
/srv/safebox/tenants/tenant1/logs/node.log

# Nginx access logs per tenant
/srv/safebox/tenants/tenant1/logs/nginx-access.log

# System logs (encrypted)
/srv/encrypted/logs/audit.log
```

### CloudWatch Integration
```bash
# Install CloudWatch agent
sudo dnf install -y amazon-cloudwatch-agent

# Configure metrics
cat > /opt/aws/amazon-cloudwatch-agent/etc/config.json << 'EOF'
{
  "metrics": {
    "namespace": "Safebox",
    "metrics_collected": {
      "cpu": { "measurement": [{"name": "cpu_usage_idle"}] },
      "disk": { "measurement": [{"name": "used_percent"}] },
      "mem": { "measurement": [{"name": "mem_used_percent"}] }
    }
  },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/srv/safebox/tenants/*/logs/*.log",
            "log_group_name": "/safebox/tenant-logs"
          }
        ]
      }
    }
  }
}
EOF

sudo systemctl start amazon-cloudwatch-agent
```

## Cost Optimization

### Instance Sizing
| Tenants | Instance Type | vCPU | RAM | Price/mo |
|---------|---------------|------|-----|----------|
| 1-10    | m6i.large     | 2    | 8GB | ~$70     |
| 10-50   | m6i.xlarge    | 4    | 16GB| ~$140    |
| 50-200  | m6i.2xlarge   | 8    | 32GB| ~$280    |

### Storage Optimization
- Use `gp3` EBS (cheaper than `gp2`)
- Enable compression in MariaDB
- Implement data lifecycle (archive old uploads)
- Use S3 for static assets (CDN)

### Reserved Instances
- 1-year RI: ~40% savings
- 3-year RI: ~60% savings
- Compute Savings Plans: Flexible

## Future Enhancements

1. **Auto-scaling tenants**: Systemd socket activation for Node.js
2. **Kubernetes**: Multi-instance orchestration
3. **Intercoin integration**: Blockchain transaction log
4. **Decentralized backups**: IPFS/Filecoin storage
5. **Zero-knowledge proofs**: Attestation without revealing PCRs
6. **Confidential computing**: AMD SEV / Intel SGX enclaves

---

**Architecture designed for:**
- Maximum security (triple encryption + TPM)
- Efficient multi-tenancy (on-demand workers)
- Deterministic builds (reproducible AMIs)
- Scalable growth (vertical + horizontal)
- Cost optimization (resource sharing)
