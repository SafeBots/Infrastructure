"""
Whisper Transcription Runner — Safebox Local Service v1.0

Wraps Faster-Whisper (CTranslate2-based, ~4x faster than reference Whisper)
as a Safebox-canonical transcription service. One model loaded per container.

Endpoints (Safebox canonical, camelCase, flat):
    POST /v1/transcribe         — transcribe a single audio file
    POST /v1/transcribe/batch   — transcribe a folder of audio files
    GET  /v1/capabilities       — runner introspection
    GET  /v1/capacity           — current load
    GET  /v1/models             — what's loaded
    GET  /health                — liveness probe

Transport: Unix socket at /run/safebox/services/{SERVICE_ID}.sock, 0660 perms,
           safebox-services group ownership.

Auth: HMAC-SHA256 of (timestamp.nonce.body) signed with the per-Safebox key.
      Gated on SAFEBOX_REQUIRE_HMAC=true. Off by default for local dev.

Sources: Local file paths only. URLs (s3://, http://, https://) are refused.
         Audio is mounted read-only into the container; the runner never
         writes to the source.

Streaming: /v1/transcribe accepts stream=true and returns SSE with each
           segment as it's produced. Useful for long audio (meetings,
           podcasts) where the UI wants to display progress.
"""

import asyncio
import collections
import hashlib
import hmac
import json
import logging
import os
import socket
import stat
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional, Set, Union
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse, Response
from pydantic import BaseModel, Field
import uvicorn


# ─── Logging ───────────────────────────────────────────────────────────
logger = logging.getLogger("whisper-runner")
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")


# ─── Configuration ─────────────────────────────────────────────────────
RUNNER_ID  = os.getenv("RUNNER_ID",  "safebox-whisper-1")
SERVICE_ID = os.getenv("SERVICE_ID", "transcribe-1")
HMAC_KEY_PATH = os.getenv("HMAC_KEY_PATH", "/etc/safebox/model-api.key")
REQUIRE_HMAC  = os.getenv("SAFEBOX_REQUIRE_HMAC", "false").lower() == "true"

SAFEBOX_SOCKET_PATH = os.getenv("SAFEBOX_SOCKET_PATH",
                                 f"/run/safebox/services/{SERVICE_ID}.sock")
ENABLE_UNIX_SOCKET  = os.getenv("ENABLE_UNIX_SOCKET", "true").lower() == "true"

# Model configuration
MODEL_NAME            = os.getenv("MODEL_NAME",          "whisper-large-v3-turbo")
FASTER_WHISPER_MODEL  = os.getenv("FASTER_WHISPER_MODEL", "large-v3-turbo")
DEVICE                = os.getenv("WHISPER_DEVICE",       "auto")  # auto | cuda | cpu
COMPUTE_TYPE          = os.getenv("WHISPER_COMPUTE_TYPE", "auto")  # auto | float16 | int8_float16 | int8 | float32
NUM_WORKERS           = int(os.getenv("WHISPER_NUM_WORKERS", "1"))
CPU_THREADS           = int(os.getenv("WHISPER_CPU_THREADS", "0"))  # 0 = auto

MAX_QUEUE_DEPTH = int(os.getenv("MAX_QUEUE_DEPTH", "4"))
WORK_DIR = Path(os.getenv("WHISPER_WORK_DIR", "/data"))
WORK_DIR.mkdir(parents=True, exist_ok=True)

# Capability flags (manifest overrides via env)
CAP_TRANSCRIBE  = os.getenv("CAP_TRANSCRIBE",   "true").lower() == "true"
CAP_TRANSLATE   = os.getenv("CAP_TRANSLATE",    "false").lower() == "true"  # large-v3 only; turbo cannot
CAP_DIARIZATION = os.getenv("CAP_DIARIZATION",  "false").lower() == "true"  # post-1.0
CAP_BATCH       = os.getenv("CAP_BATCH",        "true").lower() == "true"
CAP_STREAMING   = True

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


