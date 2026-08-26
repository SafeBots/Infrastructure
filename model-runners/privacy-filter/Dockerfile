FROM python@sha256:REPLACE_python311slim_DIGEST  # was python:3.11-slim — pin by digest

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt /tmp/
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Download model at build time (optional - can also download at runtime)
RUN python -c "from transformers import AutoTokenizer, AutoModelForTokenClassification; \
    AutoTokenizer.from_pretrained('openai/privacy-filter'); \
    AutoModelForTokenClassification.from_pretrained('openai/privacy-filter')"

# Create app directory
WORKDIR /app
COPY runner.py /app/
COPY safebox_auth.py /app/

# Create safebox-services user
RUN groupadd -g 1000 safebox-services && \
    useradd -u 1000 -g safebox-services -s /bin/bash safebox-services

# Create socket directory
RUN mkdir -p /run/safebox/services && \
    chown safebox-services:safebox-services /run/safebox/services

USER safebox-services

EXPOSE 8080

CMD ["python", "runner.py"]
