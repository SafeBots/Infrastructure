"""
LTX-Video Runner — Safebox Local Service v1.0

Wraps Lightricks' LTX-Video (Apache 2.0) as a Safebox-canonical text-to-video
and image-to-video service. Single process, lazy library import, in-process
inference — same pattern as Kokoro and Stable Audio.

Endpoints (Safebox canonical):
    POST /v1/video/generate    — text → MP4 (or image+text → MP4)
    GET  /v1/capabilities
    GET  /v1/capacity
    GET  /v1/models
    GET  /health

Models supported via manifests:
  - ltx-2-3-distilled    fast variant, ~8 steps, FP8, 16GB VRAM minimum
  - ltx-2-3-dev          full quality, 30+ steps, 24GB+ VRAM
  - ltx-video-0-9-7      legacy 2B variant (smallest, still useful for previews)

Inference is one-shot per request (the diffusion sampler can't stream frames
incrementally in a useful way). For UX progress, the wrapper exposes a polling
endpoint /v1/jobs/{jobId} but v1.0 just blocks the request until the video is
ready. Long inference times (15-90 seconds) mean MAX_QUEUE_DEPTH defaults to 1.

Output is MP4 via ffmpeg. WebM and animated GIF are post-1.0.
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
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
import uvicorn


# ─── Logging ───────────────────────────────────────────────────────────
logger = logging.getLogger("ltx-video-runner")
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")


# ─── Configuration ─────────────────────────────────────────────────────
RUNNER_ID  = os.getenv("RUNNER_ID",  "safebox-ltx-video-1")
SERVICE_ID = os.getenv("SERVICE_ID", "video-1")
HMAC_KEY_PATH = os.getenv("HMAC_KEY_PATH", "/etc/safebox/model-api.key")
REQUIRE_HMAC  = os.getenv("SAFEBOX_REQUIRE_HMAC", "false").lower() == "true"

SAFEBOX_SOCKET_PATH = os.getenv("SAFEBOX_SOCKET_PATH",
                                 f"/run/safebox/services/{SERVICE_ID}.sock")
ENABLE_UNIX_SOCKET  = os.getenv("ENABLE_UNIX_SOCKET", "true").lower() == "true"

MODEL_NAME       = os.getenv("MODEL_NAME",        "ltx-2-3-distilled")
LTX_MODEL_PATH   = os.getenv("LTX_MODEL_PATH",    "Lightricks/LTX-Video")
LTX_VARIANT      = os.getenv("LTX_VARIANT",       "distilled")    # distilled | dev

DEFAULT_WIDTH       = int(os.getenv("DEFAULT_WIDTH",     "768"))
DEFAULT_HEIGHT      = int(os.getenv("DEFAULT_HEIGHT",    "512"))
DEFAULT_NUM_FRAMES  = int(os.getenv("DEFAULT_NUM_FRAMES","121"))    # ~5s at 24fps
DEFAULT_FPS         = int(os.getenv("DEFAULT_FPS",       "24"))
DEFAULT_STEPS       = int(os.getenv("DEFAULT_STEPS",     "8"))
DEFAULT_GUIDANCE    = float(os.getenv("DEFAULT_GUIDANCE","3.5"))
MAX_NUM_FRAMES      = int(os.getenv("MAX_NUM_FRAMES",    "481"))    # ~20s at 24fps

MAX_QUEUE_DEPTH  = int(os.getenv("MAX_QUEUE_DEPTH",  "1"))
WORK_DIR = Path(os.getenv("LTX_WORK_DIR", "/data/output"))
WORK_DIR.mkdir(parents=True, exist_ok=True)

CAP_TEXT2VIDEO   = os.getenv("CAP_TEXT2VIDEO",   "true").lower()  == "true"
CAP_IMAGE2VIDEO  = os.getenv("CAP_IMAGE2VIDEO",  "true").lower()  == "true"
CAP_VIDEO2VIDEO  = os.getenv("CAP_VIDEO2VIDEO",  "false").lower() == "true"
CAP_AUDIO        = os.getenv("CAP_AUDIO",        "true").lower()  == "true"   # LTX-2.3 natively generates synced audio
CAP_STREAMING    = False

DEFAULT_MODALITY_SCALE = float(os.getenv("DEFAULT_MODALITY_SCALE", "3.0"))  # audio-visual sync tightness; 3.0 is the LTX-recommended start
AUDIO_SAMPLE_RATE      = int(os.getenv("AUDIO_SAMPLE_RATE",       "44100"))

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
total_frames_generated: int = 0
total_video_seconds: float = 0.0
total_compute_ms: int = 0
seen_nonces = collections.OrderedDict()  # nonce -> timestamp_sec (insertion-ordered)
# ─── Pydantic request model ────────────────────────────────────────────
class VideoGenerateRequest(BaseModel):
    model:           str
    prompt:          str = Field(..., description="Text prompt")
    negativePrompt:  Optional[str]   = ""
    inputImage:      Optional[str]   = None   # path or base64 data URL
    width:           Optional[int]   = None
    height:          Optional[int]   = None
    numFrames:       Optional[int]   = None
    fps:             Optional[int]   = None
    steps:           Optional[int]   = None
    guidance:        Optional[float] = None
    seed:            Optional[int]   = None
    enableAudio:     Optional[bool]  = None    # default: True if CAP_AUDIO else False
    audioPrompt:     Optional[str]   = None    # text prompt describing the desired audio (falls back to main prompt)
    modalityScale:   Optional[float] = None    # audio-visual sync; 1.0 loose, 3.0+ tight; default 3.0
    outputMode:      Optional[str]   = "path"  # path | base64
    filenamePrefix:  Optional[str]   = "safebox-video"


# ─── App ───────────────────────────────────────────────────────────────
app = FastAPI(title="LTX-Video Safebox Runner", version="1.0")


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
    if MAX_QUEUE_DEPTH <= 1:
        return "saturated" if in_flight >= 1 else "available"
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
    if requested == LTX_MODEL_PATH:
        return True
    if "/" in LTX_MODEL_PATH and requested == LTX_MODEL_PATH.rsplit("/", 1)[-1]:
        return True
    return False


def resolve_input_image(input_image: Optional[str]) -> Optional[bytes]:
    """Accept a /data/input/foo.png path or a data: URL base64. Returns image
    bytes or None."""
    if not input_image:
        return None
    if input_image.startswith("data:"):
        try:
            comma = input_image.find(",")
            return base64.b64decode(input_image[comma+1:])
        except Exception as e:
            raise ValueError(f"Bad data: URL: {e}")
    p = Path(input_image)
    if not p.exists():
        raise ValueError(f"inputImage not found: {input_image}")
    return p.read_bytes()


def audio_to_wav_bytes(samples, sample_rate: int) -> bytes:
    """Encode a 1-D or 2-D float audio array as 16-bit PCM WAV bytes.
    LTX-2.3 produces stereo float audio at 44.1kHz."""
    import numpy as np
    import wave
    buf = io.BytesIO()
    arr = np.asarray(samples)
    if arr.ndim == 1:
        channels = 1
        interleaved = arr
    elif arr.shape[0] in (1, 2) and arr.shape[1] > arr.shape[0]:
        # [channels, samples] — transpose to [samples, channels]
        channels = arr.shape[0]
        interleaved = arr.T
    else:
        # already [samples, channels]
        channels = arr.shape[1] if arr.ndim == 2 else 1
        interleaved = arr
    if interleaved.dtype.kind == "f":
        interleaved = (interleaved.clip(-1, 1) * 32767.0).astype("int16")
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(interleaved.tobytes())
    return buf.getvalue()


def mux_video_audio(video_path: Path, audio_wav_bytes: bytes, out_path: Path) -> int:
    """Combine an existing MP4 (video-only) with WAV audio into a final MP4.
    Returns the byte size of the muxed file."""
    # Write audio to a temp wav so ffmpeg has two file inputs (cleanest)
    audio_path = out_path.with_suffix(".audio.wav")
    audio_path.write_bytes(audio_wav_bytes)
    try:
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", str(video_path),
            "-i", str(audio_path),
            "-c:v", "copy",                 # video already encoded; no re-encode
            "-c:a", "aac", "-b:a", "192k",
            "-map", "0:v:0", "-map", "1:a:0",
            "-shortest",
            str(out_path),
        ]
        p = subprocess.run(cmd, capture_output=True)
        if p.returncode != 0:
            raise RuntimeError(f"ffmpeg mux failed: {p.stderr.decode('utf-8', errors='replace')}")
        return out_path.stat().st_size
    finally:
        try: audio_path.unlink()
        except FileNotFoundError: pass


def frames_to_mp4(frames, fps: int, out_path: Path) -> int:
    """Encode a sequence of numpy frames [N, H, W, 3] uint8 into MP4 via
    ffmpeg piping raw frames. Returns the byte size of the written file."""
    import numpy as np
    if not hasattr(frames, "shape"):
        frames = np.asarray(frames)
    # Make sure frames are uint8 in [0, 255]
    if frames.dtype.kind == "f":
        frames = (frames.clip(0, 1) * 255).astype("uint8")
    n, h, w, c = frames.shape
    assert c == 3, f"Expected 3 channels, got {c}"
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{w}x{h}", "-r", str(fps),
        "-i", "pipe:0",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-preset", "fast", "-crf", "19",
        str(out_path),
    ]
    p = subprocess.run(cmd, input=frames.tobytes(), capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {p.stderr.decode('utf-8', errors='replace')}")
    return out_path.stat().st_size


# ─── LTX-Video wrapper ─────────────────────────────────────────────────
class LtxVideoRunner:
    def __init__(self):
        self.ready    = False
        self.pipeline = None
        self.device   = "cpu"
        self._pipeline_class = None
        self._supports_audio = False

    def load(self):
        if self.ready:
            return
        try:
            import torch
            # Prefer LTX-2.3's diffusers integration (returns video+audio); fall
            # back to the upstream library or the LTX-1 single-stream pipeline.
            try:
                from diffusers.pipelines.ltx2 import LTX2Pipeline  # type: ignore
                self._pipeline_class = LTX2Pipeline
                self._supports_audio = True
            except ImportError:
                try:
                    from diffusers import LTX2Pipeline  # type: ignore
                    self._pipeline_class = LTX2Pipeline
                    self._supports_audio = True
                except ImportError:
                    try:
                        from ltx_video.pipelines.pipeline_ltx_video import LTXVideoPipeline  # type: ignore
                        self._pipeline_class = LTXVideoPipeline
                        self._supports_audio = False  # upstream library — no audio path yet
                    except ImportError:
                        from diffusers import LTXPipeline  # legacy LTX-1
                        self._pipeline_class = LTXPipeline
                        self._supports_audio = False
        except Exception as e:
            logger.error(f"Failed to import LTX-Video / torch: {e}")
            raise
        logger.info(f"Loading LTX-Video — model_path={LTX_MODEL_PATH} variant={LTX_VARIANT} "
                    f"audio={'supported' if self._supports_audio else 'pipeline-version-does-not-support'}")
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.pipeline = self._pipeline_class.from_pretrained(
            LTX_MODEL_PATH,
            torch_dtype=torch.bfloat16 if self.device == "cuda" else torch.float32,
        )
        # CPU offload for the 22B dev variant — keeps it on consumer GPUs
        if self.device == "cuda" and LTX_VARIANT == "dev":
            try:
                self.pipeline.enable_model_cpu_offload()
            except Exception as e:
                logger.warning(f"enable_model_cpu_offload failed (continuing): {e}")
                self.pipeline = self.pipeline.to(self.device)
        else:
            self.pipeline = self.pipeline.to(self.device)
        self.ready = True
        logger.info(f"LTX-Video ready — device={self.device} audio_path={self._supports_audio and CAP_AUDIO}")

    def generate(self, req: VideoGenerateRequest) -> Dict[str, Any]:
        self.load()
        import torch

        width  = req.width      or DEFAULT_WIDTH
        height = req.height     or DEFAULT_HEIGHT
        # LTX requires dimensions divisible by 32
        width  = (width  // 32) * 32
        height = (height // 32) * 32
        if width <= 0 or height <= 0:
            raise ValueError(f"width and height must be > 0 (got {width}x{height})")

        n_frames = req.numFrames or DEFAULT_NUM_FRAMES
        if n_frames > MAX_NUM_FRAMES:
            raise ValueError(f"numFrames {n_frames} exceeds MAX_NUM_FRAMES {MAX_NUM_FRAMES}")
        if n_frames <= 0:
            raise ValueError("numFrames must be > 0")
        # LTX expects frame count of the form 8k+1
        n_frames = ((n_frames - 1) // 8) * 8 + 1

        fps      = req.fps      or DEFAULT_FPS
        steps    = req.steps    or DEFAULT_STEPS
        guidance = req.guidance or DEFAULT_GUIDANCE
        seed     = req.seed if req.seed is not None else int.from_bytes(os.urandom(8), "big") % (2**31)

        # Audio settings — only meaningful if the pipeline supports the audio path
        enable_audio   = (req.enableAudio if req.enableAudio is not None
                          else CAP_AUDIO) and self._supports_audio
        modality_scale = req.modalityScale if req.modalityScale is not None else DEFAULT_MODALITY_SCALE
        audio_prompt   = req.audioPrompt if req.audioPrompt else req.prompt

        t0 = time.time()
        # Source hash captures the deterministic input including audio settings
        source_payload = {
            "prompt": req.prompt, "negativePrompt": req.negativePrompt,
            "width": width, "height": height,
            "numFrames": n_frames, "fps": fps,
            "steps": steps, "guidance": guidance, "seed": seed,
            "hasInputImage": bool(req.inputImage),
            "audioEnabled":  enable_audio,
            "audioPrompt":   audio_prompt if enable_audio else None,
            "modalityScale": modality_scale if enable_audio else None,
        }
        source_sha = hashlib.sha256(
            json.dumps(source_payload, sort_keys=True).encode("utf-8")
        ).hexdigest()

        # Handle optional input image for image-to-video
        init_image = None
        if req.inputImage:
            if not CAP_IMAGE2VIDEO:
                raise ValueError("Image-to-video disabled on this runner")
            from PIL import Image
            init_image = Image.open(io.BytesIO(resolve_input_image(req.inputImage))).convert("RGB")

        generator = torch.Generator(device=self.device).manual_seed(seed)
        kwargs = {
            "prompt":            req.prompt,
            "negative_prompt":   req.negativePrompt or "",
            "width":             width,
            "height":            height,
            "num_frames":        n_frames,
            "num_inference_steps": steps,
            "guidance_scale":    guidance,
            "generator":         generator,
        }
        if init_image is not None:
            kwargs["image"] = init_image
        if enable_audio:
            kwargs["frame_rate"]     = float(fps)
            kwargs["modality_scale"] = modality_scale
            if audio_prompt and audio_prompt != req.prompt:
                # LTX-2.3 supports a distinct audio_prompt parameter; on older
                # pipelines this kwarg is harmless thanks to **kwargs handling
                kwargs["audio_prompt"] = audio_prompt
            kwargs["return_dict"] = False

        with torch.no_grad():
            out = self.pipeline(**kwargs)

        # Decode the return based on pipeline shape:
        #   LTX2Pipeline with return_dict=False → (video, audio)
        #   LTX2Pipeline with return_dict=True  → obj.videos, obj.audios
        #   Older LTX or Diffusers LTXPipeline   → obj.videos or obj.frames
        audio_array = None
        if enable_audio and isinstance(out, tuple) and len(out) == 2:
            video_out, audio_array = out
        else:
            video_out = out
        frames = getattr(video_out, "videos", None) or getattr(video_out, "frames", None) or video_out
        if hasattr(frames, "shape") and frames.ndim == 5:
            # [batch, frames, channels, H, W] — take batch 0, permute to NHWC
            frames = frames[0].permute(0, 2, 3, 1).cpu().numpy()
        elif isinstance(frames, list):
            import numpy as np
            frames = np.stack([np.asarray(f) for f in frames])

        # Write video-only MP4 first
        stem    = (req.filenamePrefix or "safebox-video") + "-" + uuid.uuid4().hex[:12]
        ext_dir = WORK_DIR
        ext_dir.mkdir(parents=True, exist_ok=True)
        video_path = ext_dir / f"{stem}.video-only.mp4"
        frames_to_mp4(frames, fps, video_path)

        # If we have audio, mux it in
        audio_wav_bytes = None
        if audio_array is not None:
            # Audio may be a torch tensor — convert to numpy
            if hasattr(audio_array, "cpu"):
                audio_array = audio_array.squeeze(0).cpu().detach().numpy() if hasattr(audio_array, "squeeze") else audio_array
            try:
                audio_wav_bytes = audio_to_wav_bytes(audio_array, AUDIO_SAMPLE_RATE)
            except Exception as e:
                logger.warning(f"Audio encoding failed; emitting video-only: {e}")
                audio_wav_bytes = None

        out_path = ext_dir / f"{stem}.mp4"
        if audio_wav_bytes:
            try:
                size_bytes = mux_video_audio(video_path, audio_wav_bytes, out_path)
                try: video_path.unlink()
                except FileNotFoundError: pass
            except Exception as e:
                # ffmpeg mux failed (e.g. ffmpeg missing, bad audio stream). Rather
                # than 500 and leave the video-only temp file orphaned on disk,
                # degrade gracefully to a video-only result.
                logger.warning(f"Audio mux failed; emitting video-only: {e}")
                audio_wav_bytes = None
                if out_path.exists():
                    try: out_path.unlink()
                    except FileNotFoundError: pass
                video_path.rename(out_path)
                size_bytes = out_path.stat().st_size
        else:
            video_path.rename(out_path)
            size_bytes = out_path.stat().st_size

        elapsed_ms = int((time.time() - t0) * 1000)
        video_seconds = n_frames / float(fps)

        # Output hash from the final mp4 bytes
        output_sha = hashlib.sha256(out_path.read_bytes()).hexdigest()

        result: Dict[str, Any] = {
            "model":  MODEL_NAME,
            "prompt": req.prompt,
            "video": {
                "format":      "mp4",
                "codec":       "h264",
                "width":       width,
                "height":      height,
                "numFrames":   n_frames,
                "fps":         fps,
                "durationSec": round(video_seconds, 3),
                "sizeBytes":   size_bytes,
                "hasAudio":    audio_wav_bytes is not None,
            },
            "sourceSha256": source_sha,
            "outputSha256": output_sha,
            "usage": {
                "steps":          steps,
                "elapsedMs":      elapsed_ms,
                "realTimeFactor": round(video_seconds / max(elapsed_ms / 1000.0, 0.001), 3),
                "seed":           seed,
                "audioEnabled":   audio_wav_bytes is not None,
                "modalityScale":  modality_scale if audio_wav_bytes else None,
            },
        }
        if audio_wav_bytes is not None:
            result["video"]["audio"] = {
                "codec":      "aac",
                "bitrateKbps": 192,
                "sampleRate": AUDIO_SAMPLE_RATE,
                "channels":   2,
                "prompt":     audio_prompt,
            }
        if req.outputMode == "base64":
            result["video"]["base64"] = base64.b64encode(out_path.read_bytes()).decode("ascii")
        else:
            result["video"]["path"] = str(out_path)
        return result


video_runner = LtxVideoRunner()


# ─── Endpoints ─────────────────────────────────────────────────────────

@app.post("/v1/video/generate")
async def v1_video_generate(request: Request):
    global in_flight, request_count, total_frames_generated, total_video_seconds, total_compute_ms

    body_bytes = await request.body()
    if not verify_hmac(request, body_bytes):
        raise HTTPException(status_code=401, detail="HMAC verification failed")
    try:
        req = VideoGenerateRequest(**json.loads(body_bytes))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Bad request: {e}")

    if not model_matches(req.model):
        raise HTTPException(status_code=400,
            detail=f"Model '{req.model}' not loaded. This runner serves '{MODEL_NAME}'.")
    if not (CAP_TEXT2VIDEO or CAP_IMAGE2VIDEO):
        raise HTTPException(status_code=400, detail="Video generation disabled.")
    if req.outputMode not in (None, "path", "base64"):
        raise HTTPException(status_code=400, detail=f"Unknown outputMode: {req.outputMode}")
    if not video_runner.ready:
        raise HTTPException(status_code=503,
            detail="Model is still loading; retry shortly")
    if not req.prompt or not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt must be non-empty")
    if in_flight >= MAX_QUEUE_DEPTH:
        raise HTTPException(status_code=503,
            detail=f"Runner at capacity (in_flight={in_flight}, max={MAX_QUEUE_DEPTH}). "
                   f"Video gen is slow — retry in 30s.")

    request_id = request.headers.get("X-Safebox-Request-Id") or str(uuid.uuid4())

    in_flight += 1
    t0 = time.time()
    try:
        result = await asyncio.to_thread(video_runner.generate, req)
        request_count          += 1
        total_frames_generated += result["video"]["numFrames"]
        total_video_seconds    += result["video"]["durationSec"]
        compute_ms = int((time.time() - t0) * 1000)
        total_compute_ms       += compute_ms
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
        "runnerType": "video-generation",
        "runnerId":   RUNNER_ID,
        "serviceId":  SERVICE_ID,
        "transport":  transport,
        "models": {
            "loaded":     [MODEL_NAME] if (video_runner.ready and MODEL_NAME) else [],
            "loading":    [MODEL_NAME] if (not video_runner.ready and MODEL_NAME) else [],
            "underlying": LTX_MODEL_PATH,
        },
        "capabilities": {
            "text2video":   CAP_TEXT2VIDEO,
            "image2video":  CAP_IMAGE2VIDEO,
            "video2video":  CAP_VIDEO2VIDEO,
            "audio":        CAP_AUDIO and video_runner._supports_audio,
            "streaming":    CAP_STREAMING,
            "maxNumFrames": MAX_NUM_FRAMES,
            "outputFormats":["mp4"],
            "outputModes":  ["path", "base64"],
        },
        "defaults": {
            "width":          DEFAULT_WIDTH,
            "height":         DEFAULT_HEIGHT,
            "numFrames":      DEFAULT_NUM_FRAMES,
            "fps":            DEFAULT_FPS,
            "steps":          DEFAULT_STEPS,
            "guidance":       DEFAULT_GUIDANCE,
            "modalityScale":  DEFAULT_MODALITY_SCALE,
            "audioSampleRate": AUDIO_SAMPLE_RATE,
        },
        "health": "healthy" if video_runner.ready else "loading",
    }


@app.get("/v1/capacity")
async def capacity():
    return {
        "canAccept":            video_runner.ready and in_flight < MAX_QUEUE_DEPTH,
        "inFlight":             in_flight,
        "maxQueueDepth":        MAX_QUEUE_DEPTH,
        "capacityHint":         get_capacity_hint(),
        "requestCount":         request_count,
        "totalFramesGenerated": total_frames_generated,
        "totalVideoSeconds":    round(total_video_seconds, 3),
        "totalComputeMs":       total_compute_ms,
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
                "underlying": LTX_MODEL_PATH,
                "variant":    LTX_VARIANT,
            }
        ] if MODEL_NAME else [],
    }


@app.get("/health")
async def health():
    return Response(
        content=json.dumps({
            "status":             "healthy" if video_runner.ready else "loading",
            "modelReady":         video_runner.ready,
            "requestCount":       request_count,
            "inFlight":           in_flight,
            "totalVideoSeconds":  round(total_video_seconds, 3),
        }),
        status_code=200 if video_runner.ready else 503,
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
    logger.info(f"LTX-Video runner starting — model={MODEL_NAME!r} variant={LTX_VARIANT}")
    setup_unix_socket()
    asyncio.get_event_loop().run_in_executor(None, video_runner.load)


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
