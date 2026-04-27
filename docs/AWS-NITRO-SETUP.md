# AWS Safebox Instance Setup Guide

**Complete guide for provisioning Safebox on AWS with Nitro Enclaves and encrypted RAM**

---

## 🎯 Overview

This guide covers both **automated** (script) and **manual** (console) provisioning of Safebox production instances on AWS.

**What you get:**
- ✅ Nitro-based instance (memory encryption enabled)
- ✅ Nitro Enclaves support
- ✅ ZFS filesystem for snapshots/clones
- ✅ Docker + Docker Compose
- ✅ Encrypted EBS volumes
- ✅ Production-ready AMI

---

## 📋 Prerequisites

### AWS Account Requirements

1. **AWS Account** with admin access
2. **VPC and Subnet** already created
3. **SSH Key Pair** (create in EC2 console if needed)
4. **IAM Instance Profile** (optional but recommended)

### Local Requirements

- AWS CLI installed (`aws --version`)
- AWS credentials configured (`aws configure`)
- SSH key downloaded locally

---

## 🚀 Option 1: Automated Provisioning (Recommended)

**Use the included script:**

### Step 1: Set Environment Variables

```bash
export AWS_REGION=us-east-1
export SUBNET_ID=subnet-xxxxx  # REQUIRED - your subnet
export KEY_NAME=your-ssh-key   # REQUIRED - your EC2 key pair
export INSTANCE_NAME=safebox-prod-1
export ENVIRONMENT=production
```

### Step 2: Run Provisioning Script

```bash
cd scripts
chmod +x provision-safebox-ami.sh
./provision-safebox-ami.sh
```

**What it does:**
1. ✅ Finds latest Ubuntu 22.04 AMI
2. ✅ Creates security group (SSH from your IP, HTTPS/HTTP open)
3. ✅ Launches m6i.2xlarge instance with Nitro Enclaves enabled
4. ✅ Creates and attaches 500GB encrypted data volume
5. ✅ Configures ZFS pool
6. ✅ Installs Docker + Nitro CLI
7. ✅ Installs Infrastructure package
8. ✅ Creates production AMI

**Duration:** ~15 minutes

**Output:**
```
Instance ID: i-xxxxx
Public IP: 1.2.3.4
AMI ID: ami-xxxxx
SSH: ssh ubuntu@1.2.3.4
```

### Step 3: Connect and Deploy

```bash
# SSH to instance
ssh ubuntu@<PUBLIC_IP>

# Deploy Safebox containers
cd /opt/safebox-infrastructure
docker-compose up -d
```

**Done!** Your Safebox instance is running.

---

## 🖱️ Option 2: Manual Console Setup

**For those who prefer AWS Console:**

### Step 1: Launch Instance

1. **Go to EC2 Console** → Launch Instance
2. **Name:** `safebox-production-1`
3. **AMI:** Ubuntu Server 22.04 LTS
4. **Instance Type:** `m6i.2xlarge` (or higher)
   - ✅ Must be Nitro-based
   - ✅ Memory encryption enabled by default

### Step 2: Configure Instance Details

**Key settings:**

1. **Network:**
   - VPC: (your VPC)
   - Subnet: (your subnet)
   - Auto-assign Public IP: Enable

2. **Advanced Details:**
   - **Nitro Enclaves:** Enable ✅ *(critical setting)*
   - IAM instance profile: SafeboxInstanceProfile (if you created one)

3. **User Data:** (paste this script)

```bash
#!/bin/bash
set -euo pipefail

# Update system
apt-get update
apt-get upgrade -y

# Install ZFS
apt-get install -y zfsutils-linux

# Install Docker
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# Install Nitro Enclaves CLI
apt-get install -y aws-nitro-enclaves-cli
systemctl enable nitro-enclaves-allocator
systemctl start nitro-enclaves-allocator

# Create safebox user
groupadd -g 1000 safebox-services || true
useradd -u 1000 -g safebox-services -s /bin/bash -m safebox || true
usermod -aG docker safebox

# Signal completion
touch /var/lib/cloud/instance/provisioning-complete
```

