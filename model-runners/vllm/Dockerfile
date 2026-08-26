# vLLM Safebox Runner — single container, vLLM + Safebox protocol wrapper
#
# Build:
#   # CPU dev build (for testing the wrapper without GPUs):
#   docker build -t safebox/vllm:latest .
#
#   # GPU production build (CUDA 12.4):
#   docker build --build-arg BASE=nvidia/cuda:12.4.1-runtime-ubuntu22.04 \
#                -t safebox/vllm:latest .
#
# Run:
#   docker run -d --name safebox-vllm-llama \
#       --gpus all \
#       --network safebox-net \
#       -e MODEL_NAME=llama-3.3-70b-instruct \
#       -e SERVICE_ID=llm-llama \
#       -v safebox-sockets:/run/safebox/services \
#       -v /etc/safebox:/etc/safebox:ro \
#       -v safebox-models:/srv/safebox/models:ro \
#       -v safebox-hf-cache:/root/.cache/huggingface \
#       safebox/vllm:latest
#
# Notes:
#  - vLLM has a heavy install (~6-8GB image + model weights). First start
#    is slow because weights load to VRAM. The wrapper comes up immediately
#    and returns 503 from its data endpoints until vLLM is ready.
#  - Weights are read from /srv/safebox/models/<manifestHash>/ (host-mounted),
#    OR from the HuggingFace cache, OR downloaded on first run (configurable
#    via manifest).
#  - Configure SAFEBOX_REQUIRE_HMAC=true in production. Off by default for dev.

ARG BASE=python@sha256:REPLACE_python311slim_DIGEST  # was python:3.11-slim — pin by digest
FROM ${BASE}

ARG VLLM_VERSION=0.6.5

# ─── System deps ──────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates jq supervisor \
        git build-essential \
    && rm -rf /var/lib/apt/lists/*

# ─── Python: wrapper deps first (so re-builds of runner.py don't refetch) ──
COPY requirements.txt /tmp/
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /tmp/requirements.txt

# ─── vLLM (heavy, cached as its own layer) ────────────────────────────
RUN pip install --no-cache-dir "vllm==${VLLM_VERSION}"

# ─── App ──────────────────────────────────────────────────────────────
WORKDIR /app
COPY runner.py /app/
COPY safebox_auth.py /app/
COPY start.sh /app/
COPY supervisord.conf /etc/supervisor/supervisord.conf
COPY manifests/ /app/manifests/
RUN chmod +x /app/start.sh

# ─── Service user (matches privacy-filter and mineru conventions) ──────
RUN groupadd -g 1000 safebox-services \
 && useradd -u 1000 -g safebox-services -s /bin/bash safebox-services \
 && mkdir -p /run/safebox/services /var/log /srv/safebox/models /etc/safebox \
 && chown -R safebox-services:safebox-services /run/safebox/services /var/log

EXPOSE 8000

# Entrypoint resolves the manifest, then hands off to supervisord
CMD ["/app/start.sh"]
