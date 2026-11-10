# Wan-Video runner — image manifest at /app/manifest.json declares
# envVars, outputFiles, exitCodes per the Safebox image contract.

FROM python:3.12-slim

RUN useradd --system --no-create-home --shell /sbin/nologin --uid 5000 runner

WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

COPY runner.py /app/

# Read-only mounts (populated by the gateway):
#   /srv/safebox/models           — installed model weights, read-only
#   /etc/safebox/runners          — runner configs, read-only
VOLUME ["/srv/safebox/models", "/etc/safebox/runners"]

USER runner
EXPOSE 7792

ENV WAN_VIDEO_HOST=0.0.0.0
ENV WAN_VIDEO_PORT=7792

CMD ["python", "/app/runner.py"]
