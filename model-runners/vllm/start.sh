#!/bin/bash
#
# start.sh — vLLM Safebox runner entrypoint.
#
# Resolves the model manifest, configures vLLM launch args, then hands
# control to supervisord which runs both vLLM and the Safebox wrapper.
#
# Required env:
#   MODEL_NAME         — canonical Safebox model name (e.g. "llama-3.3-70b-instruct")
#                        Manifest looked up at /etc/safebox/runners/vllm/manifests/${MODEL_NAME}.json
#                        OR (for development) at /app/manifests/${MODEL_NAME}.json
#
# Optional env:
#   MODEL_WEIGHTS_PATH — override path to weight directory (default: from manifest)
#   VLLM_EXTRA_ARGS    — additional CLI args to pass to vllm serve
#   SAFEBOX_REQUIRE_HMAC — true|false (default false)
#

set -euo pipefail

log() { echo "[$(date +'%H:%M:%S')] start.sh: $*"; }

if [ -z "${MODEL_NAME:-}" ]; then
    echo "ERROR: MODEL_NAME env var is required" >&2
    echo "Available manifests:" >&2
    ls /etc/safebox/runners/vllm/manifests/*.json 2>/dev/null \
        || ls /app/manifests/*.json 2>/dev/null \
        || echo "  (none found)" >&2
    exit 2
fi

# ─── Find the manifest ────────────────────────────────────────────────
MANIFEST=""
for d in /etc/safebox/runners/vllm/manifests /app/manifests; do
    if [ -f "$d/${MODEL_NAME}.json" ]; then
        MANIFEST="$d/${MODEL_NAME}.json"
        break
    fi
done
if [ -z "$MANIFEST" ]; then
    echo "ERROR: no manifest found for MODEL_NAME='${MODEL_NAME}'" >&2
    exit 2
fi
log "Using manifest: $MANIFEST"

# ─── Parse manifest (jq is in the image) ──────────────────────────────
VLLM_MODEL_ARG=$(jq -r '.vllmModel // .name' "$MANIFEST")
TP_SIZE=$(jq -r '.vllm.tensorParallelSize // 1' "$MANIFEST")
MAX_MODEL_LEN=$(jq -r '.vllm.maxModelLen // 8192' "$MANIFEST")
DTYPE=$(jq -r '.vllm.dtype // "auto"' "$MANIFEST")
QUANTIZATION=$(jq -r '.vllm.quantization // ""' "$MANIFEST")
GPU_MEM_UTIL=$(jq -r '.vllm.gpuMemoryUtilization // 0.9' "$MANIFEST")
TRUST_REMOTE_CODE=$(jq -r '.vllm.trustRemoteCode // false' "$MANIFEST")
ENFORCE_EAGER=$(jq -r '.vllm.enforceEager // false' "$MANIFEST")
EXTRA_VLLM_FLAGS=$(jq -r '.vllm.extraFlags // [] | join(" ")' "$MANIFEST")

# Capabilities → env (consumed by runner.py)
export CAP_CHAT=$(jq -r '.capabilities.chat // true' "$MANIFEST")
export CAP_COMPLETE=$(jq -r '.capabilities.complete // true' "$MANIFEST")
export CAP_EMBED=$(jq -r '.capabilities.embed // false' "$MANIFEST")
export CAP_TOOL_USE=$(jq -r '.capabilities.toolUse // false' "$MANIFEST")
export CAP_VISION=$(jq -r '.capabilities.vision // false' "$MANIFEST")

# Resolve model weights path
if [ -n "${MODEL_WEIGHTS_PATH:-}" ]; then
    MODEL_PATH="$MODEL_WEIGHTS_PATH"
elif manifest_hash=$(jq -r '.manifestHash // empty' "$MANIFEST") && [ -n "$manifest_hash" ] \
     && [ -d "/srv/safebox/models/$manifest_hash" ]; then
    MODEL_PATH="/srv/safebox/models/$manifest_hash"
else
    # Fall back to letting vLLM resolve from HuggingFace cache
    MODEL_PATH="$VLLM_MODEL_ARG"
fi
log "Model path: $MODEL_PATH"
log "Tensor parallel: $TP_SIZE  Max model len: $MAX_MODEL_LEN  dtype: $DTYPE"

# ─── Build the vLLM command ───────────────────────────────────────────
VLLM_CMD=(
    "vllm" "serve" "$MODEL_PATH"
    "--served-model-name" "$VLLM_MODEL_ARG"
    "--tensor-parallel-size" "$TP_SIZE"
    "--max-model-len" "$MAX_MODEL_LEN"
    "--dtype" "$DTYPE"
    "--gpu-memory-utilization" "$GPU_MEM_UTIL"
    "--host" "127.0.0.1"
    "--port" "8000"
    "--disable-log-requests"
)
[ -n "$QUANTIZATION" ] && VLLM_CMD+=("--quantization" "$QUANTIZATION")
[ "$TRUST_REMOTE_CODE" = "true" ] && VLLM_CMD+=("--trust-remote-code")
[ "$ENFORCE_EAGER"     = "true" ] && VLLM_CMD+=("--enforce-eager")
# Append any extra flags from manifest or env
if [ -n "$EXTRA_VLLM_FLAGS" ]; then
    # shellcheck disable=SC2086
    VLLM_CMD+=($EXTRA_VLLM_FLAGS)
fi
if [ -n "${VLLM_EXTRA_ARGS:-}" ]; then
    # shellcheck disable=SC2086
    VLLM_CMD+=($VLLM_EXTRA_ARGS)
fi

# Export for supervisord
export VLLM_MODEL_ARG
export VLLM_CMDLINE="${VLLM_CMD[*]}"
export MODEL_NAME

log "vLLM cmd: $VLLM_CMDLINE"
log "Wrapper config: MODEL_NAME=$MODEL_NAME VLLM_MODEL_ARG=$VLLM_MODEL_ARG"
log "Capabilities: chat=$CAP_CHAT complete=$CAP_COMPLETE embed=$CAP_EMBED tool=$CAP_TOOL_USE vision=$CAP_VISION"

# ─── Ensure socket dir exists ─────────────────────────────────────────
mkdir -p /run/safebox/services
if id safebox-services > /dev/null 2>&1; then
    chown safebox-services:safebox-services /run/safebox/services
fi

# ─── Hand off to supervisord ──────────────────────────────────────────
log "Launching supervisord"
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
