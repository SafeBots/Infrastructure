#!/usr/bin/env bash
# Single source of truth for the runner HMAC verifier is model-runners/_shared/
# safebox_auth.py. Each runner's Docker build context is its own directory, so
# we vendor a copy of the shared module into each runner dir. Run this whenever
# _shared/safebox_auth.py changes; CI should verify the copies are identical.
set -euo pipefail
cd "$(dirname "$0")"
SRC="_shared/safebox_auth.py"
RUNNERS="vllm whisper kokoro-tts privacy-filter comfyui ltx-video wan-video stable-audio-3 triposr mineru onnx chatterbox-tts orpheus-tts"
for r in $RUNNERS; do
  cp "$SRC" "$r/safebox_auth.py"
  echo "  synced -> $r/safebox_auth.py"
done
echo "done. ($(sha256sum $SRC | cut -c1-16) is the canonical hash)"