### Step 3: Add Storage

**Root volume:**
- Size: 100 GB
- Volume Type: gp3
- IOPS: 3000
- Throughput: 125 MB/s
- ✅ Encrypted: Yes
- Delete on Termination: Yes

**Add New Volume (for ZFS):**
- Click "Add New Volume"
- Device: /dev/sdf
- Size: 500 GB
- Volume Type: gp3
- IOPS: 16000
- Throughput: 1000 MB/s
- ✅ Encrypted: Yes
- Delete on Termination: No (for data persistence)

### Step 4: Configure Security Group

**Create new security group:** `safebox-sg`

**Inbound rules:**

| Type | Protocol | Port | Source | Description |
|------|----------|------|--------|-------------|
| SSH | TCP | 22 | My IP | SSH access |
| HTTPS | TCP | 443 | 0.0.0.0/0 | Web traffic |
| HTTP | TCP | 80 | 0.0.0.0/0 | Let's Encrypt |

**Outbound rules:**
- All traffic (default)

### Step 5: Review and Launch

1. Review settings
2. Select your SSH key pair
3. Click "Launch Instance"

### Step 6: Wait for Instance to Start

Monitor in EC2 Console until:
- ✅ Instance State: Running
- ✅ Status Checks: 2/2 checks passed

**Get Public IP** from instance details.

### Step 7: Connect via SSH

```bash
ssh ubuntu@<PUBLIC_IP>
```

**Verify Nitro Enclaves:**

```bash
# Check Nitro Enclaves enabled
nitro-cli describe-enclaves

# Should show: "Enclave" support enabled
```

**Verify memory encryption:**

```bash
# AMD (SEV)
cat /proc/cpuinfo | grep -i sev

# Intel (TME)
dmesg | grep -i "Memory Encryption"

# Either should show encryption features
```

### Step 8: Configure ZFS

```bash
# Check data volume appeared
lsblk
# Should show nvme1n1 (500GB volume)

# Create ZFS pool
sudo zpool create zpool /dev/nvme1n1

# Enable compression
sudo zfs set compression=lz4 zpool

# Create base dataset
sudo zfs create zpool/qbix-platform

# Verify
sudo zpool status
```

### Step 9: Install Infrastructure

```bash
# Upload Infrastructure.zip
# (from your local machine)
scp Infrastructure.zip ubuntu@<PUBLIC_IP>:/tmp/

# On instance
cd /tmp
sudo apt-get install -y unzip
unzip Infrastructure.zip -d /opt/safebox-infrastructure

# Run install script
cd /opt/safebox-infrastructure
sudo bash scripts/install.sh
```

### Step 10: Deploy Safebox

```bash
cd /opt/safebox-infrastructure

# Copy environment template
cp .env.example .env

# Edit configuration
nano .env
# Set: MYSQL_ROOT_PASSWORD, DOMAIN, etc.

# Start services
docker-compose up -d

# Verify running
docker-compose ps
```

### Step 11: Create AMI (Optional)

**For deploying more instances:**

1. **Stop instance:**
   ```bash
   # From console: Actions → Instance State → Stop
   # Wait for stopped state
   ```

2. **Create AMI:**
   - Actions → Image and templates → Create image
   - Name: `safebox-prod-20260426`
   - Description: Safebox with Nitro + ZFS + Docker

3. **Wait for AMI:** (5-10 minutes)
   - Check AMIs in left sidebar
   - Status: Available ✅

4. **Launch more instances:**
   - EC2 → AMIs → Select your AMI → Launch
   - Same settings as original
   - New instances boot with everything pre-installed

---

## 🔐 Security Checklist

**After provisioning, verify:**

