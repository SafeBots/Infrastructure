# Stable Audio Safebox Runner — single container, Stable Audio Open + Safebox protocol
#
# Build (GPU recommended — diffusion is slow on CPU):
#   docker build --build-arg BASE=nvidia/cuda:12.4.1-runtime-ubuntu22.04 \
#                -t safebox/stable-audio:latest .
#
# Build (CPU — works but slow):
#   docker build -t safebox/stable-audio:latest .
#
# Bake the model into the image (skip the runtime download):
#   docker build --build-arg PREFETCH=1 -t safebox/stable-audio:latest .
#
# Run:
#   docker run -d --name safebox-audio \
#       --gpus all \
#       --network safebox-net \
#       -e MODEL_NAME=stable-audio-open-small \
#       -e SERVICE_ID=audio-1 \
#       -e SAFEBOX_REQUIRE_HMAC=true \
#       -v safebox-sockets:/run/safebox/services \
#       -v /etc/safebox:/etc/safebox:ro \
#       -v safebox-models:/root/.cache/huggingface \
#       -v /data/audio-out:/data/output \
#       safebox/stable-audio:latest

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
        python -c "from stable_audio_tools import get_pretrained_model; \
                   get_pretrained_model('stabilityai/stable-audio-open-small')" \
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
