# Safebox Complete System Summary

## What is Safebox?

Safebox is a **secure, multi-tenant platform** that runs isolated applications on AWS with:

- 🔐 **Triple-layer encryption** (Nitro + EBS + File-level)
- 🐳 **Docker containers** (one per app, full isolation)
- 💾 **Shared MariaDB** (one server, multiple databases)
- 📦 **Borg-like backups** (95% deduplication, distributed storage)
- 🌐 **Cross-Safebox portability** (restore any app anywhere)
- 🔄 **Automated failover** (DNS-based, <1 min downtime)
- ✅ **Deterministic builds** (reproducible AMIs, TPM measured)
- 🚀 **Zero-downtime backups** (XtraBackup, no locks)

## Complete Storage Stack

```
┌─────────────────────────────────────────────────────────────┐
│                    Safebox Instance                          │
│              (Amazon Linux 2023 + Nitro TPM)                 │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────┐  │
│  │               Nginx (Host)                            │  │
│  │  acme.com → 172.17.0.2:8001                          │  │
│  │  blog.acme.com → 172.17.0.3:8002                     │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────┬──────────────┬──────────────┐           │
│  │  Container   │  Container   │  Container   │           │
│  │  acme_web    │  acme_blog   │  beta_app    │           │
│  │              │              │              │           │
│  │ ┌──────────┐ │ ┌──────────┐ │ ┌──────────┐ │          │
│  │ │ Overlay2 │ │ │ Overlay2 │ │ │ Overlay2 │ │          │
│  │ │  (RW)    │ │ │  (RW)    │ │ │  (RW)    │ │          │
│  │ └────┬─────┘ │ └────┬─────┘ │ └────┬─────┘ │          │
│  │      │       │      │       │      │       │           │
│  │ ┌────▼─────┐ │ ┌────▼─────┐ │ ┌────▼─────┐ │          │
│  │ │ZFS Lower │ │ │ZFS Lower │ │ │ZFS Lower │ │          │
│  │ │  Layers  │ │ │  Layers  │ │ │  Layers  │ │          │
│  │ └──────────┘ │ └──────────┘ │ └──────────┘ │          │
│  │  - PHP-FPM   │  - PHP-FPM   │  - PHP-FPM   │          │
│  │  - Node.js   │  - Node.js   │  - Node.js   │          │
│  │  - nginx     │  - nginx     │  - nginx     │          │
│  └──────────────┴──────────────┴──────────────┘           │
│                       ↓ unix socket ↓                       │
│  ┌──────────────────────────────────────────────────────┐  │
│  │       MariaDB Server (Single Instance)                │  │
│  │  DBs: acme_web, acme_blog, beta_app                  │  │
│  └──────────────────────────────────────────────────────┘  │
│                       ↓                                     │
│  ┌──────────────────────────────────────────────────────┐  │
│  │         ZFS Filesystem (safebox-pool)                 │  │
│  │  - Compression (LZ4): 2-3x                           │  │
│  │  - Deduplication: Block-level sharing                │  │
│  │  - Copy-on-Write: Instant snapshots/clones           │  │
│  │  - Checksums: Data integrity                         │  │
│  │  - Encryption: AES-256-GCM per dataset               │  │
│  └──────────────────────────────────────────────────────┘  │
│                       ↓                                     │
│  ┌──────────────────────────────────────────────────────┐  │
│  │           Encrypted EBS Volume (AWS)                  │  │
│  │  AES-256 encryption, KMS-managed keys                │  │
│  │  /dev/xvdf → safebox-pool                            │  │
│  └──────────────────────────────────────────────────────┘  │
│                       ↓                                     │
│  ┌──────────────────────────────────────────────────────┐  │
│  │         Nitro Hypervisor (AWS)                        │  │
│  │  Hardware-enforced RAM encryption                     │  │
│  │  Instance isolation                                   │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Docker Overlay2 on ZFS

### **How It Works**

```
Docker Container Filesystem:

Upper Layer (Container RW):
├── ZFS Dataset: safebox-pool/docker/overlay2/<container-id>/diff
└── Writable layer for container changes

Lower Layers (Image RO):
├── ZFS Dataset: safebox-pool/docker/overlay2/<image-layer-1>/diff
├── ZFS Dataset: safebox-pool/docker/overlay2/<image-layer-2>/diff
└── ZFS Dataset: safebox-pool/docker/overlay2/<image-layer-3>/diff

Merged View (What container sees):
└── Overlay2 mounts all layers as single filesystem
    ├── /app/ (from image)
    ├── /usr/bin/php (from image)
    └── /tmp/container-data (from upper layer)
