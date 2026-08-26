"""
Orpheus / Higgs-v2 TTS Runner — Safebox Local Service v1.0

Wraps the Chatterbox TTS library (Resemble AI, MIT). Zero-shot voice cloning
from a reference clip, emotion-exaggeration control, PerTh watermark on output.
as a Safebox-canonical speech synthesis service. One process loads the
model into GPU/CPU memory and serves requests over a Unix socket.

Endpoints (Safebox canonical, camelCase, flat):
    POST /v1/speech            — text → audio (single shot or streaming SSE)
    GET  /v1/voices            — list the bundled voice library
    GET  /v1/capabilities      — runner introspection
    GET  /v1/capacity          — current load
    GET  /v1/models            — what's loaded
    GET  /health               — liveness probe

Transport: Unix socket at /run/safebox/services/{SERVICE_ID}.sock,
           0660 perms, safebox-services group ownership.

Auth: HMAC-SHA256 of (timestamp.nonce.body) — same convention as the
      other Safebox runners. Gated on SAFEBOX_REQUIRE_HMAC=true; off
      for local dev.

Output:
  - "path" (default): WAV/MP3/OGG written to /data/output/, response
    includes the file path
  - "base64": audio bytes inline

Streaming:
  /v1/speech accepts stream=true and returns SSE with audio chunks as
  the model produces it. Useful where the UI wants incremental delivery.
  play audio while the rest is still being generated.
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
import struct
import time
import uuid
import wave
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional, Set

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse, Response
from pydantic import BaseModel, Field
import uvicorn


# ─── Logging ───────────────────────────────────────────────────────────
logger = logging.getLogger("orpheus-runner")
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")


# ─── Configuration ─────────────────────────────────────────────────────
RUNNER_ID  = os.getenv("RUNNER_ID",  "safebox-orpheus-1")
SERVICE_ID = os.getenv("SERVICE_ID", "speech-1")
HMAC_KEY_PATH = os.getenv("HMAC_KEY_PATH", "/etc/safebox/model-api.key")
REQUIRE_HMAC  = os.getenv("SAFEBOX_REQUIRE_HMAC", "false").lower() == "true"

SAFEBOX_SOCKET_PATH = os.getenv("SAFEBOX_SOCKET_PATH",
                                 f"/run/safebox/services/{SERVICE_ID}.sock")
ENABLE_UNIX_SOCKET  = os.getenv("ENABLE_UNIX_SOCKET", "true").lower() == "true"

MODEL_NAME = os.getenv("SAFEBOX_MODEL_NAME", "orpheus-3b")
CHATTERBOX_EXAGGERATION = float(os.getenv("SAFEBOX_EXAGGERATION", "0.5"))    # 0=flat .. 1=dramatic; emotion intensity
DEFAULT_VOICE    = os.getenv("DEFAULT_VOICE",    "af_heart")
DEFAULT_SPEED    = float(os.getenv("DEFAULT_SPEED",  "1.0"))
DEFAULT_FORMAT   = os.getenv("DEFAULT_FORMAT",   "wav")
SAMPLE_RATE      = int(os.getenv("SAFEBOX_SAMPLE_RATE", "24000"))

MAX_QUEUE_DEPTH = int(os.getenv("MAX_QUEUE_DEPTH", "4"))
WARMUP_TIMEOUT_S = int(os.getenv("WARMUP_TIMEOUT_S", "120"))
WORK_DIR = Path(os.getenv("SAFEBOX_WORK_DIR", "/data/output"))
WORK_DIR.mkdir(parents=True, exist_ok=True)

# Capability flags
CAP_SPEECH        = os.getenv("CAP_SPEECH",        "true").lower() == "true"
CAP_VOICE_CLONE   = os.getenv("CAP_VOICE_CLONE",   "false").lower() == "true"  # post-1.0
CAP_EMOTION       = os.getenv("CAP_EMOTION",       "true").lower() == "true"   # Chatterbox exposes emotion exaggeration
CAP_STREAMING     = True

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
total_chars_synthesized: int = 0
total_audio_seconds: float = 0.0
total_compute_ms: int = 0
seen_nonces = collections.OrderedDict()  # nonce -> timestamp_sec (insertion-ordered)
# ─── Pydantic request models ───────────────────────────────────────────
class SpeechRequest(BaseModel):
    model:        str
    text:         str = Field(..., description="Text to synthesize")
    voice:        Optional[str]   = None
    speed:        Optional[float] = None
    format:       Optional[str]   = None       # wav | mp3 | ogg
    outputMode:   Optional[str]   = "path"     # path | base64
    stream:       Optional[bool]  = False
    filenamePrefix: Optional[str] = "safebox-speech"


# ─── App ───────────────────────────────────────────────────────────────
app = FastAPI(title="Orpheus/Higgs Safebox Runner", version="1.0")


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
    # Also accept short variants
    if MODEL_NAME and requested in MODEL_NAME:
        return True
    return False


def pcm_to_wav_bytes(samples, sample_rate: int) -> bytes:
    """Encode a numpy float array (-1..1) or int16 array as WAV bytes."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit PCM
        wf.setframerate(sample_rate)
        # Convert to int16 if floating point
        if hasattr(samples, "dtype") and samples.dtype.kind == "f":
            import numpy as np
            samples = (samples * 32767.0).clip(-32768, 32767).astype("int16")
        if hasattr(samples, "tobytes"):
            wf.writeframes(samples.tobytes())
        else:
            wf.writeframes(samples)
    return buf.getvalue()


