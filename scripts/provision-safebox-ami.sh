#!/bin/bash
set -euo pipefail

# Safebox AMI Provisioning Script
# Provisions AWS EC2 instance with Nitro Enclaves, encrypted RAM, and ZFS

################################################################################
# CONFIGURATION
################################################################################

INSTANCE_TYPE="${INSTANCE_TYPE:-m6i.2xlarge}"  # Nitro-based, memory encryption
AMI_ID="${AMI_ID:-}"  # Auto-detect latest Ubuntu 22.04 if not set
REGION="${AWS_REGION:-us-east-1}"
AVAILABILITY_ZONE="${AVAILABILITY_ZONE:-${REGION}a}"
KEY_NAME="${KEY_NAME:-safebox-key}"
SECURITY_GROUP="${SECURITY_GROUP:-safebox-sg}"
SUBNET_ID="${SUBNET_ID:-}"  # Required
IAM_INSTANCE_PROFILE="${IAM_INSTANCE_PROFILE:-SafeboxInstanceProfile}"

# Storage
ROOT_VOLUME_SIZE=100  # GB
DATA_VOLUME_SIZE=500  # GB for ZFS pool
VOLUME_TYPE="gp3"
VOLUME_IOPS=16000
VOLUME_THROUGHPUT=1000

# Tags
INSTANCE_NAME="${INSTANCE_NAME:-safebox-production-1}"
ENVIRONMENT="${ENVIRONMENT:-production}"

################################################################################
# FUNCTIONS
################################################################################

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

error() {
    log "ERROR: $*" >&2
    exit 1
}

check_requirements() {
    log "Checking requirements..."
    
    # Check AWS CLI
    if ! command -v aws &> /dev/null; then
        error "AWS CLI not found. Install: https://aws.amazon.com/cli/"
    fi
    
    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        error "AWS credentials not configured. Run: aws configure"
    fi
    
    # Check required parameters
    if [ -z "$SUBNET_ID" ]; then
        error "SUBNET_ID required. Set with: export SUBNET_ID=subnet-xxxxx"
    fi
    
    log "✓ Requirements met"
}