```

### **ZFS Benefits for Docker**

**1. Image Layer Deduplication**
```
Without ZFS:
├── nginx:latest (500MB)
├── php:8.2 (800MB)
├── Custom image 1 based on php:8.2 (800MB + 50MB)
├── Custom image 2 based on php:8.2 (800MB + 30MB)
└── Total: 2950MB

With ZFS:
├── nginx:latest (500MB)
├── php:8.2 base layers (800MB)
├── Custom image 1 layers (50MB unique)
├── Custom image 2 layers (30MB unique)
└── Total: 1380MB (53% savings via block-level dedup)
```

**2. Fast Container Creation**
```
Without ZFS:
├── Create overlay2 layers: Copy files
├── Time: 5-10 seconds per container

With ZFS:
├── ZFS clone of base layers (CoW)
├── Time: <1 second per container
```

**3. Container Snapshots**
```bash
# Snapshot entire container state
zfs snapshot safebox-pool/docker/overlay2/<container-id>@checkpoint1

# Rollback container
docker stop container
zfs rollback safebox-pool/docker/overlay2/<container-id>@checkpoint1
docker start container
```

### **Docker Configuration for ZFS**

```json
# /etc/docker/daemon.json
{
  "storage-driver": "overlay2",
  "storage-opts": [
    "overlay2.override_kernel_check=true"
  ],
  "data-root": "/srv/encrypted/docker",
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

**Note:** Docker overlay2 works perfectly on ZFS. The overlay filesystem sits on top of ZFS, getting benefits of:
- ZFS compression (smaller Docker images)
- ZFS deduplication (shared blocks between similar images)
- ZFS snapshots (backup entire Docker state)
- ZFS copy-on-write (fast container creation)

### **Storage Layout**

```
ZFS Pool: safebox-pool
├── safebox-pool/docker
│   ├── overlay2/
│   │   ├── <container-1-id>/
│   │   │   ├── diff/ (RW layer)
│   │   │   ├── merged/ (mount point)
│   │   │   └── work/ (overlay2 work dir)
│   │   ├── <container-2-id>/
│   │   └── <image-layer-id>/
│   └── volumes/
│       ├── acme_web_data/
│       └── acme_blog_data/
│
├── safebox-pool/mysql
│   ├── acme_web/ (InnoDB files)
│   ├── acme_blog/ (InnoDB files)
│   └── beta_app/ (InnoDB files)
│
└── safebox-pool/apps
    ├── acme/website/ (mounted into containers)
    └── acme/blog/ (mounted into containers)
```

### **Container to Database Mapping**

```
Container: acme_web_container
├── Filesystem: Docker overlay2
│   └── Lower layers: PHP, nginx, Node.js (on ZFS)
│   └── Upper layer: Container changes (on ZFS)
├── Bind mount: /srv/encrypted/apps/acme/website
│   └── ZFS dataset: safebox-pool/apps/acme/website
└── Database connection: unix socket → MariaDB
    └── Database: acme_web
        └── ZFS dataset: safebox-pool/mysql/acme_web
```

### **Benefits of This Stack**

**1. Separate Snapshot Granularity**
```bash
# Snapshot just the database
zfs snapshot safebox-pool/mysql/acme_web@backup1

# Snapshot just the app files
zfs snapshot safebox-pool/apps/acme/website@backup1

# Snapshot entire container (Docker layers)
zfs snapshot safebox-pool/docker/overlay2/<container-id>@backup1

# Or snapshot everything
zfs snapshot -r safebox-pool@backup1
```

**2. Efficient Storage**
```
Multiple containers using same base image:
├── php:8.2 base layers: 800MB (shared via ZFS dedup)
├── Container 1 changes: 10MB
├── Container 2 changes: 15MB
├── Container 3 changes: 12MB
└── Total: 847MB (vs 2400MB without ZFS dedup)
```

**3. Fast Cloning**
```bash
# Clone production app to staging
zfs snapshot safebox-pool/apps/acme/website@prod
zfs clone safebox-pool/apps/acme/website@prod \
          safebox-pool/apps/acme/website-staging

# Clone database
zfs snapshot safebox-pool/mysql/acme_web@prod
zfs clone safebox-pool/mysql/acme_web@prod \
          safebox-pool/mysql/acme_web_staging

# Start staging container with cloned data
docker run -v /srv/encrypted/apps/acme/website-staging:/app/data ...
```
```

## How It Works

### 1. **Application Isolation**

Each app runs in its own **Docker container**:
```
Container: acme_web
├── Nginx (serves static files)
├── PHP-FPM (runs PHP code)
├── Node.js (API backend)
├── Bind-mounted storage: /srv/encrypted/apps/acme_web/
└── Database: unix socket to MariaDB (acme_web database)

Result: Complete isolation
- Separate filesystem
- Separate processes  
- Separate network
- Own database
```

### 2. **Database Architecture**

**One MariaDB server, multiple databases:**
```sql
MariaDB Server (Host: /srv/encrypted/mysql/)
├── acme_web (database)
│   ├── users.ibd (table file)
│   ├── posts.ibd
│   └── ...
├── acme_blog (database)
│   └── articles.ibd
└── beta_app (database)
    └── data.ibd

Connections: All containers → unix socket → shared MariaDB
Permissions: Each app can only access its own database
```

**Benefits:**
- Shared buffer pool (4GB total vs 5GB+ for separate instances)
- Easy backups (single XtraBackup for all)
- Resource efficient (one daemon vs many)

### 3. **Encryption Layers**

**Layer 1: Nitro RAM Encryption** (hardware, automatic)
- All memory encrypted by Nitro hypervisor
- Cannot be read from host

**Layer 2: EBS Encryption** (AWS, automatic)
- Disk encrypted with AES-256
- Keys managed by AWS KMS

**Layer 3: File-Level Encryption** (Safebox FUSE)
- Transparent encryption of all files
- AES-256-GCM per file
- Keys TPM-sealed, provisioned after attestation

**Result:** Even with root access, data is encrypted

### 4. **Backup System**

**Zero-downtime backups using Percona XtraBackup:**
```
Every hour (automatic):
1. XtraBackup streams database (no locks, DB keeps running)
2. Borg-like chunker: content-defined chunks (4MB avg)
3. Deduplication: Only new chunks stored (95% savings)
4. Compression: zstd level 3
5. Encryption: AES-256-GCM per chunk
6. Upload: Distributed storage (IPFS/Filecoin/S3)
7. Record: Merkle root on Intercoin blockchain

Incremental backups:
- Day 1: 10GB (full)
- Day 2: 50MB (95% savings!)
- Day 3: 30MB (97% savings!)
```

### 5. **Cross-Safebox Restore**

**Restore any app to any Safebox:**
```bash
# App fails on Safebox-1
# Restore to Safebox-2:

1. Fetch latest backup (merkle root from blockchain)
2. Download chunks from distributed storage
3. Verify chunks (SHA256 hash)
4. Decrypt and decompress
5. Restore database files
6. Create container on Safebox-2
7. Update DNS (acme.com → Safebox-2 IP)
8. Traffic resumes (<1 min downtime)
```

### 6. **Governance & Updates**

**M-of-N signature verification:**
```
Update Manifest Published:
├── Platform update (Safebox binary, PHP, etc.)
├── Model update (AI models)
├── Git/Hg operation (code changes)
└── Signed by 3 of 5 keys

Governance Updater (runs every hour):
1. Fetch manifest
2. Verify M-of-N signatures (3 of 5 required)
3. Download update
4. Verify SHA256 hash
5. Apply update
6. Restart services
7. No changes without valid signatures
```

### 7. **Deterministic Builds**

**AMI 1 → AMI 2 → AMI 3 (reproducible):**
```
Phase 1 (Online):
- Download packages to /opt/rpm-cache
- Upload Safebox binary
- Create AMI 1 (inputs cached)

Phase 2 (Offline):
- Install from local cache
- Configure services (disabled)
- No network, no randomness
- Create AMI 2 (installed)

Phase 3 (Finalize):
- Remove SSH, package manager
- Clear logs, machine identity
- No secrets, no randomness
- Create AMI 3 (immutable, TPM measured)

Result: Byte-identical AMI across rebuilds
```

---

## Step-by-Step Installation on AWS

### Prerequisites

On your **local machine** (laptop/workstation):

1. **Install AWS CLI v2:**
   ```bash
   # macOS
   brew install awscli
   
   # Linux
   curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
   unzip awscliv2.zip
   sudo ./aws/install
   ```

2. **Install jq:**
   ```bash
   brew install jq  # macOS
   sudo dnf install jq  # Amazon Linux / Fedora
   sudo apt install jq  # Ubuntu / Debian
   ```

3. **Configure AWS credentials:**
   ```bash
   aws configure
   # AWS Access Key ID: YOUR_KEY
   # AWS Secret Access Key: YOUR_SECRET
   # Default region: us-east-1
   # Output format: json
   ```

4. **Verify AWS access:**
   ```bash
   aws sts get-caller-identity
   # Should show your account ID
   ```

---

### Step 1: Setup IAM Permissions (5 minutes)

**Create IAM policy for building AMIs:**

```bash
# Download the Safebox toolkit (already provided to you)
cd safebox-ami-builder/

# Create IAM policy
aws iam create-policy \
    --policy-name SafeboxAMIBuilderPolicy \
    --policy-document file://iam-policy-safebox-builder.json

# Get your AWS account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Attach policy to your user (replace YOUR_USERNAME)
aws iam attach-user-policy \
    --user-name YOUR_USERNAME \
    --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/SafeboxAMIBuilderPolicy"

echo "IAM policy created and attached"
```

**Or create a dedicated IAM user:**
```bash
# Create builder user
aws iam create-user --user-name safebox-builder

# Attach policy
aws iam attach-user-policy \
    --user-name safebox-builder \
    --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/SafeboxAMIBuilderPolicy"

# Create access keys
aws iam create-access-key --user-name safebox-builder

# Configure AWS CLI with new user
aws configure --profile safebox-builder
```

---

### Step 2: Prepare Build Environment (5 minutes)

**Setup build directory:**
```bash
# Create working directory
mkdir -p ~/safebox-builds
cd ~/safebox-builds

# Extract Safebox toolkit (provided files)
# Assuming you have the files in current directory:
ls -l
# Should show:
# - build-safebox-amis.sh
# - build-manifest-enhanced.json
# - iam-policy-safebox-builder.json
# - governance-updater.js
# - borg-chunk.py
# - backup-safebox.sh
# - add-tenant-enhanced.sh
# - etc.

# Make scripts executable
chmod +x *.sh *.py

# Set region (optional, defaults to us-east-1)
export AWS_REGION=us-east-1
```

**Prepare Safebox binary (if you have it):**
```bash
# If you have Safebox source code:
cd /path/to/safebox
./build.sh release
tar czf safebox.tar.gz bin/ config/ encryption-module.so

# Calculate hash
sha256sum safebox.tar.gz
# Save this hash!

# Copy to build directory
cp safebox.tar.gz ~/safebox-builds/

# Update manifest with hash
cd ~/safebox-builds
# Edit build-manifest-enhanced.json
# Update "safebox_binary.sha256" with your hash
```

---

### Step 3: Build AMI 1 - Download Packages (30 minutes)

**Run Phase 1 (online package download):**

```bash
cd ~/safebox-builds

# Start Phase 1 build
./build-safebox-amis.sh phase1

# Script will:
# 1. Find latest Amazon Linux 2023 AMI
# 2. Launch EC2 instance (internet ON, SSH ON)
# 3. Download all packages to /opt/rpm-cache
# 4. Wait for you to upload Safebox binary

# When script pauses, you'll see:
# "SSH command: ssh -i safebox-builder-key.pem ec2-user@X.X.X.X"
# "Upload Safebox binary and press ENTER"
```

**Upload Safebox binary to instance:**
```bash
# In another terminal
INSTANCE_IP=X.X.X.X  # From script output

# Upload Safebox binary
scp -i safebox-builder-key.pem safebox.tar.gz \
    ec2-user@${INSTANCE_IP}:/opt/safebox-staging/

# Verify upload
ssh -i safebox-builder-key.pem ec2-user@${INSTANCE_IP}
ls -lh /opt/safebox-staging/
sha256sum /opt/safebox-staging/safebox.tar.gz
# Should match your hash!

# Verify package downloads
ls -lh /opt/rpm-cache/ | wc -l
# Should show 100+ packages

exit
```

**Continue Phase 1:**
```bash
# Back in first terminal, press ENTER

# Script will:
# 5. Create AMI 1 (with cached packages)
# 6. Save AMI ID to ami1-id.txt
# 7. Terminate instance

# Wait for completion (5-10 minutes)
# Output: "AMI 1 created: ami-xxxxx"

cat ami1-id.txt
# Shows AMI ID
```

---

### Step 4: Build AMI 2 - Offline Install (30 minutes)

**Run Phase 2 (offline installation):**

```bash
./build-safebox-amis.sh phase2

# Script will:
# 1. Launch instance from AMI 1 (internet OFF)
# 2. Install packages from local cache
# 3. Configure MariaDB, PHP, Nginx, Docker
# 4. Install Safebox binary
# 5. Setup directory structure
# 6. Wait for auditor verification
```

**Auditor verification (important!):**
```bash
# SSH to Phase 2 instance
INSTANCE_IP=X.X.X.X  # From script output
ssh -i safebox-builder-key.pem ec2-user@${INSTANCE_IP}

# 1. Verify packages installed from local cache
rpm -qa | grep -E "nginx|php|mariadb|docker" | wc -l
# Should show ~20+ packages

# 2. Verify Safebox binary
sha256sum /srv/safebox/bin/safebox
# Should match your hash!

# 3. Verify MariaDB configuration
cat /etc/my.cnf.d/safebox-mariadb.cnf
# Should show:
#   innodb_flush_log_at_trx_commit=1
#   innodb_file_per_table=1
#   sync_binlog=1

# 4. Verify no secrets in AMI
find /srv/safebox -name "*.key" -o -name "*secret*" 2>/dev/null
# Should find only placeholder files

# 5. Verify encryption config
cat /srv/safebox/config/encryption.conf
# Should show:
#   key_source = TPM_SEALED
#   mode = AES-256-GCM

# 6. Verify services disabled
systemctl is-enabled mariadb php-fpm nginx docker
# All should show: disabled

exit
```

**Continue Phase 2:**
```bash
# Press ENTER in build script

# Script will:
# 7. Create AMI 2
# 8. Save AMI ID to ami2-id.txt
# 9. Terminate instance

cat ami2-id.txt
# Shows AMI 2 ID
```

---

### Step 5: Build AMI 3 - Finalize (20 minutes)

**Run Phase 3 (finalization):**

```bash
./build-safebox-amis.sh phase3

# Script will:
# 1. Launch instance from AMI 2
# 2. Wait for you to run finalize.sh
```

**Run finalization:**
```bash
# SSH to Phase 3 instance
INSTANCE_IP=X.X.X.X  # From script output
ssh -i safebox-builder-key.pem ec2-user@${INSTANCE_IP}

# Upload finalize script
exit
scp -i safebox-builder-key.pem finalize.sh ec2-user@${INSTANCE_IP}:~/

# SSH back and run finalization
ssh -i safebox-builder-key.pem ec2-user@${INSTANCE_IP}
sudo bash finalize.sh

# Script will:
# - Disable and remove SSH
# - Remove package manager (dnf)
# - Clear all logs
# - Reset machine identity
# - Disable cloud-init

# Verify cleanup
which dnf
# Should show: not found

systemctl status sshd
# Should show: masked

ls /opt/
# Should be empty

# Connection will drop after finalization
```

**Complete Phase 3:**
```bash
# Press ENTER in build script

# Script will:
# 3. Create AMI 3 (final, immutable)
# 4. Save AMI ID to ami3-id.txt
# 5. Generate build report

cat ami3-id.txt
# This is your production AMI!

cat build-report.md
# Review build summary
```

---

### Step 6: Deploy Production Instance (10 minutes)

**Launch production Safebox from AMI 3:**

```bash
# Get AMI 3 ID
AMI3_ID=$(cat ami3-id.txt)

# Launch production instance
./deploy-production.sh $AMI3_ID m6i.2xlarge safebox-prod-key

# Script will:
# 1. Create security group (if needed)
# 2. Launch instance with encrypted EBS
# 3. Wait for instance to be ready
# 4. Display instance details

# Save instance IP
SAFEBOX_IP=X.X.X.X  # From script output
echo $SAFEBOX_IP > safebox-prod-ip.txt
```

**Verify TPM and measure boot:**
```bash
# Measure TPM PCRs (for attestation)
./measure-tpm.sh $SAFEBOX_IP safebox-prod-key.pem

# Output will show:
# - TPM PCR values (save these!)
# - Safebox binary hash verification
# - Encryption module hash verification

# Save the attestation report
# File created: attestation-report-YYYYMMDD-HHMMSS.json
```

**Enable services:**
```bash
# SSH to production instance
# (Last time SSH will work before removing SSH in production)
ssh -i safebox-prod-key.pem ec2-user@${SAFEBOX_IP}

# Start MariaDB
sudo systemctl start mariadb
sudo systemctl enable mariadb

# Verify MariaDB running
sudo systemctl status mariadb

# Initialize root password (if needed)
sudo mysql_secure_installation
# Follow prompts

# Start Docker
sudo systemctl start docker
sudo systemctl enable docker

# Start governance updater
sudo systemctl start safebox-governance
sudo systemctl enable safebox-governance

# Verify services
sudo systemctl status mariadb docker safebox-governance

exit
```

---

### Step 7: Add Your First Application (15 minutes)

**Create first app (acme_web):**

```bash
# SSH to instance
ssh -i safebox-prod-key.pem ec2-user@${SAFEBOX_IP}

# Upload tenant provisioning script
exit
scp -i safebox-prod-key.pem add-tenant-enhanced.sh \
    ec2-user@${SAFEBOX_IP}:~/

# SSH back and add tenant
ssh -i safebox-prod-key.pem ec2-user@${SAFEBOX_IP}
chmod +x add-tenant-enhanced.sh

# Add first app
sudo ./add-tenant-enhanced.sh \
    acme \           # Tenant name
    website \        # App name
    acme.com \       # Domain
    8001             # Internal port

# Script will:
# 1. Create Linux user: acme_website
# 2. Create database: acme_website
# 3. Create encrypted storage: /srv/encrypted/apps/acme/website/
# 4. Create Docker container
# 5. Configure Nginx vhost
# 6. Start services

# Verify container running
sudo docker ps
# Should show: acme_website_container

# Verify database
sudo mysql -e "SHOW DATABASES LIKE 'acme_website'"
# Should show: acme_website

# Test locally
curl -H "Host: acme.com" http://localhost/
# Should return Safebox welcome page
```

**Deploy your application code:**
```bash
# Upload your application files
exit

# Example: Upload WordPress, Laravel, custom app, etc.
scp -r -i safebox-prod-key.pem my-app/ \
    ec2-user@${SAFEBOX_IP}:/tmp/

# SSH back
ssh -i safebox-prod-key.pem ec2-user@${SAFEBOX_IP}

# Copy to app directory
sudo cp -r /tmp/my-app/* /srv/safebox/tenants/acme/website/public/
sudo chown -R acme_website:acme_website \
    /srv/safebox/tenants/acme/website/

# Restart container
sudo docker restart acme_website_container

# Verify
curl -H "Host: acme.com" http://localhost/
# Should show your app!
```

---

### Step 8: Configure DNS (5 minutes)

**Point your domain to Safebox:**

```bash
# Get Safebox public IP
SAFEBOX_IP=$(cat safebox-prod-ip.txt)

# Option 1: Route53 (if using AWS)
aws route53 change-resource-record-sets \
    --hosted-zone-id Z123456 \
    --change-batch '{
      "Changes": [{
        "Action": "UPSERT",
        "ResourceRecordSet": {
          "Name": "acme.com",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "'${SAFEBOX_IP}'"}]
        }
      }]
    }'

# Option 2: Your DNS provider
# Add A record: acme.com → $SAFEBOX_IP

# Wait for DNS propagation (5-10 minutes)
dig acme.com +short
# Should show your Safebox IP

# Test from internet
curl http://acme.com/
# Should show your app!
```

---

### Step 9: Setup HTTPS with Let's Encrypt (10 minutes)

**Install Certbot and get SSL certificate:**

```bash
# SSH to Safebox
ssh -i safebox-prod-key.pem ec2-user@${SAFEBOX_IP}

# Install Certbot
sudo dnf install -y certbot python3-certbot-nginx

# Get certificate (stop containers temporarily)
sudo docker stop acme_website_container
sudo systemctl start nginx

# Request certificate
sudo certbot certonly --nginx -d acme.com

# Certificate saved to:
# /etc/letsencrypt/live/acme.com/fullchain.pem
# /etc/letsencrypt/live/acme.com/privkey.pem

# Update Nginx config to use SSL
sudo vi /etc/nginx/conf.d/acme_website.conf
# Add:
#   listen 443 ssl;
#   ssl_certificate /etc/letsencrypt/live/acme.com/fullchain.pem;
#   ssl_certificate_key /etc/letsencrypt/live/acme.com/privkey.pem;

# Reload Nginx
sudo systemctl reload nginx

# Restart container
sudo docker start acme_website_container

# Test HTTPS
curl https://acme.com/
# Should work with SSL!

# Setup auto-renewal
sudo certbot renew --dry-run
# Add to crontab:
# 0 3 * * * certbot renew --quiet
```

---

### Step 10: Setup Automated Backups (10 minutes)

**Configure daily backups:**

```bash
# SSH to Safebox
ssh -i safebox-prod-key.pem ec2-user@${SAFEBOX_IP}

# Upload backup scripts
exit
scp -i safebox-prod-key.pem \
    backup-safebox.sh \
    borg-chunk.py \
    ec2-user@${SAFEBOX_IP}:~/

# SSH back and install scripts
ssh -i safebox-prod-key.pem ec2-user@${SAFEBOX_IP}
sudo cp backup-safebox.sh /srv/safebox/bin/
sudo cp borg-chunk.py /srv/safebox/bin/
sudo chmod +x /srv/safebox/bin/*.sh /srv/safebox/bin/*.py

# Install Python dependencies
sudo pip3 install zstandard mysql-connector-python --break-system-packages

# Test backup manually
sudo /srv/safebox/bin/backup-safebox.sh backup-app acme_website

# Should output:
# "Using XtraBackup (no locks)"
# "Snapshot ID: abc123..."
# "Zero downtime: true"

# List backups
sudo /srv/safebox/bin/backup-safebox.sh list

# Setup automated backups
sudo crontab -e
# Add:
# Hourly incremental backup
0 * * * * /srv/safebox/bin/backup-safebox.sh backup-all

# Daily full backup at 2 AM
0 2 * * * /srv/safebox/bin/backup-safebox.sh backup-all

# Weekly cleanup (keep 30 days)
0 3 * * 0 /srv/safebox/bin/backup-safebox.sh cleanup 30

# Verify cron
sudo crontab -l
```

---

### Step 11: Setup Monitoring (Optional, 10 minutes)

**Install CloudWatch agent:**

```bash
# SSH to Safebox
ssh -i safebox-prod-key.pem ec2-user@${SAFEBOX_IP}

# Install CloudWatch agent
sudo dnf install -y amazon-cloudwatch-agent

# Configure metrics and logs
sudo vi /opt/aws/amazon-cloudwatch-agent/etc/config.json
# Add configuration (see ARCHITECTURE.md for example)

# Start CloudWatch agent
sudo systemctl start amazon-cloudwatch-agent
sudo systemctl enable amazon-cloudwatch-agent

# Verify
sudo systemctl status amazon-cloudwatch-agent
```

---

## Verification Checklist

After installation, verify everything works:

```bash
# ✅ Instance running
aws ec2 describe-instances --instance-ids i-xxxxx | grep State

# ✅ Services running
ssh -i safebox-prod-key.pem ec2-user@${SAFEBOX_IP} \
    "sudo systemctl status mariadb docker safebox-governance"

# ✅ Container running
ssh -i safebox-prod-key.pem ec2-user@${SAFEBOX_IP} \
    "sudo docker ps"

# ✅ Database accessible
ssh -i safebox-prod-key.pem ec2-user@${SAFEBOX_IP} \
    "sudo mysql -e 'SHOW DATABASES'"

# ✅ Website accessible
curl https://acme.com/
# Should return your website

# ✅ Backups working
ssh -i safebox-prod-key.pem ec2-user@${SAFEBOX_IP} \
    "sudo /srv/safebox/bin/backup-safebox.sh list"

# ✅ Encryption active
ssh -i safebox-prod-key.pem ec2-user@${SAFEBOX_IP} \
    "df -h | grep /srv/encrypted"

# ✅ TPM measured
ls -l attestation-report-*.json
# Should exist from Step 6
```

---

## Adding More Apps

**Add second app to same tenant:**
```bash
ssh -i safebox-prod-key.pem ec2-user@${SAFEBOX_IP}

# Add blog
sudo ./add-tenant-enhanced.sh \
    acme \
    blog \
    blog.acme.com \
    8002

# Add API
sudo ./add-tenant-enhanced.sh \
    acme \
    api \
    api.acme.com \
    8003
```

**Add different tenant:**
```bash
# Add different tenant (beta company)
sudo ./add-tenant-enhanced.sh \
    beta \
    app \
    beta.example.com \
    8010
```

---

## Backup & Restore

**Manual backup:**
```bash
# Backup specific app
sudo /srv/safebox/bin/backup-safebox.sh backup-app acme_website

# Backup all apps
sudo /srv/safebox/bin/backup-safebox.sh backup-all

# Incremental backup (only changed chunks)
sudo /srv/safebox/bin/backup-safebox.sh backup-incremental acme_website
```

**Restore to same Safebox:**
```bash
# List available backups
sudo /srv/safebox/bin/backup-safebox.sh list

# Restore specific snapshot
SNAPSHOT_ID=abc123...
sudo python3 /srv/safebox/bin/borg-chunk.py restore \
    --snapshot $SNAPSHOT_ID \
    --target /tmp/restore

# Stop container
sudo docker stop acme_website_container

# Restore files
sudo rm -rf /srv/encrypted/mysql/acme_website
sudo cp -r /tmp/restore/acme_website /srv/encrypted/mysql/
sudo chown -R mysql:mysql /srv/encrypted/mysql/acme_website

# Start container
sudo docker start acme_website_container
```

**Restore to different Safebox:**
```bash
# On new Safebox
# Download snapshot from distributed storage
# Create new app with restore
sudo /srv/safebox/bin/restore-app-cross-safebox.sh \
    acme_website \
    acme_website_backup \
    backup.acme.com \
    $SNAPSHOT_ID \
    8020

# Update DNS
# Point backup.acme.com → new Safebox IP
```

---

## Troubleshooting

### Build Issues

**AMI creation timeout:**
```bash
# Check AMI status
aws ec2 describe-images --image-ids ami-xxxxx

# If stuck, check instance console output
aws ec2 get-console-output --instance-id i-xxxxx
```

**Package download failures:**
```bash
# SSH to Phase 1 instance
ssh -i safebox-builder-key.pem ec2-user@$INSTANCE_IP

# Check download logs
tail -f /var/log/phase1-build.log

# Retry failed packages
cd /opt/rpm-cache
sudo dnf download --resolve package-name
```

### Runtime Issues

**Container won't start:**
```bash
# Check Docker logs
sudo docker logs acme_website_container

# Check container status
sudo docker inspect acme_website_container

# Recreate container
sudo docker rm -f acme_website_container
sudo ./add-tenant-enhanced.sh acme website acme.com 8001
```

**Database connection issues:**
```bash
# Check MariaDB status
sudo systemctl status mariadb

# Check logs
sudo tail -f /srv/encrypted/mysql/error.log

# Test connection
sudo mysql -e "SELECT 1"

# Check permissions
sudo mysql -e "SHOW GRANTS FOR 'acme_website_user'@'%'"
```

**Backup failures:**
```bash
# Check if XtraBackup installed
which xtrabackup

# Install if missing
sudo dnf install percona-xtrabackup

# Check backup logs
ls -lt /srv/encrypted/backups/*.log | head

# Test manual backup with verbose
sudo /srv/safebox/bin/backup-safebox.sh backup-app acme_website
```

---

## Cost Estimate

### Build Phase (One-time)
- Instance runtime (4 hours): ~$0.40
- EBS storage (temporary): ~$0.01/day
- AMI storage (3 AMIs): ~$7/month

### Production (Monthly)
- **m6i.2xlarge** instance (24/7): ~$280/month
- **EBS** 100GB gp3: ~$8/month
- **Data transfer** (500GB): ~$45/month
- **Backups** (deduplicated): ~$10/month
- **Total**: ~$343/month for full platform

### Per-App Costs
With 10 apps: ~$34/app/month
With 50 apps: ~$7/app/month
With 200 apps: ~$1.72/app/month

---

## Security Best Practices

1. **Rotate IAM keys regularly:**
   ```bash
   aws iam create-access-key --user-name safebox-builder
   # Delete old keys after testing new ones
   ```

2. **Enable MFA on AWS account**

3. **Use separate AWS account for production**

4. **Restrict security groups:**
   ```bash
   # Allow only your IPs for SSH during setup
   aws ec2 authorize-security-group-ingress \
       --group-id sg-xxxxx \
       --protocol tcp --port 22 \
       --cidr YOUR_IP/32
   
   # Remove SSH access after setup
   aws ec2 revoke-security-group-ingress \
       --group-id sg-xxxxx \
       --protocol tcp --port 22 \
       --cidr 0.0.0.0/0
   ```

5. **Monitor CloudWatch logs for anomalies**

6. **Regularly verify backup integrity:**
   ```bash
   sudo /srv/safebox/bin/backup-safebox.sh verify $SNAPSHOT_ID
   ```

7. **Keep TPM measurements secure** (from attestation reports)

8. **Use AWS KMS for additional key management**

---

## Next Steps

1. ✅ **Setup monitoring** (CloudWatch, external)
2. ✅ **Configure automated backups** (already done in Step 10)
3. ✅ **Setup DNS failover** (Route53 health checks)
4. ✅ **Deploy replica Safebox** (another region)
5. ✅ **Configure Intercoin blockchain** (backup merkle roots)
6. ✅ **Setup CI/CD** (auto-deploy app updates)
7. ✅ **Configure WAF** (CloudFlare, AWS WAF)
8. ✅ **Setup log aggregation** (CloudWatch Logs Insights)

---

## Support & Resources

### Documentation
- `ARCHITECTURE-COMPLETE.md` - Complete architecture reference
- `BACKUP-STRATEGY.md` - Backup and restore details
- `XTRABACKUP-PRIMARY.md` - XtraBackup methodology
- `README.md` - Detailed installation guide

### AWS Resources
- EC2 Instances: https://console.aws.amazon.com/ec2/
- AMIs: https://console.aws.amazon.com/ec2/#Images
- CloudWatch: https://console.aws.amazon.com/cloudwatch/

### Getting Help
- Check logs in `/var/log/safebox/`
- Check Docker logs: `sudo docker logs <container>`
- Check MariaDB logs: `/srv/encrypted/mysql/error.log`
- Review build reports: `build-report.md`

---

## Summary

You now have a **complete, production-ready Safebox platform** with:

✅ **Deterministic AMI builds** (Phase 1 → 2 → 3)  
✅ **Multi-tenant isolation** (Docker containers per app)  
✅ **Zero-downtime backups** (XtraBackup, 95% dedup)  
✅ **Triple encryption** (Nitro + EBS + FUSE)  
✅ **Cross-Safebox portability** (restore anywhere)  
✅ **Automated governance** (M-of-N signatures)  
✅ **TPM attestation** (measured boot)  
✅ **Distributed backups** (blockchain-verified)  

**Total setup time:** 2-3 hours  
**Ongoing maintenance:** Minimal (automated backups, updates)  
**Cost:** ~$340/month for unlimited apps  

🎉 **Your Safebox is ready for production!**