def encode_audio(samples, sample_rate: int, fmt: str) -> bytes:
    """Encode samples in the requested format. WAV is always supported.
    MP3 and OGG require ffmpeg via subprocess; the runner falls back to WAV
    with a logged warning if encoding fails."""
    if fmt == "wav":
        return pcm_to_wav_bytes(samples, sample_rate)
    # For MP3 / OGG, encode via ffmpeg (added to the container Dockerfile)
    wav_bytes = pcm_to_wav_bytes(samples, sample_rate)
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


# ─── Chatterbox wrapper ─────────────────────────────────────────────────
class OrpheusRunner:
    """Orpheus (Canopy AI, Apache-2.0) / Higgs-Audio-v2 (Boson AI, Apache-2.0)
    TTS runner.

    Both are Llama-architecture Speech-LLMs, so they load through the same
    transformers path and can also be served via vLLM/SGLang externally. This
    runner uses the in-process transformers loader for a self-contained box;
    for high-throughput serving, point MODEL_NAME at a vLLM-Omni endpoint
    instead (see notes in the manifest).

    MODEL_NAME selects the checkpoint family:
      orpheus-3b        -> canopylabs/orpheus-3b-0.1-ft   (Apache-2.0)
      higgs-audio-v2-3b -> bosonai/higgs-audio-v2-...     (Apache-2.0; v2 ONLY)
    The repo/revision is resolved from the install-time manifest, not hardcoded.
    """
    def __init__(self):
        self.ready = False
        self.engine = None
        self.kind = None  # "orpheus" | "higgs"

    def load(self):
        if self.ready:
            return
        try:
            import torch  # noqa: F401
            self.kind = "higgs" if "higgs" in MODEL_NAME.lower() else "orpheus"
            device = "cuda" if _cuda_available() else "cpu"
            logger.info(f"Loading {self.kind} ({MODEL_NAME}) on {device}")
            if self.kind == "orpheus":
                # Orpheus ships a small inference wrapper; fall back to the
                # generic transformers pipeline if the package name differs.
                try:
                    from orpheus_tts import OrpheusModel  # type: ignore
                    self.engine = OrpheusModel(model_name=_repo_for(MODEL_NAME))
                except ImportError:
                    self.engine = _load_transformers_speechlm(_repo_for(MODEL_NAME))
            else:
                # Higgs Audio v2 generation model.
                try:
                    from boson_multimodal.serve.serve_engine import HiggsAudioServeEngine  # type: ignore
                    self.engine = HiggsAudioServeEngine(_repo_for(MODEL_NAME))
                except ImportError:
                    self.engine = _load_transformers_speechlm(_repo_for(MODEL_NAME))
            self.ready = True
            logger.info(f"{self.kind} ready")
        except Exception as e:
            logger.error(f"Failed to load {MODEL_NAME}: {e}")
            raise

    def synthesize(self, req: "SpeechRequest") -> Dict[str, Any]:
        self.load()
        import numpy as np
        fmt = req.format or DEFAULT_FORMAT
        t0 = time.time()
        source_sha = hashlib.sha256(req.text.encode("utf-8")).hexdigest()

        # Both engines expose a generate() returning audio samples; the exact
        # call differs, so normalise to a numpy float array at SAMPLE_RATE.
        voice = req.voice or "default"
        arr = _generate_audio(self.engine, self.kind, req.text, voice)
        arr = arr.squeeze() if hasattr(arr, "squeeze") else np.asarray(arr)

        audio_seconds = float(len(arr)) / SAMPLE_RATE
        encoded = encode_audio(arr, SAMPLE_RATE, fmt)
        elapsed_ms = int((time.time() - t0) * 1000)
        result: Dict[str, Any] = {
            "model": MODEL_NAME,
            "voice": voice,
            "audio": {"format": fmt, "sampleRate": SAMPLE_RATE,
                      "durationSec": round(audio_seconds, 3), "sizeBytes": len(encoded)},
            "sourceSha256": source_sha,
            "outputSha256": hashlib.sha256(encoded).hexdigest(),
            "usage": {"characters": len(req.text),
                      "audioSeconds": round(audio_seconds, 3), "elapsedMs": elapsed_ms,
                      "realTimeFactor": round(audio_seconds / max(elapsed_ms/1000.0, 0.001), 2)},
        }
        if req.outputMode == "base64":
            result["audio"]["base64"] = base64.b64encode(encoded).decode("ascii")
        else:
            ext = {"wav": "wav", "mp3": "mp3", "ogg": "ogg"}.get(fmt, "wav")
            stem = (req.filenamePrefix or "safebox-speech") + "-" + uuid.uuid4().hex[:12]
            target = WORK_DIR / f"{stem}.{ext}"
            target.write_bytes(encoded); result["audio"]["path"] = str(target)
        return result

    async def synthesize_stream(self, req: "SpeechRequest") -> AsyncIterator[str]:
        result = self.synthesize(req)
        yield "data: " + json.dumps({"event": "chunk",
            "audioBase64": result["audio"].get("base64")
                or base64.b64encode(Path(result["audio"]["path"]).read_bytes()).decode("ascii"),
            "durationSec": result["audio"]["durationSec"]}) + "\n\n"
        yield "data: " + json.dumps({"event": "done", "model": MODEL_NAME,
            "outputSha256": result["outputSha256"], "usage": result["usage"]}) + "\n\n"


