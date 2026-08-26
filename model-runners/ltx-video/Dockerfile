# LTX-Video Safebox Runner — single container, LTX-Video + Safebox protocol
#
# Build (GPU required for usable inference — 16GB+ VRAM minimum):
#   docker build --build-arg BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04 \
#                -t safebox/ltx-video:latest .
#
# Bake the model into the image (~13GB layer):
#   docker build --build-arg PREFETCH=1 -t safebox/ltx-video:latest .
#
# Run:
#   docker run -d --name safebox-video \
#       --gpus all \
#       --network safebox-net \
#       --shm-size=4g \
#       -e MODEL_NAME=ltx-2-3-distilled \
#       -e SERVICE_ID=video-1 \
#       -e SAFEBOX_REQUIRE_HMAC=true \
#       -v safebox-sockets:/run/safebox/services \
#       -v /etc/safebox:/etc/safebox:ro \
#       -v safebox-models:/root/.cache/huggingface \
#       -v /data/video-out:/data/output \
#       safebox/ltx-video:latest

ARG BASE=python@sha256:REPLACE_python311slim_DIGEST  # was python:3.11-slim — pin by digest
FROM ${BASE}

# ─── System deps ──────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libsndfile1 libgomp1 \
        ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

# ─── Python deps ──────────────────────────────────────────────────────
COPY requirements.txt /tmp/
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /tmp/requirements.txt

# ─── Optional weight prefetch ─────────────────────────────────────────
ARG PREFETCH=0
RUN if [ "$PREFETCH" = "1" ]; then \
        python -c "from diffusers import LTXPipeline; LTXPipeline.from_pretrained('Lightricks/LTX-Video')" \
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
