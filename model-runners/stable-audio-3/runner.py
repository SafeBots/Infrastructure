"""
Stable Audio Open Runner — Safebox Local Service v1.0

Wraps Stable Audio Open (Stability AI, Apache 2.0) as a Safebox-canonical
text-to-audio generation service. Music, sound effects, ambient audio,
foley — anything stable-audio-tools can produce.

Endpoints (Safebox canonical, camelCase, flat):
    POST /v1/audio/generate    — text → audio (music, SFX, ambient)
    GET  /v1/capabilities      — runner introspection
    GET  /v1/capacity          — current load
    GET  /v1/models            — what's loaded
    GET  /health               — liveness probe

Transport: Unix socket at /run/safebox/services/{SERVICE_ID}.sock,
           0660 perms, safebox-services group ownership.

Auth: HMAC-SHA256 of (timestamp.nonce.body) — same convention as the
      other Safebox runners. Gated on SAFEBOX_REQUIRE_HMAC=true.

Models:
  - stable-audio-open-small (~341M params, Apache 2.0, 11-sec clips, fastest)
  - stable-audio-open-1.0   (~1.21B params, Apache 2.0, up to 47-sec clips,
                              higher quality)

Both serve via the same `stable-audio-tools` library; different manifests
select different checkpoints with different default parameters.
"""

import asyncio
import base64
import collections
import hashlib
import hmac
import io
import json
import logging
import os
import socket
import stat
import time
import uuid
import wave
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
import uvicorn


# ─── Logging ───────────────────────────────────────────────────────────
logger = logging.getLogger("stable-audio-runner")
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")


# ─── Configuration ─────────────────────────────────────────────────────
RUNNER_ID  = os.getenv("RUNNER_ID",  "safebox-stable-audio-1")
SERVICE_ID = os.getenv("SERVICE_ID", "audio-1")
HMAC_KEY_PATH = os.getenv("HMAC_KEY_PATH", "/etc/safebox/model-api.key")
REQUIRE_HMAC  = os.getenv("SAFEBOX_REQUIRE_HMAC", "false").lower() == "true"

SAFEBOX_SOCKET_PATH = os.getenv("SAFEBOX_SOCKET_PATH",
                                 f"/run/safebox/services/{SERVICE_ID}.sock")
ENABLE_UNIX_SOCKET  = os.getenv("ENABLE_UNIX_SOCKET", "true").lower() == "true"

MODEL_NAME           = os.getenv("MODEL_NAME",           "stable-audio-open-small")
STABLE_AUDIO_MODEL   = os.getenv("STABLE_AUDIO_MODEL",
                                  "stabilityai/stable-audio-open-small")
DEFAULT_DURATION_SEC = float(os.getenv("DEFAULT_DURATION_SEC", "11.0"))
DEFAULT_STEPS        = int(os.getenv("DEFAULT_STEPS", "8"))
DEFAULT_CFG_SCALE    = float(os.getenv("DEFAULT_CFG_SCALE", "1.0"))
DEFAULT_SAMPLER      = os.getenv("DEFAULT_SAMPLER", "pingpong")
DEFAULT_FORMAT       = os.getenv("DEFAULT_FORMAT", "wav")
SAMPLE_RATE          = int(os.getenv("STABLE_AUDIO_SAMPLE_RATE", "44100"))
MAX_DURATION_SEC     = float(os.getenv("MAX_DURATION_SEC", "47.0"))

MAX_QUEUE_DEPTH = int(os.getenv("MAX_QUEUE_DEPTH", "2"))
WORK_DIR = Path(os.getenv("STABLE_AUDIO_WORK_DIR", "/data/output"))
WORK_DIR.mkdir(parents=True, exist_ok=True)

# Capability flags (manifest overrides via env)
CAP_TEXT2AUDIO   = os.getenv("CAP_TEXT2AUDIO",   "true").lower() == "true"
CAP_AUDIO2AUDIO  = os.getenv("CAP_AUDIO2AUDIO",  "false").lower() == "true"
CAP_INPAINT      = os.getenv("CAP_INPAINT",      "false").lower() == "true"
CAP_STREAMING    = False  # diffusion is one-shot — no incremental output

