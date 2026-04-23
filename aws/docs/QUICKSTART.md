# Safebox AMI Builder - Quick Start Guide

## 🚀 Fast Track: Build Your First AMI in 30 Minutes

This guide gets you from zero to a production-ready Safebox AMI 3 as quickly as possible.

## Step 1: Prerequisites (5 minutes)

### Install AWS CLI
```bash
# macOS
brew install awscli

# Linux
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install
```

### Install jq
```bash
# macOS
brew install jq

# Linux
sudo dnf install jq  # or: sudo apt install jq
```

### Configure AWS
```bash
aws configure
# Enter your AWS Access Key ID
# Enter your AWS Secret Access Key
# Default region: us-east-1
# Output format: json
```

### Apply IAM Policy
```bash
aws iam create-policy \
    --policy-name SafeboxAMIBuilderPolicy \
    --policy-document file://iam-policy-safebox-builder.json

aws iam attach-user-policy \
    --user-name YOUR_AWS_USERNAME \
    --policy-arn arn:aws:iam::YOUR_ACCOUNT_ID:policy/SafeboxAMIBuilderPolicy
```

## Step 2: Prepare Safebox Binary (5 minutes)

Before running the build, you need your Safebox binary ready:

```bash
# Option 1: If you have Safebox source code
cd /path/to/safebox
./build.sh release
tar czf safebox.tar.gz bin/ config/ encryption-module.so

# Option 2: Download from release server
curl -o safebox.tar.gz https://releases.safebox.example.com/safebox-v1.0.0.tar.gz

# Calculate checksum
sha256sum safebox.tar.gz
# Save this hash - you'll need it!
```

Update `build-manifest.json`:
```json
{
  "safebox_binary": {
    "url": "file:///tmp/safebox.tar.gz",
    "version": "1.0.0",
    "sha256": "YOUR_ACTUAL_HASH_HERE"
  }
}
```

## Step 3: Run Automated Build (15 minutes active, 3-4 hours total)

### Option A: Fully Automated (Least Secure)
```bash
chmod +x *.sh
./build-safebox-amis.sh all
```

⚠️ **Warning:** This skips manual verification steps. Only use for testing.

### Option B: Step-by-Step (Recommended)

**Phase 1: Download packages online**
```bash
./build-safebox-amis.sh phase1
```

When prompted:
1. SSH to the instance (command shown in output)
2. Upload Safebox binary:
   ```bash
   scp -i safebox-builder-key.pem safebox.tar.gz ec2-user@INSTANCE_IP:/opt/safebox-staging/
   ```
3. Verify checksum matches manifest
4. Press ENTER to continue

**Phase 2: Install offline**
```bash
./build-safebox-amis.sh phase2
```

When prompted (auditor verification):
1. SSH to the instance
2. Verify packages installed from local cache
3. Check Safebox binary: `sha256sum /srv/safebox/bin/*`
4. Verify configuration: `cat /srv/safebox/config/encryption.conf`
5. Press ENTER to continue

**Phase 3: Finalize immutable image**
```bash
./build-safebox-amis.sh phase3
```

When prompted:
1. SSH to the instance
2. Upload finalize script:
   ```bash
   scp -i safebox-builder-key.pem finalize.sh ec2-user@INSTANCE_IP:~/
   ```
3. Run finalization:
   ```bash
   sudo bash finalize.sh
   ```
4. Verify cleanup (no /opt/rpm-cache, no dnf, sshd masked)
5. Press ENTER to create final AMI

## Step 4: Verify Build (5 minutes)

```bash
# Check AMI IDs
cat ami1-id.txt
cat ami2-id.txt  
cat ami3-id.txt

# Generate report
./build-safebox-amis.sh report
cat build-report.md

# View in AWS Console
AMI3_ID=$(cat ami3-id.txt)
echo "https://console.aws.amazon.com/ec2/v2/home?region=us-east-1#Images:visibility=owned-by-me;imageId=$AMI3_ID"
```

## Step 5: Deploy to Production (5 minutes)

```bash
# Launch production instance
AMI3_ID=$(cat ami3-id.txt)
./deploy-production.sh $AMI3_ID m6i.large safebox-prod-key

# Get instance IP from output
INSTANCE_IP=<from output>

# Measure TPM
./measure-tpm.sh $INSTANCE_IP safebox-prod-key.pem
```

## Step 6: Add Your First Tenant (5 minutes)

