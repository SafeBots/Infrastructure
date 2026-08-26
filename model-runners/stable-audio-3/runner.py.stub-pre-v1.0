"""
Stable Audio 3 runner — stub.

This file establishes the runner contract for Safebox Infrastructure. The
actual inference loop using Stability's stable-audio-tools is left for the
1.1 implementation; what's here is the API shape, config loading, and
model-weight verification path so the rest of the system can be wired up.

The runner consumes model weights from /srv/safebox/models/<manifestHash>/
(populated by the gateway's /models/install endpoint). Weights are read
read-only; the runner has no write access to the models directory.

Run-time configuration lives in /etc/safebox/runners/stable-audio-3/config.json
and is updated by Safebox via the gateway's /system endpoint with
managedContainer=_host. The runner reads it at startup and on SIGHUP.

This stub is NOT production-ready. Things still to wire:
  - Load weights via stable-audio-tools (or direct safetensors loading)
  - Hook into the actual diffusion sampler (ping-pong, 8 steps)
  - Implement the inpainting endpoint (post-1.1)
  - Add proper audio encoding (currently returns silent WAV placeholder)
"""

import json
import logging
import os
import struct
import sys
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
import uvicorn


logger = logging.getLogger(__name__)

CONFIG_PATH = Path(os.environ.get(
    "STABLE_AUDIO_3_CONFIG",
    "/etc/safebox/runners/stable-audio-3/config.json",
))
MODELS_ROOT = Path(os.environ.get(
    "SAFEBOX_MODELS_ROOT",
    "/srv/safebox/models",
))
LISTEN_HOST = os.environ.get("STABLE_AUDIO_3_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("STABLE_AUDIO_3_PORT", "7790"))


class Config(BaseModel):
    modelManifestHash: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    variant: str = Field(..., pattern=r"^(small|small-music|small-sfx|medium)$")


def load_config() -> Config:
    if not CONFIG_PATH.exists():
        raise RuntimeError(f"config not found at {CONFIG_PATH}")
    with open(CONFIG_PATH) as f:
        raw = json.load(f)
    return Config(**raw)


def verify_model_dir(manifest_hash: str) -> Path:
    """Confirm the model directory exists and the manifest hashes correctly.

    The runner trusts the gateway to have done full SHA-256 verification at
    install time; here we just check that the directory exists and contains
    a manifest.json. Full re-verification is on a separate audit cadence
    via /models/<hash>/verify.
    """
    model_dir = MODELS_ROOT / manifest_hash
    if not model_dir.is_dir():
        raise RuntimeError(
            f"model directory missing: {model_dir}. "
            f"Have you called /models/install with manifestHash={manifest_hash}?"
        )
    manifest_path = model_dir / "manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"manifest.json missing in {model_dir}")
    with open(manifest_path) as f:
        manifest = json.load(f)
    if manifest.get("runnerType") != "stable-audio-3":
        raise RuntimeError(
            f"manifest runnerType={manifest.get('runnerType')}, "
            f"expected 'stable-audio-3'"
        )
    return model_dir


# ── API schema ───────────────────────────────────────────────────────────────


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2048)
    durationSeconds: float = Field(..., ge=0.5, le=380.0)
    seed: Optional[int] = Field(default=None, ge=0, le=2**32 - 1)
    samplingSteps: int = Field(default=8, ge=1, le=64)


class GenerateResponse(BaseModel):
    sampleRate: int
    channels: int
    durationSeconds: float
    formatHint: str
    audioBase64: str
    modelManifestHash: str
    variant: str


app = FastAPI(title="Stable Audio 3 Runner", version="0.1.0")

_config: Optional[Config] = None
_model_dir: Optional[Path] = None


@app.on_event("startup")
def startup() -> None:
    global _config, _model_dir
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    _config = load_config()
    _model_dir = verify_model_dir(_config.modelManifestHash)
    logger.info(
        "stable-audio-3 runner ready: variant=%s manifestHash=%s model_dir=%s",
        _config.variant, _config.modelManifestHash, _model_dir,
    )


@app.get("/v1/healthz")
def healthz() -> dict:
    return {
        "status": "ok",
        "modelManifestHash": _config.modelManifestHash if _config else None,
        "variant": _config.variant if _config else None,
    }


@app.post("/v1/audio/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest) -> GenerateResponse:
    if _config is None or _model_dir is None:
        raise HTTPException(status_code=503, detail="runner not initialized")

    # ── STUB: real inference goes here ──────────────────────────────────────
    # In production, this would:
    #   1. Tokenize req.prompt with T5Gemma
    #   2. Encode duration as Fourier features
    #   3. Sample ϵ ~ N(0, I) at length proportional to req.durationSeconds
    #   4. Run 8 ping-pong sampling steps through the diffusion transformer
    #   5. Decode the SAME latents back to stereo 44.1 kHz waveform
    #   6. Encode as WAV (or FLAC if requested)
    #
    # For now, return a silent WAV of the requested length so the wire
    # protocol can be exercised end-to-end.
    #
    # Real implementation reference: stable-audio-tools repo, sampling.py
    # ────────────────────────────────────────────────────────────────────────

    sample_rate = 44100
    n_samples = int(req.durationSeconds * sample_rate)
    silent = generate_silent_wav(sample_rate, n_samples)
    import base64
    return GenerateResponse(
        sampleRate=sample_rate,
        channels=2,
        durationSeconds=req.durationSeconds,
        formatHint="audio/wav",
        audioBase64=base64.b64encode(silent).decode("ascii"),
        modelManifestHash=_config.modelManifestHash,
        variant=_config.variant,
    )


def generate_silent_wav(sample_rate: int, n_samples: int) -> bytes:
    """Generate a stereo silent WAV file. Used only by the stub."""
    n_channels = 2
    bits = 16
    byte_rate = sample_rate * n_channels * bits // 8
    block_align = n_channels * bits // 8
    data_size = n_samples * block_align
    header = b"RIFF" + struct.pack("<I", 36 + data_size) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH",
        16, 1, n_channels, sample_rate, byte_rate, block_align, bits)
    header += b"data" + struct.pack("<I", data_size)
    return header + b"\x00" * data_size


if __name__ == "__main__":
    uvicorn.run(app, host=LISTEN_HOST, port=LISTEN_PORT)