# Load HMAC key
try:
    with open(HMAC_KEY_PATH) as f:
        HMAC_KEY = f.read().strip()
except Exception as e:
    if REQUIRE_HMAC:
        logger.error(f"HMAC required but key unavailable: {e}")
        raise
    HMAC_KEY = None
    logger.info("HMAC verification disabled (no key, and SAFEBOX_REQUIRE_HMAC=false)")


# ─── State ─────────────────────────────────────────────────────────────
model_ready: bool = False
in_flight:   int  = 0
request_count: int = 0
total_audio_seconds: float = 0.0
total_compute_ms: int = 0
seen_nonces = collections.OrderedDict()  # nonce -> timestamp_sec (insertion-ordered)
# ─── Pydantic request model ────────────────────────────────────────────
class AudioGenerateRequest(BaseModel):
    model:          str
    prompt:         str = Field(..., description="Text prompt for music/SFX/ambient")
    negativePrompt: Optional[str]   = ""
    durationSec:    Optional[float] = None
    steps:          Optional[int]   = None
    cfgScale:       Optional[float] = None
    sampler:        Optional[str]   = None
    seed:           Optional[int]   = None
    format:         Optional[str]   = None   # wav | mp3 | ogg
    outputMode:     Optional[str]   = "path"
    filenamePrefix: Optional[str]   = "safebox-audio"


# ─── App ───────────────────────────────────────────────────────────────
app = FastAPI(title="Stable Audio Safebox Runner", version="1.0")


# ─── HMAC verification ─────────────────────────────────────────────────

# ── Shared canonical HMAC (single source of truth) ──────────────────────
# safebox_auth.py is vendored beside runner.py from model-runners/_shared/
# via sync-shared.sh, and COPYed into /app/ by the Dockerfile.
from safebox_auth import verify_hmac as _sb_verify  # noqa: E402

def verify_hmac(request: Request, body: bytes) -> bool:
    # Canonical HMAC verification lives in ONE place: model-runners/_shared/
    # safebox_auth.py, whose canonical string matches auth.js and the Safebox
    # LocalRunner byte-for-byte. This delegation keeps the call sites unchanged
    # while ensuring every runner shares a single source of truth.
    return _sb_verify(request, body)
def get_capacity_hint() -> str:
    if in_flight >= MAX_QUEUE_DEPTH * 0.9: return "saturated"
    if in_flight >= MAX_QUEUE_DEPTH * 0.7: return "near-saturated"
    return "available"


def safebox_headers(request_id: str, model: str, compute_ms: int = 0
                    ) -> Dict[str, str]:
    return {
        "X-Safebox-Request-Id":    request_id,
        "X-Safebox-Runner-Id":     RUNNER_ID,
        "X-Safebox-Model-Id":      model,
        "X-Safebox-Compute-Ms":    str(compute_ms),
        "X-Safebox-Capacity-Hint": get_capacity_hint(),
    }


def model_matches(requested: str) -> bool:
    if not requested:
        return False
    if requested == MODEL_NAME:
        return True
    # Also accept the upstream HF model id
    if STABLE_AUDIO_MODEL and requested == STABLE_AUDIO_MODEL:
        return True
    if STABLE_AUDIO_MODEL and "/" in STABLE_AUDIO_MODEL:
        if requested == STABLE_AUDIO_MODEL.rsplit("/", 1)[-1]:
            return True
    return False


def stereo_to_wav_bytes(samples_stereo, sample_rate: int) -> bytes:
    """Encode a stereo audio array (numpy [channels, time] float in [-1,1])
    as 16-bit PCM WAV bytes."""
    import numpy as np
    buf = io.BytesIO()
    # Stable Audio outputs [channels, samples] — transpose for interleaved
    if hasattr(samples_stereo, "ndim") and samples_stereo.ndim == 2:
        ch = samples_stereo.shape[0]
        samples = samples_stereo.T  # [samples, channels]
    else:
        ch = 1
        samples = samples_stereo
    if hasattr(samples, "dtype") and samples.dtype.kind == "f":
        samples = (samples * 32767.0).clip(-32768, 32767).astype("int16")
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(ch)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        if hasattr(samples, "tobytes"):
            wf.writeframes(samples.tobytes())
        else:
            wf.writeframes(samples)
    return buf.getvalue()