# ─── Mutable state ─────────────────────────────────────────────────────
model_ready: bool = False
in_flight:   int  = 0
request_count: int = 0
total_audio_seconds: float = 0.0
total_compute_ms:    int = 0
seen_nonces = collections.OrderedDict()  # nonce -> timestamp_sec (insertion-ordered)
# ─── Pydantic request models (Safebox canonical, camelCase) ────────────
class TranscribeRequest(BaseModel):
    model:           str
    source:          str = Field(..., description="file:// URL or absolute path")
    language:        Optional[str] = Field(None, description="ISO-639-1 (e.g. 'en'); None autodetects")
    task:            Optional[str] = Field("transcribe", description="'transcribe' or 'translate' (to English)")
    initialPrompt:   Optional[str] = Field(None, description="Context to bias the first window")
    wordTimestamps:  Optional[bool] = True
    vadFilter:       Optional[bool] = True
    beamSize:        Optional[int]   = 5
    temperature:     Optional[Union[float, List[float]]] = 0.0
    compressionRatioThreshold: Optional[float] = 2.4
    logProbThreshold:          Optional[float] = -1.0
    noSpeechThreshold:         Optional[float] = 0.6
    conditionOnPreviousText:   Optional[bool]  = True
    diarize:         Optional[bool] = False
    stream:          Optional[bool] = False


class TranscribeBatchRequest(BaseModel):
    model:    str
    sources:  List[str]
    language: Optional[str] = None
    task:     Optional[str] = "transcribe"
    wordTimestamps: Optional[bool] = True
    vadFilter:      Optional[bool] = True


# ─── App ───────────────────────────────────────────────────────────────
app = FastAPI(title="Whisper Safebox Runner", version="1.0")


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


