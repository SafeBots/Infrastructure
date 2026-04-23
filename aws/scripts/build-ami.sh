#!/bin/bash
#
# Safebox AMI Builder - Master Build Script
# Usage: ./build-ami.sh <component-list>
#
# Examples:
#   ./build-ami.sh base,llm-tiny
#   ./build-ami.sh base,media,vision,embed,llm-medium
#   ./build-ami.sh base,media,vision,embed,speech,llm-xl,cuda,vllm
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPONENTS_DIR="${SCRIPT_DIR}/components"

# Parse components
IFS=',' read -ra COMPONENTS <<< "$1"

echo "Building Safebox AMI with components: ${COMPONENTS[*]}"

# Base is always required
if [[ ! " ${COMPONENTS[@]} " =~ " base " ]]; then
    echo "ERROR: 'base' component is required"
    exit 1
fi

# Build each component
for component in "${COMPONENTS[@]}"; do
    installer="${COMPONENTS_DIR}/${component}/install-${component}.sh"
    
    if [[ ! -f "$installer" ]]; then
        echo "ERROR: Component installer not found: $installer"
        exit 1
    fi
    
    echo "Installing component: $component"
    bash "$installer"
done

echo "✅ Safebox AMI build complete!"