def encode_audio(samples_stereo, sample_rate: int, fmt: str) -> bytes:
    """Encode to the requested format. WAV always; MP3/OGG via ffmpeg."""
    if fmt == "wav":
        return stereo_to_wav_bytes(samples_stereo, sample_rate)
    wav_bytes = stereo_to_wav_bytes(samples_stereo, sample_rate)
    import subprocess
    args = ["ffmpeg", "-loglevel", "error", "-i", "pipe:0",
            "-f", "mp3" if fmt == "mp3" else "ogg",
            "-acodec", "libmp3lame" if fmt == "mp3" else "libvorbis",
            "pipe:1"]
    try:
        p = subprocess.run(args, input=wav_bytes, capture_output=True, check=True)
        return p.stdout
    except Exception as e:
        logger.warning(f"ffmpeg encode to {fmt} failed: {e} — returning WAV")
        return wav_bytes


# ─── Stable Audio wrapper ──────────────────────────────────────────────
class StableAudioRunner:
    """Lazily import stable-audio-tools. Loading the diffusion model + VAE
    + conditioner takes 15-30 seconds depending on hardware."""
    def __init__(self):
        self.ready = False
        self.model = None
        self.model_config: Optional[Dict[str, Any]] = None
        self.sample_rate = SAMPLE_RATE

    def load(self):
        if self.ready:
            return
        try:
            # stable-audio-tools is the upstream library from Stability AI
            from stable_audio_tools import get_pretrained_model  # type: ignore
            import torch
        except Exception as e:
            logger.error(f"Failed to import stable-audio-tools / torch: {e}")
            raise
        logger.info(f"Loading Stable Audio model: {STABLE_AUDIO_MODEL}")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model, self.model_config = get_pretrained_model(STABLE_AUDIO_MODEL)
        self.model = self.model.to(device)
        # Sample rate from the model config; fall back to default
        sr = self.model_config.get("sample_rate") if self.model_config else None
        if sr:
            self.sample_rate = sr
        self.ready = True
        logger.info(f"Stable Audio ready — sample_rate={self.sample_rate} device={device}")

    def generate(self, req: AudioGenerateRequest) -> Dict[str, Any]:
        """Generate one audio clip. Returns the canonical response shape."""
        self.load()
        import torch
        from stable_audio_tools.inference.generation import generate_diffusion_cond  # type: ignore

        duration_sec = req.durationSec if req.durationSec is not None else DEFAULT_DURATION_SEC
        if duration_sec > MAX_DURATION_SEC:
            raise ValueError(f"durationSec {duration_sec} exceeds MAX_DURATION_SEC {MAX_DURATION_SEC}")
        if duration_sec <= 0:
            raise ValueError("durationSec must be > 0")

        steps     = req.steps    if req.steps    is not None else DEFAULT_STEPS
        cfg       = req.cfgScale if req.cfgScale is not None else DEFAULT_CFG_SCALE
        sampler   = req.sampler  or DEFAULT_SAMPLER
        fmt       = req.format   or DEFAULT_FORMAT
        seed      = req.seed if req.seed is not None else int.from_bytes(os.urandom(8), "big") % (2**31)

        t0 = time.time()
        source_sha = hashlib.sha256(
            json.dumps({
                "prompt": req.prompt, "negativePrompt": req.negativePrompt,
                "duration": duration_sec, "steps": steps, "cfg": cfg,
                "sampler": sampler, "seed": seed,
            }, sort_keys=True).encode("utf-8")
        ).hexdigest()

        # Build the conditioning dict — stable-audio-tools expects 'prompt',
        # 'seconds_start', 'seconds_total'
        conditioning = [{
            "prompt": req.prompt,
            "seconds_start": 0.0,
            "seconds_total": float(duration_sec),
        }]
        negative = None
        if req.negativePrompt:
            negative = [{
                "prompt": req.negativePrompt,
                "seconds_start": 0.0,
                "seconds_total": float(duration_sec),
            }]

        sample_size = int(duration_sec * self.sample_rate)
        device = next(self.model.parameters()).device

        with torch.no_grad():
            audio = generate_diffusion_cond(
                self.model,
                steps=steps,
                cfg_scale=cfg,
                conditioning=conditioning,
                negative_conditioning=negative,
                sample_size=sample_size,
                sigma_min=0.3,
                sigma_max=500,
                sampler_type=sampler,
                device=device,
                seed=seed,
            )

        # `audio` is a torch tensor [batch, channels, samples]
        arr = audio.squeeze(0).to("cpu").detach().numpy()  # [channels, samples]
        encoded = encode_audio(arr, self.sample_rate, fmt)
        elapsed_ms  = int((time.time() - t0) * 1000)
        output_sha  = hashlib.sha256(encoded).hexdigest()

        result: Dict[str, Any] = {
            "model":  MODEL_NAME,
            "prompt": req.prompt,
            "audio": {
                "format":      fmt,
                "sampleRate":  self.sample_rate,
                "durationSec": round(duration_sec, 3),
                "sizeBytes":   len(encoded),
                "channels":    2,
            },
            "sourceSha256": source_sha,
            "outputSha256": output_sha,
            "usage": {
                "steps":         steps,
                "elapsedMs":     elapsed_ms,
                "realTimeFactor": round(duration_sec / max(elapsed_ms / 1000.0, 0.001), 2),
                "seed":          seed,
            },
        }
        if req.outputMode == "base64":
            result["audio"]["base64"] = base64.b64encode(encoded).decode("ascii")
        else:
            ext = {"wav": "wav", "mp3": "mp3", "ogg": "ogg"}.get(fmt, "wav")
            stem = (req.filenamePrefix or "safebox-audio") + "-" + uuid.uuid4().hex[:12]
            target = WORK_DIR / f"{stem}.{ext}"
            target.write_bytes(encoded)
            result["audio"]["path"] = str(target)
        return result