get_latest_ami() {
    log "Finding latest Ubuntu 22.04 LTS AMI..."
    
    AMI_ID=$(aws ec2 describe-images \
        --region "$REGION" \
        --owners 099720109477 \
        --filters \
            "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
            "Name=state,Values=available" \
        --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' \
        --output text)
    
    if [ -z "$AMI_ID" ] || [ "$AMI_ID" == "None" ]; then
        error "Could not find Ubuntu 22.04 AMI"
    fi
    
    log "✓ Using AMI: $AMI_ID"
}

create_security_group() {
    log "Creating security group..."
    
    # Check if exists
    if aws ec2 describe-security-groups \
        --region "$REGION" \
        --group-names "$SECURITY_GROUP" &> /dev/null; then
        log "✓ Security group $SECURITY_GROUP already exists"
        return
    fi
    
    # Get VPC ID from subnet
    VPC_ID=$(aws ec2 describe-subnets \
        --region "$REGION" \
        --subnet-ids "$SUBNET_ID" \
        --query 'Subnets[0].VpcId' \
        --output text)
    
    # Create security group
    SG_ID=$(aws ec2 create-security-group \
        --region "$REGION" \
        --group-name "$SECURITY_GROUP" \
        --description "Safebox production instance security group" \
        --vpc-id "$VPC_ID" \
        --query 'GroupId' \
        --output text)
    
    # Allow SSH (only from your IP - UPDATE THIS!)
    MY_IP=$(curl -s https://checkip.amazonaws.com)
    aws ec2 authorize-security-group-ingress \
        --region "$REGION" \
        --group-id "$SG_ID" \
        --protocol tcp \
        --port 22 \
        --cidr "${MY_IP}/32"
    
    # Allow HTTPS (for nginx)
    aws ec2 authorize-security-group-ingress \
        --region "$REGION" \
        --group-id "$SG_ID" \
        --protocol tcp \
        --port 443 \
        --cidr "0.0.0.0/0"
    
    # Allow HTTP (for Let's Encrypt)
    aws ec2 authorize-security-group-ingress \
        --region "$REGION" \
        --group-id "$SG_ID" \
        --protocol tcp \
        --port 80 \
        --cidr "0.0.0.0/0"
    
    log "✓ Created security group: $SG_ID"
}

launch_instance() {
    log "Launching EC2 instance..."
    
    # Create user data script
    cat > /tmp/safebox-userdata.sh << 'USERDATA'
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

# Enable Nitro Enclaves
systemctl enable nitro-enclaves-allocator
systemctl start nitro-enclaves-allocator

# Create safebox-services group
groupadd -g 1000 safebox-services || true
useradd -u 1000 -g safebox-services -s /bin/bash -m safebox || true
usermod -aG docker safebox

# Mark provisioning complete
touch /var/lib/cloud/instance/provisioning-complete
USERDATA
    
    # Launch instance
    INSTANCE_ID=$(aws ec2 run-instances \
        --region "$REGION" \
        --image-id "$AMI_ID" \
        --instance-type "$INSTANCE_TYPE" \
        --key-name "$KEY_NAME" \
        --security-group-ids "$SG_ID" \
        --subnet-id "$SUBNET_ID" \
        --iam-instance-profile "Name=$IAM_INSTANCE_PROFILE" \
        --enclave-options 'Enabled=true' \
        --block-device-mappings \
            "DeviceName=/dev/sda1,Ebs={VolumeSize=$ROOT_VOLUME_SIZE,VolumeType=$VOLUME_TYPE,DeleteOnTermination=true,Encrypted=true}" \
        --user-data "file:///tmp/safebox-userdata.sh" \
        --tag-specifications \
            "ResourceType=instance,Tags=[{Key=Name,Value=$INSTANCE_NAME},{Key=Environment,Value=$ENVIRONMENT},{Key=ManagedBy,Value=safebox-provisioning}]" \
        --query 'Instances[0].InstanceId' \
        --output text)
    
    if [ -z "$INSTANCE_ID" ]; then
        error "Failed to launch instance"
    fi
    
    log "✓ Launched instance: $INSTANCE_ID"
    
    # Wait for instance to be running
    log "Waiting for instance to start..."
    aws ec2 wait instance-running \
        --region "$REGION" \
        --instance-ids "$INSTANCE_ID"
    
    log "✓ Instance running"
}

create_and_attach_data_volume() {
    log "Creating data volume for ZFS..."
    
    # Create volume
    VOLUME_ID=$(aws ec2 create-volume \
        --region "$REGION" \
        --availability-zone "$AVAILABILITY_ZONE" \
        --size "$DATA_VOLUME_SIZE" \
        --volume-type "$VOLUME_TYPE" \
        --iops "$VOLUME_IOPS" \
        --throughput "$VOLUME_THROUGHPUT" \
        --encrypted \
        --tag-specifications \
            "ResourceType=volume,Tags=[{Key=Name,Value=$INSTANCE_NAME-data},{Key=Purpose,Value=zfs-pool}]" \
        --query 'VolumeId' \
        --output text)
    
    log "✓ Created volume: $VOLUME_ID"
    
    # Wait for volume to be available
    log "Waiting for volume to be available..."
    aws ec2 wait volume-available \
        --region "$REGION" \
        --volume-ids "$VOLUME_ID"
    
    # Attach volume
    aws ec2 attach-volume \
        --region "$REGION" \
        --volume-id "$VOLUME_ID" \
        --instance-id "$INSTANCE_ID" \
        --device /dev/sdf
    
    log "✓ Attached volume to instance"
}

get_instance_ip() {
    PUBLIC_IP=$(aws ec2 describe-instances \
        --region "$REGION" \
        --instance-ids "$INSTANCE_ID" \
        --query 'Reservations[0].Instances[0].PublicIpAddress' \
        --output text)
    
    if [ -z "$PUBLIC_IP" ] || [ "$PUBLIC_IP" == "None" ]; then
        error "Could not get instance public IP"
    fi
    
    log "✓ Instance IP: $PUBLIC_IP"
}

wait_for_ssh() {
    log "Waiting for SSH to be ready..."
    
    for i in {1..30}; do
        if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
            "ubuntu@$PUBLIC_IP" "echo 'SSH ready'" &> /dev/null; then
            log "✓ SSH ready"
            return 0
        fi
        sleep 10
    done
    
    error "SSH not ready after 5 minutes"
}

configure_zfs() {
    log "Configuring ZFS on instance..."
    
    ssh -o StrictHostKeyChecking=no "ubuntu@$PUBLIC_IP" << 'REMOTE_SCRIPT'
        set -euo pipefail
        
        # Wait for volume to appear
        for i in {1..30}; do
            if [ -e /dev/nvme1n1 ]; then
                echo "✓ Data volume detected: /dev/nvme1n1"
                break
            fi
            sleep 2
        done
        
        if [ ! -e /dev/nvme1n1 ]; then
            echo "ERROR: Data volume not found"
            exit 1
        fi
        
        # Create ZFS pool
        sudo zpool create zpool /dev/nvme1n1
        sudo zpool status
        
        # Set compression
        sudo zfs set compression=lz4 zpool
        
        # Create base Platform snapshot (will be cloned later)
        sudo zfs create zpool/qbix-platform
        
        echo "✓ ZFS pool created"
REMOTE_SCRIPT
    
    log "✓ ZFS configured"
}

install_infrastructure() {
    log "Installing Infrastructure package..."
    
    # Copy Infrastructure.zip to instance
    scp -o StrictHostKeyChecking=no \
        Infrastructure.zip \
        "ubuntu@$PUBLIC_IP:/tmp/"
    
    ssh -o StrictHostKeyChecking=no "ubuntu@$PUBLIC_IP" << 'REMOTE_SCRIPT'
        set -euo pipefail
        
        # Extract Infrastructure
        cd /tmp
        sudo apt-get install -y unzip
        unzip -q Infrastructure.zip -d /opt/safebox-infrastructure
        
        # Run install script
        cd /opt/safebox-infrastructure
        sudo bash scripts/install.sh
        
        echo "✓ Infrastructure installed"
REMOTE_SCRIPT
    
    log "✓ Infrastructure installed"
}

create_ami() {
    log "Creating AMI from instance..."
    
    # Stop instance for AMI creation
    log "Stopping instance..."
    aws ec2 stop-instances \
        --region "$REGION" \
        --instance-ids "$INSTANCE_ID"
    
    aws ec2 wait instance-stopped \
        --region "$REGION" \
        --instance-ids "$INSTANCE_ID"
    
    log "✓ Instance stopped"
    
    # Create AMI
    AMI_NAME="safebox-$(date +%Y%m%d-%H%M%S)"
    NEW_AMI_ID=$(aws ec2 create-image \
        --region "$REGION" \
        --instance-id "$INSTANCE_ID" \
        --name "$AMI_NAME" \
        --description "Safebox production AMI with Nitro, ZFS, Docker" \
        --tag-specifications \
            "ResourceType=image,Tags=[{Key=Name,Value=$AMI_NAME},{Key=Purpose,Value=safebox-production}]" \
        --query 'ImageId' \
        --output text)
    
    log "✓ AMI creation started: $NEW_AMI_ID"
    log "Waiting for AMI to be available (this takes 5-10 minutes)..."
    
    aws ec2 wait image-available \
        --region "$REGION" \
        --image-ids "$NEW_AMI_ID"
    
    log "✓ AMI ready: $NEW_AMI_ID"
}

################################################################################
# MAIN
################################################################################

main() {
    log "=== Safebox AMI Provisioning ==="
    log "Instance type: $INSTANCE_TYPE"
    log "Region: $REGION"
    log "Subnet: $SUBNET_ID"
    log ""
    
    check_requirements
    
    if [ -z "$AMI_ID" ]; then
        get_latest_ami
    fi
    
    create_security_group
    launch_instance
    create_and_attach_data_volume
    get_instance_ip
    wait_for_ssh
    configure_zfs
    install_infrastructure
    create_ami
    
    log ""
    log "=== Provisioning Complete ==="
    log "Instance ID: $INSTANCE_ID"
    log "Public IP: $PUBLIC_IP"
    log "AMI ID: $NEW_AMI_ID"
    log "Security Group: $SECURITY_GROUP"
    log ""
    log "SSH: ssh ubuntu@$PUBLIC_IP"
    log ""
    log "To launch more instances from this AMI:"
    log "  aws ec2 run-instances --image-id $NEW_AMI_ID --instance-type $INSTANCE_TYPE ..."
}

main "$@"
