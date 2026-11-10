# MinerU Document Extraction Runner — Safebox Local Service
#
# Build:
#   docker build -t safebox/mineru:latest .
#
# Build with GPU support baked in (Linux x86_64 + NVIDIA):
#   docker build --build-arg BASE=nvidia/cuda:12.4.0-runtime-ubuntu22.04 -t safebox/mineru:latest .
#
# Notes:
#  - First run downloads ~3 GB of model weights into /root/.cache/mineru.
#    Mount a persistent volume there if you want them to survive container
#    restarts (recommended).
#  - For GPU, run with --gpus all. For CPU-only, no extra flags needed.
#  - MINERU_BACKEND defaults to 'pipeline'. Set to 'vlm' for the higher-fidelity
#    vision-language backend.

ARG BASE=python@sha256:REPLACE_python311slim_DIGEST  # was python:3.11-slim — pin by digest
FROM ${BASE}

# Install system dependencies. libgl1 + libglib2.0-0 are needed by opencv-headless
# which is a transitive dep of MinerU's image processing. poppler-utils is for
# the PDF rasterization fallback.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl \
        libgl1 libglib2.0-0 \
        poppler-utils \
        fonts-dejavu fonts-noto-cjk \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps. MinerU is heavy — separate the heavy lifters from
# the runtime so re-builds of just runner.py don't refetch torch.
COPY requirements.txt /tmp/
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /tmp/requirements.txt

# Pre-download model weights at build time. Skip if you want a slimmer image
# and don't mind the first-run cost.
# Set MINERU_PREFETCH=0 at build time to skip:
#   docker build --build-arg MINERU_PREFETCH=0 ...
ARG MINERU_PREFETCH=1
RUN if [ "$MINERU_PREFETCH" = "1" ]; then \
        python -c "from mineru.cli.common import prepare_env; \
                   from huggingface_hub import snapshot_download; \
                   snapshot_download(repo_id='opendatalab/MinerU2.0-2505-0.9B', \
                                     local_dir='/root/.cache/mineru/models')" \
        || echo "Model prefetch failed — will retry at runtime"; \
    fi

# App
WORKDIR /app
COPY runner.py /app/
COPY safebox_auth.py /app/

# Service user. Match the convention from the other runners.
RUN groupadd -g 1000 safebox-services \
 && useradd -u 1000 -g safebox-services -s /bin/bash safebox-services \
 && mkdir -p /run/safebox/services /data \
 && chown -R safebox-services:safebox-services /run/safebox/services /data /root/.cache

USER safebox-services

EXPOSE 8080

CMD ["python", "runner.py"]
