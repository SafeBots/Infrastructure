# Whisper Safebox Runner — single container, Faster-Whisper + Safebox protocol
#
# Build (CPU dev):
#   docker build -t safebox/whisper:latest .
#
# Build (GPU production, CUDA 12.x):
#   docker build --build-arg BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04 \
#                -t safebox/whisper:latest .
#
# Run (GPU):
#   docker run -d --name safebox-whisper-large-turbo \
#       --gpus all \
#       --network safebox-net \
#       -e MODEL_NAME=whisper-large-v3-turbo \
#       -e FASTER_WHISPER_MODEL=large-v3-turbo \
#       -e WHISPER_DEVICE=cuda \
#       -e WHISPER_COMPUTE_TYPE=float16 \
#       -e SERVICE_ID=transcribe-1 \
#       -v safebox-sockets:/run/safebox/services \
#       -v /etc/safebox:/etc/safebox:ro \
#       -v safebox-models:/root/.cache/huggingface \
#       -v /data/audio:/data:ro \
#       safebox/whisper:latest
#
# Run (CPU, smaller models):
#   docker run -d --name safebox-whisper-small \
#       --network safebox-net \
#       -e MODEL_NAME=whisper-small \
#       -e FASTER_WHISPER_MODEL=small \
#       -e WHISPER_DEVICE=cpu \
#       -e WHISPER_COMPUTE_TYPE=int8 \
#       -e WHISPER_CPU_THREADS=4 \
#       -v safebox-sockets:/run/safebox/services \
#       -v /data/audio:/data:ro \
#       safebox/whisper:latest

ARG BASE=python@sha256:REPLACE_python311slim_DIGEST  # was python:3.11-slim — pin by digest
FROM ${BASE}

# ─── System deps ──────────────────────────────────────────────────────
# ffmpeg is required by faster-whisper for audio decoding.
# libsndfile1 for some audio backends. libgomp1 for OpenMP threading.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libsndfile1 libgomp1 \
        ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# ─── Python deps ──────────────────────────────────────────────────────
COPY requirements.txt /tmp/
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /tmp/requirements.txt

# ─── Optional weight prefetch ─────────────────────────────────────────
# Set --build-arg PREFETCH=large-v3-turbo (etc.) to bake a model into the image.
# Skip for slimmer images and pay the download cost on first start.
ARG PREFETCH=""
RUN if [ -n "$PREFETCH" ]; then \
        python -c "from faster_whisper import WhisperModel; \
                   WhisperModel('$PREFETCH', download_root='/root/.cache/huggingface')" \
        || echo "Prefetch failed — will retry at runtime"; \
    fi

# ─── App ──────────────────────────────────────────────────────────────
WORKDIR /app
COPY runner.py /app/
COPY safebox_auth.py /app/
COPY manifests/ /app/manifests/

# ─── Service user (matches privacy-filter / mineru / vllm) ─────────────
RUN groupadd -g 1000 safebox-services \
 && useradd -u 1000 -g safebox-services -s /bin/bash safebox-services \
 && mkdir -p /run/safebox/services /data /root/.cache/huggingface \
 && chown -R safebox-services:safebox-services /run/safebox/services /data /root/.cache

USER safebox-services

EXPOSE 8080

CMD ["python", "runner.py"]