# ── model-family helpers ────────────────────────────────────────────────
_REPO_MAP = {
    "orpheus-3b":        os.getenv("ORPHEUS_REPO", "canopylabs/orpheus-3b-0.1-ft"),
    "higgs-audio-v2-3b": os.getenv("HIGGS_REPO",   "bosonai/higgs-audio-v2-generation-3B-base"),
}
def _repo_for(name: str) -> str:
    return _REPO_MAP.get(name, name)

def _load_transformers_speechlm(repo: str):
    # Generic fallback loader. trust_remote_code stays FALSE here — these two
    # models are Apache and load with standard transformers; if a checkpoint
    # needs remote code, that must be gated at install time, not enabled here.
    from transformers import AutoModelForCausalLM, AutoTokenizer  # type: ignore
    import torch
    tok = AutoTokenizer.from_pretrained(repo)
    mdl = AutoModelForCausalLM.from_pretrained(
        repo, torch_dtype=torch.float16 if _cuda_available() else torch.float32,
        device_map="auto" if _cuda_available() else None)
    return {"tokenizer": tok, "model": mdl}

def _generate_audio(engine, kind: str, text: str, voice: str):
    import numpy as np
    # Native engines expose their own generate(); the transformers fallback
    # returns a dict and would need the model's audio-detokenizer, which is
    # model-specific. We call the native path when present and otherwise raise
    # a clear error rather than emit silence.
    if hasattr(engine, "generate_speech"):
        return np.asarray(engine.generate_speech(text, voice=voice))
    if hasattr(engine, "generate") and not isinstance(engine, dict):
        out = engine.generate(text)
        return np.asarray(getattr(out, "audio", out))
    raise RuntimeError(
        f"{kind}: native audio generation path unavailable in this image. "
        "Install the model's inference package (orpheus_tts / boson_multimodal) "
        "or serve via vLLM-Omni and point MODEL_NAME at that endpoint.")


def _cuda_available() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


tts_runner = OrpheusRunner()


# ─── Endpoints ─────────────────────────────────────────────────────────