def safebox_headers(request_id: str, model: str, compute_ms: int = 0,
                    extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    h = {
        "X-Safebox-Request-Id":    request_id,
        "X-Safebox-Runner-Id":     RUNNER_ID,
        "X-Safebox-Model-Id":      model,
        "X-Safebox-Compute-Ms":    str(compute_ms),
        "X-Safebox-Capacity-Hint": get_capacity_hint(),
    }
    if extra:
        h.update(extra)
    return h


def model_matches(requested: str) -> bool:
    if not requested:
        return False
    if requested == MODEL_NAME:
        return True
    if requested == FASTER_WHISPER_MODEL:
        return True
    return False


def resolve_source(source: str) -> Path:
    """Accept file:// URLs and bare absolute paths. Reject anything else."""
    if source.startswith("file://"):
        p = Path(urlparse(source).path)
    elif source.startswith(("http://", "https://", "s3://", "gs://")):
        raise ValueError("Network sources are not supported. "
                         "Stage the file into the Safebox first.")
    else:
        p = Path(source)
    if not p.is_absolute():
        raise ValueError(f"Source must be an absolute path: {source}")
    if not p.exists():
        raise FileNotFoundError(str(p))
    return p


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ─── Faster-Whisper wrapper ────────────────────────────────────────────
class WhisperRunner:
    """Lazily import faster-whisper so the import cost (loads ctranslate2,
    onnx for VAD, etc.) is paid after the health endpoint comes up."""
    def __init__(self):
        self.ready = False
        self.model = None  # the WhisperModel instance

    def load(self):
        if self.ready:
            return
        try:
            from faster_whisper import WhisperModel
        except Exception as e:
            logger.error(f"Failed to import faster-whisper: {e}")
            raise
        logger.info(f"Loading Whisper model: {FASTER_WHISPER_MODEL} "
                    f"device={DEVICE} compute_type={COMPUTE_TYPE}")
        try:
            kwargs: Dict[str, Any] = {
                "device":       DEVICE if DEVICE != "auto" else "auto",
                "compute_type": COMPUTE_TYPE if COMPUTE_TYPE != "auto" else "default",
                "num_workers":  NUM_WORKERS,
            }
            if CPU_THREADS > 0:
                kwargs["cpu_threads"] = CPU_THREADS
            self.model = WhisperModel(FASTER_WHISPER_MODEL, **kwargs)
            self.ready = True
            logger.info("Whisper ready")
        except Exception as e:
            logger.error(f"Failed to load model: {e}")
            raise

    def transcribe(self, src: Path, req: TranscribeRequest) -> Dict[str, Any]:
        """Run transcription. Returns the canonical response shape."""
        self.load()
        t0 = time.time()
        source_sha256 = file_sha256(src)

        segments_gen, info = self.model.transcribe(
            str(src),
            language=req.language,
            task=req.task or "transcribe",
            initial_prompt=req.initialPrompt,
            word_timestamps=bool(req.wordTimestamps),
            vad_filter=bool(req.vadFilter),
            beam_size=req.beamSize or 5,
            temperature=req.temperature,
            compression_ratio_threshold=req.compressionRatioThreshold,
            log_prob_threshold=req.logProbThreshold,
            no_speech_threshold=req.noSpeechThreshold,
            condition_on_previous_text=bool(req.conditionOnPreviousText),
        )

        # Materialize the generator
        out_segments: List[Dict[str, Any]] = []
        full_text_parts: List[str] = []
        for seg in segments_gen:
            entry: Dict[str, Any] = {
                "id":               seg.id,
                "start":            round(seg.start, 3),
                "end":              round(seg.end, 3),
                "text":             seg.text,
                "avgLogprob":       getattr(seg, "avg_logprob", None),
                "compressionRatio": getattr(seg, "compression_ratio", None),
                "noSpeechProb":     getattr(seg, "no_speech_prob", None),
            }
            if req.wordTimestamps and getattr(seg, "words", None):
                entry["words"] = [
                    {
                        "word":        w.word,
                        "start":       round(w.start, 3),
                        "end":         round(w.end, 3),
                        "probability": getattr(w, "probability", None),
                    }
                    for w in seg.words
                ]
            out_segments.append(entry)
            full_text_parts.append(seg.text)

        elapsed_ms = int((time.time() - t0) * 1000)
        full_text  = "".join(full_text_parts).strip()
        output_sha = hashlib.sha256(full_text.encode("utf-8")).hexdigest()

        return {
            "model":              MODEL_NAME,
            "text":               full_text,
            "language":           info.language,
            "languageConfidence": getattr(info, "language_probability", None),
            "duration":           round(info.duration, 3),
            "segments":           out_segments,
            "speakers":           None,  # diarization is a separate concern; not in v1
            "sourceSha256":       source_sha256,
            "outputSha256":       output_sha,
            "usage": {
                "audioSeconds": round(info.duration, 3),
                "elapsedMs":    elapsed_ms,
                "realTimeFactor": round(info.duration / max(elapsed_ms / 1000.0, 0.001), 2),
            },
        }

    async def transcribe_stream(self, src: Path, req: TranscribeRequest
                                 ) -> AsyncIterator[str]:
        """Streaming variant: yield SSE chunks as Faster-Whisper produces them."""
        self.load()
        t0 = time.time()
        source_sha256 = file_sha256(src)

        # Faster-Whisper transcription is synchronous; run in a thread so we
        # don't block the event loop. We materialize segments incrementally
        # by iterating the generator inside the thread and posting each
        # segment back through an asyncio queue.
        q: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue()
        DONE = {"__done__": True}

        def worker():
            try:
                segments_gen, info = self.model.transcribe(
                    str(src),
                    language=req.language,
                    task=req.task or "transcribe",
                    initial_prompt=req.initialPrompt,
                    word_timestamps=bool(req.wordTimestamps),
                    vad_filter=bool(req.vadFilter),
                    beam_size=req.beamSize or 5,
                    temperature=req.temperature,
                    compression_ratio_threshold=req.compressionRatioThreshold,
                    log_prob_threshold=req.logProbThreshold,
                    no_speech_threshold=req.noSpeechThreshold,
                    condition_on_previous_text=bool(req.conditionOnPreviousText),
                )
                asyncio.run_coroutine_threadsafe(
                    q.put({"event": "info",
                           "language": info.language,
                           "languageConfidence": getattr(info, "language_probability", None),
                           "duration": round(info.duration, 3)}),
                    loop)
                for seg in segments_gen:
                    entry: Dict[str, Any] = {
                        "event":            "segment",
                        "id":               seg.id,
                        "start":            round(seg.start, 3),
                        "end":              round(seg.end, 3),
                        "text":             seg.text,
                        "avgLogprob":       getattr(seg, "avg_logprob", None),
                        "compressionRatio": getattr(seg, "compression_ratio", None),
                        "noSpeechProb":     getattr(seg, "no_speech_prob", None),
                    }
                    if req.wordTimestamps and getattr(seg, "words", None):
                        entry["words"] = [
                            {"word": w.word,
                             "start": round(w.start, 3),
                             "end":   round(w.end, 3),
                             "probability": getattr(w, "probability", None)}
                            for w in seg.words
                        ]
                    asyncio.run_coroutine_threadsafe(q.put(entry), loop)
                asyncio.run_coroutine_threadsafe(q.put(DONE), loop)
            except Exception as e:
                asyncio.run_coroutine_threadsafe(
                    q.put({"event": "error", "error": str(e)}), loop)
                asyncio.run_coroutine_threadsafe(q.put(DONE), loop)

        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, worker)

        full_text_parts: List[str] = []
        duration = 0.0
        while True:
            chunk = await q.get()
            if chunk is DONE:
                break
            if chunk.get("event") == "info":
                duration = chunk.get("duration") or 0.0
                yield f"data: {json.dumps(chunk)}\n\n"
            elif chunk.get("event") == "segment":
                full_text_parts.append(chunk["text"])
                yield f"data: {json.dumps(chunk)}\n\n"
            elif chunk.get("event") == "error":
                yield f"data: {json.dumps(chunk)}\n\n"

        full_text = "".join(full_text_parts).strip()
        elapsed_ms = int((time.time() - t0) * 1000)
        final = {
            "event":              "done",
            "model":              MODEL_NAME,
            "text":               full_text,
            "duration":           round(duration, 3),
            "sourceSha256":       source_sha256,
            "outputSha256":       hashlib.sha256(full_text.encode("utf-8")).hexdigest(),
            "usage": {
                "audioSeconds":   round(duration, 3),
                "elapsedMs":      elapsed_ms,
                "realTimeFactor": round(duration / max(elapsed_ms / 1000.0, 0.001), 2),
            },
        }
        yield f"data: {json.dumps(final)}\n\n"
        yield "data: [DONE]\n\n"


