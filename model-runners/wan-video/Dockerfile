# Wan 2.2 Safebox Runner — single container, Wan 2.2 + Safebox protocol
#
# Build (GPU required — A14B variants need 24GB+ VRAM, 5B fits on 16GB):
#   docker build --build-arg BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04 \
#                -t safebox/wan-video:latest .
#
# Bake the model into the image (~30-50GB depending on variant):
#   docker build --build-arg PREFETCH=1 \
#                --build-arg WAN_MODEL_PATH=Wan-AI/Wan2.2-TI2V-5B-Diffusers \
#                -t safebox/wan-video:latest .
#
# Run (5B combined T+I2V — fits on 16GB consumer cards):
#   docker run -d --name safebox-wan-video \
#       --gpus all --network safebox-net --shm-size=4g \
#       -e MODEL_NAME=wan-2-2-ti2v-5b \
#       -e WAN_MODEL_PATH=Wan-AI/Wan2.2-TI2V-5B-Diffusers \
#       -e WAN_VARIANT=ti2v-5b \
#       -e SERVICE_ID=video-2 \
#       -v safebox-sockets:/run/safebox/services \
#       -v /etc/safebox:/etc/safebox:ro \
#       -v safebox-wan-cache:/root/.cache/huggingface \
#       -v /data/video-out:/data/output \
#       safebox/wan-video:latest
#
# Run (A14B full-quality T2V — needs 24GB+ VRAM):
#   docker run -d --name safebox-wan-video-hq \
#       --gpus all --network safebox-net --shm-size=8g \
#       -e MODEL_NAME=wan-2-2-t2v-a14b \
#       -e WAN_MODEL_PATH=Wan-AI/Wan2.2-T2V-A14B-Diffusers \
#       -e WAN_VARIANT=t2v-a14b \
#       -e SERVICE_ID=video-2-hq \
#       -e ENABLE_CPU_OFFLOAD=true \
#       -v safebox-sockets:/run/safebox/services \
#       -v safebox-wan-cache:/root/.cache/huggingface \
#       -v /data/video-out:/data/output \
#       safebox/wan-video:latest

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
ARG WAN_MODEL_PATH=Wan-AI/Wan2.2-TI2V-5B-Diffusers
RUN if [ "$PREFETCH" = "1" ]; then \
        python -c "from diffusers import WanPipeline, AutoencoderKLWan; \
                   vae = AutoencoderKLWan.from_pretrained('${WAN_MODEL_PATH}', subfolder='vae'); \
                   WanPipeline.from_pretrained('${WAN_MODEL_PATH}', vae=vae)" \
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
