# ONNX Safebox Runner — single container, ONNX Runtime + Safebox protocol
#
# The LIGHT runner: embeddings, rerankers, CLIP/vision encoders, small
# classifiers, small vision/speech task models. CPU by default; GPU optional.
# Covers the "not-LLM" tier — the models that are a forward pass in, a vector
# or label out — which don't need vLLM's generation machinery.
#
# Build (CPU dev):
#   docker build -t safebox/onnx:latest .
#
# Build (GPU, CUDA 12.x):
#   docker build --build-arg BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04 \
#                --build-arg ONNX_GPU=1 -t safebox/onnx:latest .
#
# Run (CPU, embeddings):
#   docker run -d --name safebox-onnx-embed \
#       --network safebox-net \
#       -e MODEL_NAME=bge-small-en-v1.5 \
#       -e ONNX_DEVICE=cpu \
#       -e SERVICE_ID=embed-1 \
#       -v safebox-sockets:/run/safebox/services \
#       -v /etc/safebox:/etc/safebox:ro \
#       -v /srv/safebox/models:/models:ro \
#       safebox/onnx:latest

ARG BASE=python@sha256:REPLACE_python311slim_DIGEST  # was python:3.11-slim — pin by digest
FROM ${BASE}

# ─── System deps ──────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# ─── Python deps ──────────────────────────────────────────────────────
# ONNX_GPU=1 selects onnxruntime-gpu; default is the CPU build (lighter).
ARG ONNX_GPU=0
COPY requirements.txt /tmp/
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /tmp/requirements.txt \
 && if [ "$ONNX_GPU" = "1" ]; then \
        pip install --no-cache-dir onnxruntime-gpu==1.20.1; \
    else \
        pip install --no-cache-dir onnxruntime==1.20.1; \
    fi

# ─── App ──────────────────────────────────────────────────────────────
WORKDIR /app
COPY runner.py /app/
COPY safebox_auth.py /app/
COPY manifests/ /app/manifests/

# ─── Service user (matches whisper / privacy-filter / vllm) ────────────
RUN groupadd -g 1000 safebox-services \
 && useradd -u 1000 -g safebox-services -s /bin/bash safebox-services \
 && mkdir -p /run/safebox/services /models \
 && chown -R safebox-services:safebox-services /run/safebox/services

USER safebox-services

EXPOSE 8080

CMD ["python", "runner.py"]