audio_runner = StableAudioRunner()


# ─── Endpoints ─────────────────────────────────────────────────────────

@app.post("/v1/audio/generate")
async def v1_audio_generate(request: Request):
    global in_flight, request_count, total_audio_seconds, total_compute_ms

    body_bytes = await request.body()
    if not verify_hmac(request, body_bytes):
        raise HTTPException(status_code=401, detail="HMAC verification failed")
    try:
        req = AudioGenerateRequest(**json.loads(body_bytes))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Bad request: {e}")

    if not model_matches(req.model):
        raise HTTPException(status_code=400,
            detail=f"Model '{req.model}' not loaded. This runner serves '{MODEL_NAME}'.")
    if not CAP_TEXT2AUDIO:
        raise HTTPException(status_code=400, detail="Audio generation disabled.")
    if req.outputMode not in (None, "path", "base64"):
        raise HTTPException(status_code=400, detail=f"Unknown outputMode: {req.outputMode}")
    if req.format and req.format not in ("wav", "mp3", "ogg"):
        raise HTTPException(status_code=400, detail=f"Unknown format: {req.format}")
    if not audio_runner.ready:
        raise HTTPException(status_code=503,
            detail="Model is still loading; retry shortly")
    if not req.prompt or not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt must be non-empty")

    request_id = request.headers.get("X-Safebox-Request-Id") or str(uuid.uuid4())

    in_flight += 1
    t0 = time.time()
    try:
        result = await asyncio.to_thread(audio_runner.generate, req)
        request_count       += 1
        total_audio_seconds += result["audio"]["durationSec"]
        compute_ms = int((time.time() - t0) * 1000)
        total_compute_ms    += compute_ms
        return JSONResponse(content=result,
                            headers=safebox_headers(request_id, MODEL_NAME, compute_ms))
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Generation failed")
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")
    finally:
        in_flight -= 1


# ─── Capabilities, capacity, models, health ────────────────────────────

