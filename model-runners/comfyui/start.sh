#!/bin/bash
#
# start.sh — ComfyUI Safebox runner entrypoint.
#
# Resolves the model manifest, sets the wrapper's env, then hands control
# to supervisord which runs ComfyUI and the Safebox wrapper.
#
# Required env:
#   MODEL_NAME — canonical Safebox model name (e.g. "flux-1-schnell")
#                Manifest looked up at /etc/safebox/runners/comfyui/manifests/${MODEL_NAME}.json
#                or /app/manifests/${MODEL_NAME}.json
#
# Optional env:
#   COMFYUI_EXTRA_ARGS — extra args to pass to ComfyUI main.py
#   SAFEBOX_REQUIRE_HMAC — true|false (default false)
#

set -euo pipefail

log() { echo "[$(date +'%H:%M:%S')] start.sh: $*"; }

if [ -z "${MODEL_NAME:-}" ]; then
    echo "ERROR: MODEL_NAME env var is required" >&2
    echo "Available manifests:" >&2
    ls /etc/safebox/runners/comfyui/manifests/*.json 2>/dev/null \
        || ls /app/manifests/*.json 2>/dev/null \
        || echo "  (none found)" >&2
    exit 2
fi

# ─── Find the manifest ────────────────────────────────────────────────
MANIFEST=""
for d in /etc/safebox/runners/comfyui/manifests /app/manifests; do
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

# ─── Parse manifest ───────────────────────────────────────────────────
export WORKFLOW_FAMILY=$(jq -r '.comfyui.workflowFamily // "sdxl"' "$MANIFEST")
export CHECKPOINT_NAME=$(jq -r '.comfyui.checkpointName // ""' "$MANIFEST")
export UNET_NAME=$(jq -r '.comfyui.unetName // ""' "$MANIFEST")
export VAE_NAME=$(jq -r '.comfyui.vaeName // ""' "$MANIFEST")
export CLIP_NAMES=$(jq -r '.comfyui.clipNames // ""' "$MANIFEST")
export DEFAULT_STEPS=$(jq -r '.comfyui.defaultSteps // 25' "$MANIFEST")
export DEFAULT_CFG=$(jq -r '.comfyui.defaultCfg // 7.0' "$MANIFEST")
export DEFAULT_WIDTH=$(jq -r '.comfyui.defaultWidth // 1024' "$MANIFEST")
export DEFAULT_HEIGHT=$(jq -r '.comfyui.defaultHeight // 1024' "$MANIFEST")
export DEFAULT_SAMPLER=$(jq -r '.comfyui.defaultSampler // "euler"' "$MANIFEST")
export DEFAULT_SCHEDULER=$(jq -r '.comfyui.defaultScheduler // "normal"' "$MANIFEST")

export CAP_TEXT2IMG=$(jq -r '.capabilities.text2img // true' "$MANIFEST")
export CAP_IMG2IMG=$(jq -r '.capabilities.img2img // false' "$MANIFEST")
export CAP_INPAINT=$(jq -r '.capabilities.inpaint // false' "$MANIFEST")
export CAP_CONTROLNET=$(jq -r '.capabilities.controlnet // false' "$MANIFEST")
export CAP_LORA=$(jq -r '.capabilities.lora // false' "$MANIFEST")

export MODEL_NAME

# Build ComfyUI launch line
COMFYUI_CMD="python /opt/ComfyUI/main.py --listen 127.0.0.1 --port 8188 --output-directory /data/output"
if [ -n "${COMFYUI_EXTRA_ARGS:-}" ]; then
    COMFYUI_CMD="$COMFYUI_CMD $COMFYUI_EXTRA_ARGS"
fi
export COMFYUI_CMDLINE="$COMFYUI_CMD"

log "Model: $MODEL_NAME  family: $WORKFLOW_FAMILY"
log "Checkpoint: ${CHECKPOINT_NAME:-<n/a>}  UNET: ${UNET_NAME:-<n/a>}"
log "Defaults: ${DEFAULT_WIDTH}×${DEFAULT_HEIGHT}, ${DEFAULT_STEPS} steps, cfg=$DEFAULT_CFG"
log "ComfyUI: $COMFYUI_CMDLINE"

# ─── Ensure socket dir + output dir exist ─────────────────────────────
mkdir -p /run/safebox/services /data/output
if id safebox-services > /dev/null 2>&1; then
    chown safebox-services:safebox-services /run/safebox/services /data/output 2>/dev/null || true
fi

log "Launching supervisord"
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
