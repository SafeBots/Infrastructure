# ComfyUI Safebox Runner — single container, ComfyUI + Safebox protocol wrapper
#
# Build (GPU production):
#   docker build --build-arg BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04 \
#                -t safebox/comfyui:latest .
#
# Build (CPU dev — for testing the wrapper without GPUs):
#   docker build -t safebox/comfyui:latest .
#
# Pin ComfyUI to a specific commit for reproducibility:
#   docker build --build-arg COMFYUI_REF=v0.3.10 -t safebox/comfyui:latest .
#
# Run (FLUX schnell — the safe commercial-OK default):
#   docker run -d --name safebox-comfyui-flux \
#       --gpus all \
#       --network safebox-net \
#       -e MODEL_NAME=flux-1-schnell \
#       -e SERVICE_ID=image-1 \
#       -v safebox-sockets:/run/safebox/services \
#       -v /etc/safebox:/etc/safebox:ro \
#       -v safebox-comfyui-models:/opt/ComfyUI/models \
#       -v /data/output:/data/output \
#       safebox/comfyui:latest
#
# Notes:
#  - ComfyUI's `models/` directory has subdirectories: checkpoints/, unet/,
#    vae/, clip/, loras/, controlnet/. Drop weight files into the right one.
#    For Safebox production, mount /srv/safebox/models/<hash>/ overtop.
#  - FLUX needs three files in three different subdirs (unet, vae, clip).
#    SDXL needs one file in models/checkpoints/.
#  - First start downloads no models — they must be pre-staged. ComfyUI will
#    error at first prompt if a referenced file is missing.

ARG BASE=python@sha256:REPLACE_python311slim_DIGEST  # was python:3.11-slim — pin by digest
FROM ${BASE}

ARG COMFYUI_REF=v0.3.10  # pin — never track master (moving ref breaks induction)

# ─── System deps ──────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates jq supervisor \
        build-essential \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Python may not be the system python depending on base image; ensure pip works
RUN which python || ln -s /usr/bin/python3 /usr/local/bin/python; \
    which pip    || python -m ensurepip --upgrade

# ─── Clone ComfyUI ────────────────────────────────────────────────────
RUN git clone https://github.com/comfyanonymous/ComfyUI.git /opt/ComfyUI \
 && cd /opt/ComfyUI \
 && git checkout "${COMFYUI_REF}" \
 && pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

# ─── Wrapper Python deps ──────────────────────────────────────────────
COPY requirements.txt /tmp/
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# ─── App ──────────────────────────────────────────────────────────────
WORKDIR /app
COPY runner.py /app/
COPY safebox_auth.py /app/
COPY start.sh /app/
COPY supervisord.conf /etc/supervisor/supervisord.conf
COPY manifests/ /app/manifests/
COPY workflows/ /app/workflows/
RUN chmod +x /app/start.sh

# ─── Service user ─────────────────────────────────────────────────────
RUN groupadd -g 1000 safebox-services \
 && useradd -u 1000 -g safebox-services -s /bin/bash safebox-services \
 && mkdir -p /run/safebox/services /var/log /data/output \
              /opt/ComfyUI/models/checkpoints \
              /opt/ComfyUI/models/unet \
              /opt/ComfyUI/models/vae \
              /opt/ComfyUI/models/clip \
              /opt/ComfyUI/models/loras \
              /opt/ComfyUI/models/controlnet \
 && chown -R safebox-services:safebox-services /run/safebox/services /var/log /data/output /opt/ComfyUI/models

EXPOSE 8188

# Entrypoint resolves the manifest, then hands off to supervisord
CMD ["/app/start.sh"]
