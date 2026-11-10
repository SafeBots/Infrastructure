#!/bin/bash
# Base layer for gcp: a shim. All four clouds build the same Ubuntu 24.04
# base from common/base/install-base.sh (one installer, parameterised by
# SAFEBOX_CLOUD; see its header for why Ubuntu and why one file). This file
# exists so build-image.sh keeps calling the same per-cloud path.
set -euo pipefail
export SAFEBOX_CLOUD=gcp
exec "${SAFEBOX_SRC:-/opt/safebox-src}/common/base/install-base.sh" "$@"