SSH to production instance:
```bash
ssh -i safebox-prod-key.pem ec2-user@$INSTANCE_IP
```

Add tenant:
```bash
# Upload tenant script
sudo bash add-tenant.sh acme acme.example.com 3001

# Start services
sudo systemctl start mariadb
sudo systemctl start php-fpm
sudo systemctl start nginx
sudo systemctl start acme-node
```

Test:
```bash
# From your laptop
curl -H "Host: acme.example.com" http://$INSTANCE_IP/
curl http://$INSTANCE_IP:3001/  # Should fail (internal port)
```

## Common Issues & Solutions

### "AMI creation timeout"
**Cause:** Large EBS volume takes time to snapshot
**Solution:** Wait up to 30 minutes, or check AWS console for errors

### "Cannot SSH to instance"
**Cause:** Security group doesn't allow your IP
**Solution:** 
```bash
MY_IP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress \
    --group-id sg-xxxxx \
    --protocol tcp --port 22 --cidr $MY_IP/32
```

### "tpm2_pcrread command not found"
**Cause:** tpm2-tools not installed
**Solution:** `sudo dnf install -y tpm2-tools`

### "RPM download fails"
**Cause:** Network issues or repo unavailable
**Solution:** SSH to instance, check logs: `tail -f /var/log/phase1-build.log`

## What You Get

After completing these steps, you have:

✅ **AMI 1**: All packages cached offline  
✅ **AMI 2**: Software installed, configured for multi-tenancy  
✅ **AMI 3**: Final immutable image with TPM measurements  

**Security features:**
- Nitro hardware RAM encryption
- EBS disk encryption
- Safebox file-level encryption (keys provisioned separately)
- TPM measured boot
- No SSH in final image
- No package manager (immutable)
- Deterministic & reproducible

## Next Steps

1. **Setup Attestation**: Implement remote attestation server to verify TPM PCRs before provisioning keys

2. **Key Provisioning**: Configure secure key delivery after successful attestation

3. **TLS Certificates**: Setup Let's Encrypt or upload certificates for HTTPS

4. **Monitoring**: Configure CloudWatch, logs, and alerts

5. **Backups**: Setup encrypted XtraBackup to decentralized storage

6. **CI/CD**: Automate AMI builds on Safebox releases

7. **Multi-Region**: Replicate AMI 3 to other AWS regions

## Production Checklist

Before going live:

- [ ] All SHA256 hashes verified against manifest
- [ ] TPM PCR baseline recorded and stored
- [ ] Attestation server configured and tested
- [ ] Encryption key provisioning flow implemented
- [ ] TLS certificates installed
- [ ] Backup strategy tested
- [ ] Monitoring and alerting configured
- [ ] Disaster recovery plan documented
- [ ] Security audit completed
- [ ] Reproducibility verified (build AMI 3 twice, compare PCRs)

## Getting Help

**Check logs:**
```bash
# On build instance
sudo tail -f /var/log/phase1-build.log
sudo tail -f /var/log/phase2-build.log
sudo journalctl -u php-fpm -f
```

**AWS Console:**
- EC2 → Instances → Instance ID → System Log
- EC2 → AMIs → Check status
- CloudWatch → Logs

**Script debug mode:**
```bash
bash -x build-safebox-amis.sh phase1
```

## Time Estimates

- **Prerequisites setup:** 5-10 minutes
- **Phase 1 (online):** 20-30 minutes
- **Phase 2 (offline):** 15-20 minutes  
- **Phase 3 (finalize):** 10-15 minutes
- **Total first build:** 1-2 hours (with manual steps)

Subsequent builds: 30-45 minutes with automation

## Cost Estimate

**Per build:**
- Instance runtime (4 hours × $0.096/hr): ~$0.40
- EBS storage (90GB temp): ~$0.01/day
- AMI storage (3 × 30GB): ~$7.20/month

**Per month (1 prod instance):**
- m6i.large 24/7: ~$70
- EBS 50GB: ~$4
- Data transfer: ~$5-20
- **Total: ~$80-95/month**

## Support & Resources

- AWS Documentation: https://docs.aws.amazon.com/ec2/
- TPM 2.0 Spec: https://trustedcomputinggroup.org/
- Amazon Linux 2023: https://aws.amazon.com/linux/amazon-linux-2023/
- Nitro Security: https://aws.amazon.com/ec2/nitro/

---

**Ready to build?**

```bash
chmod +x *.sh
./build-safebox-amis.sh all
```

🔐 Happy building!
