# llama.cpp runner — Safebox image manifest at /app/manifest.json declares
# envVars, outputFiles, exitCodes per the Safebox image contract.
#
# Build args:
#   LLAMA_BUILD = cpu | cuda | metal | vulkan | rocm
#     Default cpu. See model-runners/llama-cpp/README.md for the matrix.
#
# Examples:
#   docker build -t safebox/llama-cpp:cpu  --build-arg LLAMA_BUILD=cpu  .
#   docker build -t safebox/llama-cpp:cuda --build-arg LLAMA_BUILD=cuda .

ARG LLAMA_BUILD=cpu

# ─── Stage 1: build llama.cpp from source ───────────────────────────────
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS build-cuda
ARG LLAMA_BUILD
RUN apt-get update && apt-get install -y --no-install-recommends \
        git cmake build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 https://github.com/ggerganov/llama.cpp.git && \
    cd llama.cpp && \
    cmake -B build -DGGML_CUDA=ON -DLLAMA_CURL=OFF && \
    cmake --build build --config Release -j --target llama-server

FROM ubuntu:22.04 AS build-cpu
ARG LLAMA_BUILD
RUN apt-get update && apt-get install -y --no-install-recommends \
        git cmake build-essential python3 ca-certificates \
        libopenblas-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 https://github.com/ggerganov/llama.cpp.git && \
    cd llama.cpp && \
    cmake -B build -DGGML_BLAS=ON -DGGML_BLAS_VENDOR=OpenBLAS -DLLAMA_CURL=OFF && \
    cmake --build build --config Release -j --target llama-server

# Pick the build stage that matches LLAMA_BUILD
FROM build-${LLAMA_BUILD} AS build

# ─── Stage 2: runtime ───────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

# CUDA runtime libs (only used when LLAMA_BUILD=cuda; harmless otherwise)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates libgomp1 libopenblas0 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --system --no-create-home --shell /sbin/nologin --uid 5000 runner

WORKDIR /app

# Copy llama-server from build stage
COPY --from=build /src/llama.cpp/build/bin/llama-server /usr/local/bin/llama-server
COPY --from=build /src/llama.cpp/build/src/libllama.so /usr/local/lib/libllama.so
COPY --from=build /src/llama.cpp/build/ggml/src/libggml.so /usr/local/lib/libggml.so
RUN ldconfig

# Adapter
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt
COPY runner.py /app/
COPY manifest.json /app/

# Slot-state dir (mounted by the system component as a tmpfs or persistent vol)
RUN mkdir -p /var/lib/safebox-llama-cpp/slots && \
    chown -R runner:runner /var/lib/safebox-llama-cpp && \
    chown -R runner:runner /app

USER runner

# llama-server on 8080 (internal), adapter on unix socket (external)
EXPOSE 7790

# Healthcheck targets the adapter's /health (which in turn probes llama-server)
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://127.0.0.1:7790/health || exit 1

# Entry: start llama-server then the FastAPI adapter
COPY entrypoint.sh /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
