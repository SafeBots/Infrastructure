#!/bin/bash
#
# Safebox AMI Builder
#
# Usage: ./build-ami.sh <component-list>
#
# For 1.0, the only supported components are 'base' and 'system':
#
#   ./build-ami.sh base,system
#
# Future tiers (llm-tiny, vision, speech, vllm, etc.) are tracked in
# docs/future/ but not buildable yet — their component dirs are not present.
# Build will fail with an explicit error if you ask for one.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPONENTS_DIR="${SCRIPT_DIR}/components"

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <component-list>"
    echo "  e.g.: $0 base,system"
    exit 1
fi

IFS=',' read -ra COMPONENTS <<< "$1"

echo "Building Safebox AMI with components: ${COMPONENTS[*]}"

# Base is always required
if [[ ! " ${COMPONENTS[@]} " =~ " base " ]]; then
    echo "ERROR: 'base' component is required"
    exit 1
fi

# Each component is a dir under aws/scripts/components/ with install-<name>.sh
for component in "${COMPONENTS[@]}"; do
    installer="${COMPONENTS_DIR}/${component}/install-${component}.sh"

    if [[ ! -f "$installer" ]]; then
        echo "ERROR: Component installer not found: $installer"
        echo "       Currently shipped components: base, system"
        exit 1
    fi

    echo "Installing component: $component"
    bash "$installer"
done

echo ""
echo "AMI build complete. Components installed: ${COMPONENTS[*]}"
echo ""
echo "Verify the cascade SHA256 attestation:"
echo "  sha256sum /opt/safebox/manifests/*.json | sha256sum"
