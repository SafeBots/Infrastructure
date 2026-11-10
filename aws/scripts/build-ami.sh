#!/usr/bin/env bash
# build-ami.sh — compatibility shim. The entry point is now build-image.sh
# (docs/HARDENING-PLAN.md "Build flow"); older docs and runbooks still call
# build-ami.sh, so keep the name working and pass every argument through.
exec "$(dirname "${BASH_SOURCE[0]}")/build-image.sh" "$@"
