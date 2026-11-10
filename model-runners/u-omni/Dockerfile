FROM python:3.11-slim AS runner

# ZFS tools for KV cache persistence tier
RUN apt-get update && apt-get install -y --no-install-recommends \
    zfsutils-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Shared auth module
COPY ../safebox_auth.py /app/safebox_auth.py

# Runner
COPY runner.py /app/runner.py

# The U binary is installed from the host image (NixOS overlay)
# and mounted at /usr/local/bin/u-omni.  Model weights are at
# /srv/safebox/models/<manifestHash>/ (read-only mount).

ENV RUNNER_ID=safebox-u-omni-1
ENV SERVICE_ID=u-omni-1
ENV SAFEBOX_REQUIRE_HMAC=true
ENV KV_RAM_LIMIT_MB=8192
ENV KV_ZFS_DATASET=safebox-pool/data/kv-cache

EXPOSE 7790

CMD ["python", "runner.py"]