whisper_runner = WhisperRunner()


# ─── Endpoints ─────────────────────────────────────────────────────────

@app.post("/v1/transcribe")
async def v1_transcribe(request: Request):
    global in_flight, request_count, total_audio_seconds, total_compute_ms

    body_bytes = await request.body()
    if not verify_hmac(request, body_bytes):
        raise HTTPException(status_code=401, detail="HMAC verification failed")
    try:
        req = TranscribeRequest(**json.loads(body_bytes))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Bad request: {e}")

    if not model_matches(req.model):
        raise HTTPException(
            status_code=400,
            detail=f"Model '{req.model}' not loaded. This runner serves '{MODEL_NAME}'."
        )
    if req.task == "translate" and not CAP_TRANSLATE:
        raise HTTPException(status_code=400,
            detail="Translation task not supported by this model.")
    if req.diarize and not CAP_DIARIZATION:
        raise HTTPException(status_code=400,
            detail="Diarization not enabled on this runner.")
    if not whisper_runner.ready:
        raise HTTPException(status_code=503, detail="Model is still loading; retry shortly")

    request_id = request.headers.get("X-Safebox-Request-Id") or str(uuid.uuid4())

    try:
        src = resolve_source(req.source)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=f"Source not found: {e}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    in_flight += 1
    t0 = time.time()
    try:
        if req.stream:
            request_count += 1
            return StreamingResponse(
                whisper_runner.transcribe_stream(src, req),
                media_type="text/event-stream",
                headers=safebox_headers(request_id, MODEL_NAME),
            )

        result = await asyncio.to_thread(whisper_runner.transcribe, src, req)
        request_count       += 1
        total_audio_seconds += result["duration"]
        compute_ms = int((time.time() - t0) * 1000)
        total_compute_ms    += compute_ms
        return JSONResponse(content=result,
                            headers=safebox_headers(request_id, MODEL_NAME, compute_ms))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Transcription failed")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")
    finally:
        in_flight -= 1