@app.get("/v1/capabilities")
async def capabilities():
    transport: Dict[str, Any] = {}
    if ENABLE_UNIX_SOCKET:
        transport["socket"] = {
            "path":        SAFEBOX_SOCKET_PATH,
            "permissions": "0660",
            "group":       "safebox-services",
        }
    return {
        "version":    "1.0",
        "runnerType": "audio-generation",
        "runnerId":   RUNNER_ID,
        "serviceId":  SERVICE_ID,
        "transport":  transport,
        "models": {
            "loaded":     [MODEL_NAME] if (audio_runner.ready and MODEL_NAME) else [],
            "loading":    [MODEL_NAME] if (not audio_runner.ready and MODEL_NAME) else [],
            "underlying": STABLE_AUDIO_MODEL,
        },
        "capabilities": {
            "text2audio":      CAP_TEXT2AUDIO,
            "audio2audio":     CAP_AUDIO2AUDIO,
            "inpaint":         CAP_INPAINT,
            "streaming":       CAP_STREAMING,
            "maxDurationSec":  MAX_DURATION_SEC,
            "outputFormats":   ["wav", "mp3", "ogg"],
            "sampleRate":      audio_runner.sample_rate if audio_runner.ready else SAMPLE_RATE,
            "channels":        2,
            "outputModes":     ["path", "base64"],
        },
        "defaults": {
            "durationSec": DEFAULT_DURATION_SEC,
            "steps":       DEFAULT_STEPS,
            "cfgScale":    DEFAULT_CFG_SCALE,
            "sampler":     DEFAULT_SAMPLER,
            "format":      DEFAULT_FORMAT,
        },
        "health": "healthy" if audio_runner.ready else "loading",
    }


@app.get("/v1/capacity")
async def capacity():
    return {
        "canAccept":         audio_runner.ready and in_flight < MAX_QUEUE_DEPTH,
        "inFlight":          in_flight,
        "maxQueueDepth":     MAX_QUEUE_DEPTH,
        "capacityHint":      get_capacity_hint(),
        "requestCount":      request_count,
        "totalAudioSeconds": round(total_audio_seconds, 3),
        "totalComputeMs":    total_compute_ms,
    }


@app.get("/v1/models")
async def models():
    return {
        "object": "list",
        "data": [
            {
                "id":         MODEL_NAME,
                "object":     "model",
                "owned_by":   "safebox",
                "created":    int(time.time()),
                "underlying": STABLE_AUDIO_MODEL,
            }
        ] if MODEL_NAME else [],
    }


@app.get("/health")
async def health():
    return Response(
        content=json.dumps({
            "status":            "healthy" if audio_runner.ready else "loading",
            "modelReady":        audio_runner.ready,
            "requestCount":      request_count,
            "inFlight":          in_flight,
            "totalAudioSeconds": round(total_audio_seconds, 3),
        }),
        status_code=200 if audio_runner.ready else 503,
        media_type="application/json",
    )


# ─── Socket setup ──────────────────────────────────────────────────────
def setup_unix_socket():
    if not ENABLE_UNIX_SOCKET:
        return
    sp = Path(SAFEBOX_SOCKET_PATH)
    sp.parent.mkdir(parents=True, exist_ok=True)
    if sp.exists():
        logger.info(f"Removing stale socket: {sp}")
        sp.unlink()


@app.on_event("startup")
async def on_startup():
    logger.info(f"Stable Audio runner starting — model={MODEL_NAME!r} "
                f"underlying={STABLE_AUDIO_MODEL!r}")
    setup_unix_socket()
    asyncio.get_event_loop().run_in_executor(None, audio_runner.load)


# ─── Main ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if ENABLE_UNIX_SOCKET:
        async def _adjust_perms():
            sp = Path(SAFEBOX_SOCKET_PATH)
            for _ in range(50):
                if sp.exists():
                    os.chmod(str(sp),
                             stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IWGRP)
                    try:
                        import grp, pwd
                        gid = grp.getgrnam("safebox-services").gr_gid
                        uid = pwd.getpwnam("safebox-services").pw_uid
                        os.chown(str(sp), uid, gid)
                    except Exception as e:
                        logger.warning(f"Could not chown socket: {e}")
                    break
                await asyncio.sleep(0.1)
        @app.on_event("startup")
        async def _perms_on_startup():
            asyncio.create_task(_adjust_perms())
        logger.info(f"Listening on Unix socket: {SAFEBOX_SOCKET_PATH}")
        uvicorn.run(app, uds=SAFEBOX_SOCKET_PATH, log_level="info")
    else:
        logger.info("Listening on 0.0.0.0:8080 (no Unix socket)")
        uvicorn.run(app, host="0.0.0.0", port=8080, log_level="info")
