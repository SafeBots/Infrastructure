# TripoSR Safebox Runner — single container, TripoSR + Safebox protocol
#
# Build (GPU strongly recommended — CPU works but takes ~30s/mesh vs ~1s):
#   docker build --build-arg BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04 \
#                -t safebox/triposr:latest .
#
# Bake the model into the image:
#   docker build --build-arg PREFETCH=1 -t safebox/triposr:latest .
#
# Run:
#   docker run -d --name safebox-3d \
#       --gpus all --network safebox-net \
#       -e MODEL_NAME=triposr \
#       -e SERVICE_ID=3d-1 \
#       -v safebox-sockets:/run/safebox/services \
#       -v safebox-3d-cache:/root/.cache/huggingface \
#       -v /data/3d-out:/data/output \
#       safebox/triposr:latest

ARG BASE=python@sha256:REPLACE_python311slim_DIGEST  # was python:3.11-slim — pin by digest
FROM ${BASE}

# ─── System deps ──────────────────────────────────────────────────────
# libxrender / libxext — needed by some trimesh exporters
# build-essential — TripoSR builds custom CUDA kernels at first import
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libxrender1 libxext6 libgl1 libgomp1 \
        ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

# ─── Python deps ──────────────────────────────────────────────────────
COPY requirements.txt /tmp/
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /tmp/requirements.txt

# ─── Optional weight prefetch ─────────────────────────────────────────
ARG PREFETCH=0
RUN if [ "$PREFETCH" = "1" ]; then \
        python -c "from tsr.system import TSR; TSR.from_pretrained('stabilityai/TripoSR')" \
        || echo "Prefetch failed — will retry at runtime"; \
    fi

# ─── App ──────────────────────────────────────────────────────────────
WORKDIR /app
COPY runner.py /app/
COPY safebox_auth.py /app/
COPY manifests/ /app/manifests/

# ─── Service user ─────────────────────────────────────────────────────
RUN groupadd -g 1000 safebox-services \
 && useradd -u 1000 -g safebox-services -s /bin/bash safebox-services \
 && mkdir -p /run/safebox/services /data/output /root/.cache/huggingface \
 && chown -R safebox-services:safebox-services /run/safebox/services /data/output /root/.cache

USER safebox-services

EXPOSE 8080

CMD ["python", "runner.py"]
