# Chatterbox TTS Safebox Runner — Chatterbox (Resemble AI, MIT) + Safebox protocol wrapper
#
# Build (GPU recommended; CPU works for the 350M Turbo but slower):
#   docker build -t safebox/chatterbox-tts:latest .
#   docker build --build-arg BASE=nvidia/cuda:12.4.1-runtime-ubuntu22.04 -t safebox/chatterbox-tts:latest .
#
# Run:
#   docker run -d --name safebox-chatterbox \
#       --network safebox-net \
#       -e MODEL_NAME=chatterbox-turbo \
#       -e SERVICE_ID=speech-1 \
#       -e SAFEBOX_REQUIRE_HMAC=true \
#       -v safebox-sockets:/run/safebox/services \
#       -v /etc/safebox:/etc/safebox:ro \
#       -v safebox-models:/root/.cache/huggingface \
#       -v /data/audio-out:/data/output \
#       safebox/chatterbox-tts:latest

ARG BASE=python@sha256:REPLACE_python311slim_DIGEST  # was python:3.11-slim — pin by digest
FROM ${BASE}

# ─── System deps ──────────────────────────────────────────────────────
# ffmpeg for MP3/OGG output encoding; libsndfile1 for audio IO.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libsndfile1 libgomp1 \
        ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# ─── Python deps ──────────────────────────────────────────────────────
COPY requirements.txt /tmp/
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /tmp/requirements.txt

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