- ✅ SSH only accessible from your IP
- ✅ HTTPS configured with Let's Encrypt
- ✅ Firewall rules in security group
- ✅ EBS volumes encrypted
- ✅ Nitro Enclaves enabled
- ✅ Memory encryption active
- ✅ No unnecessary ports open
- ✅ Docker containers isolated

---

## 📊 Instance Types

**Recommended Nitro instances:**

| Instance | vCPUs | RAM | Cost/mo* | Use Case |
|----------|-------|-----|----------|----------|
| **m6i.xlarge** | 4 | 16GB | ~$130 | Development |
| **m6i.2xlarge** | 8 | 32GB | ~$260 | Small production |
| **m6i.4xlarge** | 16 | 64GB | ~$520 | Medium production |
| **m6i.8xlarge** | 32 | 128GB | ~$1,040 | Large production |

*Approximate on-demand pricing in us-east-1

**With GPUs for model runners:**

| Instance | GPUs | GPU RAM | Cost/mo* | Use Case |
|----------|------|---------|----------|----------|
| **g4dn.xlarge** | 1× T4 | 16GB | ~$370 | Single model |
| **g4dn.2xlarge** | 1× T4 | 16GB | ~$540 | Single model + more CPU |
| **g5.xlarge** | 1× A10G | 24GB | ~$730 | Better model perf |
| **g5.2xlarge** | 1× A10G | 24GB | ~$900 | Best single GPU |

**All Nitro-based ✅ with memory encryption**

---

## 🔧 Troubleshooting

### Instance won't start

**Check:**
- Instance type is Nitro-based (m6i, c6i, r6i, g4dn, g5, etc.)
- Subnet has available IPs
- Service limits not exceeded (EC2 → Limits)

### Can't SSH

**Check:**
- Security group allows SSH from your IP
- Your IP hasn't changed (happens with home internet)
- Key pair matches downloaded .pem file
- Using correct user: `ubuntu@` not `root@`

### Nitro Enclaves not enabled

**Verify:**
```bash
nitro-cli describe-enclaves
```

**If missing:** Instance wasn't launched with enclaves enabled.
- Must set at launch time
- Cannot enable after launch
- Terminate and relaunch with Advanced Details → Nitro Enclaves: Enable

### ZFS pool creation fails

**Check:**
```bash
lsblk  # Is nvme1n1 present?
sudo fdisk -l  # Volume attached?
```

**If missing:** Volume didn't attach correctly.
```bash
# From console: EC2 → Volumes → Select volume → Actions → Attach
# Device: /dev/sdf
# Instance: (your instance)
```

### Docker won't start

**Check:**
```bash
sudo systemctl status docker
sudo journalctl -u docker
```

**Common fix:**
```bash
sudo systemctl restart docker
```

---

## 💰 Cost Optimization

### Reserved Instances

**Save 30-40% for 1-year commit:**

```bash
# From console: EC2 → Reserved Instances → Purchase
# Instance Type: m6i.2xlarge
# Term: 1 year
# Payment: All upfront (best discount)
```

### Spot Instances

**Save 70-90% for interruptible workloads:**

**Not recommended for production Safebox** (interruption risk), but good for:
- Dev/test environments
- Batch model training
- Non-critical workloads

### Auto Scaling

**Scale down during off-hours:**

```bash
# Future: Auto Scaling Group with schedule
# Scale to 0 instances 8pm-8am on weekends
# Save ~30% of weekly costs
```

---

## 🎉 Summary

**Automated provisioning:**
```bash
export SUBNET_ID=subnet-xxxxx KEY_NAME=your-key
./scripts/provision-safebox-ami.sh
# ☕ Wait 15 minutes → Done
```

**Manual provisioning:**
1. Launch m6i.2xlarge + enable Nitro Enclaves
2. Add 500GB encrypted data volume
3. SSH → configure ZFS
4. Install Infrastructure
5. Deploy with docker-compose

**Result:**
✅ Production Safebox instance with Nitro security  
✅ AMI for quick cloning  
✅ Ready for model runners + local inference  

🚀 **Production-ready AWS infrastructure!**