@app.post("/v1/speech")
async def v1_speech(request: Request):
    global in_flight, request_count, total_chars_synthesized, total_audio_seconds, total_compute_ms

    body_bytes = await request.body()
    if not verify_hmac(request, body_bytes):
        raise HTTPException(status_code=401, detail="HMAC verification failed")
    try:
        req = SpeechRequest(**json.loads(body_bytes))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Bad request: {e}")

    if not model_matches(req.model):
        raise HTTPException(status_code=400,
            detail=f"Model '{req.model}' not loaded. This runner serves '{MODEL_NAME}'.")
    if not CAP_SPEECH:
        raise HTTPException(status_code=400, detail="Speech synthesis disabled.")
    if req.outputMode not in (None, "path", "base64"):
        raise HTTPException(status_code=400, detail=f"Unknown outputMode: {req.outputMode}")
    if req.format and req.format not in ("wav", "mp3", "ogg"):
        raise HTTPException(status_code=400, detail=f"Unknown format: {req.format}")
    if not tts_runner.ready:
        raise HTTPException(status_code=503,
            detail="Model is still loading; retry shortly")
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text must be non-empty")

    request_id = request.headers.get("X-Safebox-Request-Id") or str(uuid.uuid4())

    in_flight += 1
    t0 = time.time()
    try:
        if req.stream:
            request_count += 1
            return StreamingResponse(
                tts_runner.synthesize_stream(req),
                media_type="text/event-stream",
                headers=safebox_headers(request_id, MODEL_NAME),
            )

        result = await asyncio.to_thread(tts_runner.synthesize, req)
        request_count            += 1
        total_chars_synthesized  += len(req.text)
        total_audio_seconds      += result["audio"]["durationSec"]
        compute_ms = int((time.time() - t0) * 1000)
        total_compute_ms         += compute_ms
        return JSONResponse(content=result,
                            headers=safebox_headers(request_id, MODEL_NAME, compute_ms))
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Synthesis failed")
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {e}")
    finally:
        in_flight -= 1


@app.get("/v1/voices")
async def v1_voices():
    return {
        "model":  MODEL_NAME,
        "voices": tts_runner.voices if tts_runner.ready else [],
        "default": DEFAULT_VOICE,
        "voiceCount": len(tts_runner.voices) if tts_runner.ready else 0,
    }


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
        "runnerType": "speech-tts",
        "runnerId":   RUNNER_ID,
        "serviceId":  SERVICE_ID,
        "transport":  transport,
        "models": {
            "loaded":     [MODEL_NAME] if (tts_runner.ready and MODEL_NAME) else [],
            "loading":    [MODEL_NAME] if (not tts_runner.ready and MODEL_NAME) else [],
            "underlying": "kokoro",
        },
        "capabilities": {
            "speech":      CAP_SPEECH,
            "voiceClone":  CAP_VOICE_CLONE,
            "emotion":     CAP_EMOTION,
            "streaming":   CAP_STREAMING,
            "voiceCount":  len(tts_runner.voices) if tts_runner.ready else 0,
            "languages":   ["en-US", "en-GB"],   # Kokoro lang_code dependent
            "outputFormats": ["wav", "mp3", "ogg"],
            "sampleRate":  SAMPLE_RATE,
        },
        "defaults": {
            "voice":  DEFAULT_VOICE,
            "speed":  DEFAULT_SPEED,
            "format": DEFAULT_FORMAT,
        },
        "health": "healthy" if tts_runner.ready else "loading",
    }


@app.get("/v1/capacity")
async def capacity():
    return {
        "canAccept":             tts_runner.ready and in_flight < MAX_QUEUE_DEPTH,
        "inFlight":              in_flight,
        "maxQueueDepth":         MAX_QUEUE_DEPTH,
        "capacityHint":          get_capacity_hint(),
        "requestCount":          request_count,
        "totalCharsSynthesized": total_chars_synthesized,
        "totalAudioSeconds":     round(total_audio_seconds, 3),
        "totalComputeMs":        total_compute_ms,
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
                "underlying": "kokoro",
                "voiceCount": len(tts_runner.voices) if tts_runner.ready else 0,
            }
        ] if MODEL_NAME else [],
    }


@app.get("/health")
async def health():
    return Response(
        content=json.dumps({
            "status":                "healthy" if tts_runner.ready else "loading",
            "modelReady":            tts_runner.ready,
            "requestCount":          request_count,
            "inFlight":              in_flight,
            "totalCharsSynthesized": total_chars_synthesized,
            "totalAudioSeconds":     round(total_audio_seconds, 3),
        }),
        status_code=200 if tts_runner.ready else 503,
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
    logger.info(f"Chatterbox runner starting — model={MODEL_NAME!r} "
                f"exaggeration={CHATTERBOX_EXAGGERATION} default_voice={DEFAULT_VOICE}")
    setup_unix_socket()
    asyncio.get_event_loop().run_in_executor(None, tts_runner.load)


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
