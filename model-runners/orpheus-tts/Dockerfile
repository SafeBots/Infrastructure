# Orpheus / Higgs-v2 TTS Safebox Runner — Llama-based Speech-LLMs + Safebox wrapper
#
# Both models are Apache-2.0. GPU strongly recommended (3B+ params).
#   docker build --build-arg BASE=nvidia/cuda:12.4.1-runtime-ubuntu22.04 -t safebox/orpheus-tts:latest .
#
# Run (Orpheus):
#   docker run -d --name safebox-orpheus --gpus all \
#       --network safebox-net \
#       -e MODEL_NAME=orpheus-3b -e SERVICE_ID=speech-1 \
#       -e SAFEBOX_REQUIRE_HMAC=true \
#       -v safebox-sockets:/run/safebox/services \
#       -v /etc/safebox:/etc/safebox:ro \
#       -v safebox-models:/root/.cache/huggingface \
#       -v /data/audio-out:/data/output \
#       safebox/orpheus-tts:latest
#
# For Higgs Audio v2: -e MODEL_NAME=higgs-audio-v2-3b   (v2 ONLY — v3 is non-commercial)

ARG BASE=python@sha256:REPLACE_python311slim_DIGEST  # for GPU: nvidia/cuda:12.4.1-runtime-ubuntu22.04
FROM ${BASE}

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libsndfile1 libgomp1 \
        ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /tmp/requirements.txt

WORKDIR /app
COPY runner.py /app/
COPY safebox_auth.py /app/
COPY manifests/ /app/manifests/

RUN groupadd -g 1000 safebox-services \
 && useradd -u 1000 -g safebox-services -s /bin/bash safebox-services \
 && mkdir -p /run/safebox/services /data/output /root/.cache/huggingface \
 && chown -R safebox-services:safebox-services /run/safebox/services /data/output /root/.cache

USER safebox-services
EXPOSE 8080
CMD ["python", "runner.py"]
