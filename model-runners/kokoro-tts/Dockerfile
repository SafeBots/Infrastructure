# Kokoro TTS Safebox Runner — single container, Kokoro + Safebox protocol wrapper
#
# Build (CPU — Kokoro is small enough to run on CPU):
#   docker build -t safebox/kokoro-tts:latest .
#
# Build (GPU production):
#   docker build --build-arg BASE=nvidia/cuda:12.4.1-runtime-ubuntu22.04 \
#                -t safebox/kokoro-tts:latest .
#
# Bake the model into the image (skip the runtime download):
#   docker build --build-arg PREFETCH=1 -t safebox/kokoro-tts:latest .
#
# Run:
#   docker run -d --name safebox-kokoro \
#       --network safebox-net \
#       -e MODEL_NAME=kokoro-82m \
#       -e DEFAULT_VOICE=af_heart \
#       -e SERVICE_ID=speech-1 \
#       -e SAFEBOX_REQUIRE_HMAC=true \
#       -v safebox-sockets:/run/safebox/services \
#       -v /etc/safebox:/etc/safebox:ro \
#       -v safebox-models:/root/.cache/huggingface \
#       -v /data/audio-out:/data/output \
#       safebox/kokoro-tts:latest

ARG BASE=python@sha256:REPLACE_python311slim_DIGEST  # was python:3.11-slim — pin by digest
FROM ${BASE}

# ─── System deps ──────────────────────────────────────────────────────
# ffmpeg for MP3/OGG output encoding.
# libsndfile1 for some audio processing paths.
# espeak-ng — Kokoro's phonemizer needs it for grapheme-to-phoneme conversion.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libsndfile1 libgomp1 \
        espeak-ng \
        ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# ─── Python deps ──────────────────────────────────────────────────────
COPY requirements.txt /tmp/
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /tmp/requirements.txt

# ─── Optional weight prefetch ─────────────────────────────────────────
# Kokoro is small (~330 MB) — baking it into the image is reasonable.
ARG PREFETCH=0
RUN if [ "$PREFETCH" = "1" ]; then \
        python -c "from kokoro import KPipeline; KPipeline(lang_code='a')" \
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