@app.post("/v1/transcribe/batch")
async def v1_transcribe_batch(request: Request):
    body_bytes = await request.body()
    if not verify_hmac(request, body_bytes):
        raise HTTPException(status_code=401, detail="HMAC verification failed")
    try:
        batch = TranscribeBatchRequest(**json.loads(body_bytes))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Bad request: {e}")

    if not model_matches(batch.model):
        raise HTTPException(status_code=400,
            detail=f"Model '{batch.model}' not loaded.")
    if not CAP_BATCH:
        raise HTTPException(status_code=400, detail="Batch mode disabled on this runner.")
    if not whisper_runner.ready:
        raise HTTPException(status_code=503, detail="Model is still loading")

    results = []
    for src_str in batch.sources:
        try:
            single = TranscribeRequest(
                model=batch.model, source=src_str,
                language=batch.language, task=batch.task,
                wordTimestamps=batch.wordTimestamps,
                vadFilter=batch.vadFilter,
            )
            src = resolve_source(src_str)
            r = await asyncio.to_thread(whisper_runner.transcribe, src, single)
            results.append({"source": src_str, "ok": True, "result": r})
        except Exception as e:
            results.append({"source": src_str, "ok": False, "error": str(e)})
    return {"model": batch.model, "results": results, "count": len(results)}


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
        "runnerType": "transcription",
        "runnerId":   RUNNER_ID,
        "serviceId":  SERVICE_ID,
        "transport":  transport,
        "models": {
            "loaded":   [MODEL_NAME] if (whisper_runner.ready and MODEL_NAME) else [],
            "loading":  [MODEL_NAME] if (not whisper_runner.ready and MODEL_NAME) else [],
            "underlying": FASTER_WHISPER_MODEL,
        },
        "capabilities": {
            "transcribe":      CAP_TRANSCRIBE,
            "translate":       CAP_TRANSLATE,
            "diarize":         CAP_DIARIZATION,
            "wordTimestamps":  True,
            "vadFilter":       True,
            "batch":           CAP_BATCH,
            "streaming":       CAP_STREAMING,
            "languages":       99,
            "inputFormats":    ["wav", "mp3", "m4a", "flac", "ogg", "opus", "webm", "mp4"],
        },
        "health": "healthy" if whisper_runner.ready else "loading",
    }


@app.get("/v1/capacity")
async def capacity():
    return {
        "canAccept":          whisper_runner.ready and in_flight < MAX_QUEUE_DEPTH,
        "inFlight":           in_flight,
        "maxQueueDepth":      MAX_QUEUE_DEPTH,
        "capacityHint":       get_capacity_hint(),
        "requestCount":       request_count,
        "totalAudioSeconds":  total_audio_seconds,
        "totalComputeMs":     total_compute_ms,
    }


@app.get("/v1/models")
async def models():
    return {
        "object": "list",
        "data": [
            {
                "id":       MODEL_NAME or FASTER_WHISPER_MODEL,
                "object":   "model",
                "owned_by": "safebox",
                "created":  int(time.time()),
                "permission": [],
            }
        ] if (MODEL_NAME or FASTER_WHISPER_MODEL) else [],
    }


@app.get("/health")
async def health():
    return Response(
        content=json.dumps({
            "status":            "healthy" if whisper_runner.ready else "loading",
            "modelReady":        whisper_runner.ready,
            "requestCount":      request_count,
            "inFlight":          in_flight,
            "totalAudioSeconds": total_audio_seconds,
            "totalComputeMs":    total_compute_ms,
        }),
        status_code=200 if whisper_runner.ready else 503,
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
    logger.info(f"Whisper runner starting — model={MODEL_NAME!r} "
                f"faster-whisper={FASTER_WHISPER_MODEL!r} device={DEVICE}")
    setup_unix_socket()
    # Load model in background; endpoints return 503 until ready
    asyncio.get_event_loop().run_in_executor(None, whisper_runner.load)


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
