#!/bin/sh
# Start llama-server in the background, then start the FastAPI adapter
# in the foreground. If either exits, the container exits.

set -e

: "${LLAMA_MODEL_PATH:?LLAMA_MODEL_PATH must be set}"

# Construct llama-server args from env vars
LLAMA_ARGS="--model ${LLAMA_MODEL_PATH}"
LLAMA_ARGS="${LLAMA_ARGS} --host 127.0.0.1 --port ${LLAMA_PORT:-8080}"
LLAMA_ARGS="${LLAMA_ARGS} --ctx-size ${LLAMA_CTX_SIZE:-8192}"
LLAMA_ARGS="${LLAMA_ARGS} --parallel ${LLAMA_PARALLEL:-4}"
LLAMA_ARGS="${LLAMA_ARGS} --n-gpu-layers ${LLAMA_N_GPU_LAYERS:-999}"
LLAMA_ARGS="${LLAMA_ARGS} --threads ${LLAMA_THREADS:-4}"
LLAMA_ARGS="${LLAMA_ARGS} --slot-save-path /var/lib/safebox-llama-cpp/slots"

if [ "${LLAMA_FLASH_ATTN:-1}" = "1" ]; then
    LLAMA_ARGS="${LLAMA_ARGS} --flash-attn"
fi

# OpenAI-compatible API enabled by default in llama-server.
# Note: when running embeddings, add --embeddings to this list.

echo "[entrypoint] starting llama-server: ${LLAMA_ARGS}"
llama-server ${LLAMA_ARGS} &
LLAMA_PID=$!

# Give llama-server a moment to start binding its port
sleep 2

# Trap signals to bring both processes down together
trap "kill ${LLAMA_PID} 2>/dev/null; exit 0" TERM INT

echo "[entrypoint] starting FastAPI adapter (pid ${LLAMA_PID} for llama-server)"
exec python -m uvicorn runner:app \
    --host 0.0.0.0 --port 7790 \
    --log-level info
