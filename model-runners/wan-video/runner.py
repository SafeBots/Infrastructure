"""
Wan-Video runner — stub.

This file establishes the runner contract for Safebox Infrastructure. The
actual inference loop using HuggingFace Diffusers' Wan 2.1 pipelines is left
for a future implementation; what's here is the API shape, config loading,
and model-weight verification path so the rest of the system can be wired up.

The runner consumes model weights from /srv/safebox/models/<manifestHash>/
(populated by the gateway's /models/install endpoint). Weights are read
read-only; the runner has no write access to the models directory.

Run-time configuration lives in /etc/safebox/runners/wan-video/config.json
and is updated by Safebox via the gateway's /system endpoint with
managedContainer=_host. The runner reads it at startup and on SIGHUP.

Supported pipelines (14B):
  - T2V   — text-to-video           → WanPipeline
  - I2V   — image-to-video          → WanImageToVideoPipeline
  - FLF2V — first-last-frame interp  → WanImageToVideoPipeline (with last_image)
  - V2V   — video-to-video           → WanVideoToVideoPipeline
  - VACE  — controllable generation   → WanVACEPipeline

Supported pipelines (1.3B):
  - T2V, VACE only

This stub is NOT production-ready. Things still to wire:
  - Load weights via diffusers (WanPipeline, WanImageToVideoPipeline, etc.)
  - Hook into the actual diffusion sampler
  - Implement video encoding (MP4 via ffmpeg or imageio)
  - Implement VACE control preprocessing (depth, pose, sketch, etc.)
  - Add proper frame-by-frame output (currently returns empty MP4 placeholder)
"""

import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Optional, Literal

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field
import uvicorn

# Import shared HMAC auth
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from safebox_auth import verify_hmac, derive_deterministic_seed, strip_seed_from_body


logger = logging.getLogger(__name__)

CONFIG_PATH = Path(os.environ.get(
    "WAN_VIDEO_CONFIG",
    "/etc/safebox/runners/wan-video/config.json",
))
MODELS_ROOT = Path(os.environ.get(
    "SAFEBOX_MODELS_ROOT",
    "/srv/safebox/models",
))
LISTEN_HOST = os.environ.get("WAN_VIDEO_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("WAN_VIDEO_PORT", "7792"))

PIPELINE_NAMES = {"all", "t2v", "i2v", "flf2v", "v2v", "vace"}


def _apply_deterministic_seed(req, request: Request):
    """If seedMode is deterministic and no explicit seed, derive one from HMAC key + request body."""
    if getattr(req, "seedMode", None) == "deterministic" and req.seed is None:
        # FastAPI already consumed the body; reconstruct from the parsed model.
        body_bytes = req.model_dump_json(exclude={"seed", "seedMode"}).encode()
        req.seed = derive_deterministic_seed(body_bytes)
VARIANT_14B_ONLY = {"i2v", "flf2v", "v2v"}
CONTROL_TYPES = {"depth", "pose", "sketch", "flow", "scribble", "inpaint", "outpaint", "reference"}


class Config(BaseModel):
    modelManifestHash: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    variant: str = Field(..., pattern=r"^(14B|1\.3B)$")
    pipeline: str = Field(default="all")


def load_config() -> Config:
    if not CONFIG_PATH.exists():
        raise RuntimeError(f"config not found at {CONFIG_PATH}")
    with open(CONFIG_PATH) as f:
        raw = json.load(f)
    cfg = Config(**raw)
    if cfg.pipeline not in PIPELINE_NAMES:
        raise RuntimeError(f"unknown pipeline: {cfg.pipeline}")
    if cfg.variant == "1.3B" and cfg.pipeline in VARIANT_14B_ONLY:
        raise RuntimeError(
            f"pipeline '{cfg.pipeline}' requires 14B variant, got 1.3B"
        )
    return cfg


def verify_model_dir(manifest_hash: str) -> Path:
    """Confirm the model directory exists and the manifest hashes correctly."""
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
    if manifest.get("runnerType") != "wan-video":
        raise RuntimeError(
            f"manifest runnerType={manifest.get('runnerType')}, "
            f"expected 'wan-video'"
        )
    return model_dir


def pipeline_enabled(name: str) -> bool:
    """Check whether a pipeline is active in the current config."""
    if _config is None:
        return False
    if _config.pipeline == "all":
        # 1.3B can only run t2v and vace
        if _config.variant == "1.3B" and name in VARIANT_14B_ONLY:
            return False
        return True
    return _config.pipeline == name


# ── API schema ───────────────────────────────────────────────────────────────


class GenerateRequest(BaseModel):
    """Text-to-Video: prompt → video"""
    prompt: str = Field(..., min_length=1, max_length=4096)
    width: int = Field(default=1280, ge=256, le=1920)
    height: int = Field(default=720, ge=256, le=1080)
    numFrames: int = Field(default=81, ge=1, le=257)
    seed: Optional[int] = Field(default=None, ge=0, le=2**32 - 1)
    seedMode: Optional[str] = None   # "deterministic" → derive seed from HMAC key + request
    guidanceScale: float = Field(default=5.5, ge=1.0, le=20.0)
    numInferenceSteps: int = Field(default=50, ge=1, le=200)


class AnimateRequest(BaseModel):
    """Image-to-Video: single image → animated video"""
    prompt: str = Field(..., min_length=1, max_length=4096)
    image: str = Field(..., description="Base64-encoded PNG of the starting frame")
    width: int = Field(default=1280, ge=256, le=1920)
    height: int = Field(default=720, ge=256, le=1080)
    numFrames: int = Field(default=81, ge=1, le=257)
    seed: Optional[int] = Field(default=None, ge=0, le=2**32 - 1)
    seedMode: Optional[str] = None
    guidanceScale: float = Field(default=5.5, ge=1.0, le=20.0)
    numInferenceSteps: int = Field(default=50, ge=1, le=200)


class InterpolateRequest(BaseModel):
    """First-Last-Frame: two keyframes → interpolated video"""
    prompt: str = Field(..., min_length=1, max_length=4096)
    firstFrame: str = Field(..., description="Base64-encoded PNG of the first keyframe")
    lastFrame: str = Field(..., description="Base64-encoded PNG of the last keyframe")
    width: int = Field(default=1280, ge=256, le=1920)
    height: int = Field(default=720, ge=256, le=1080)
    numFrames: int = Field(default=81, ge=1, le=257)
    seed: Optional[int] = Field(default=None, ge=0, le=2**32 - 1)
    seedMode: Optional[str] = None
    guidanceScale: float = Field(default=5.5, ge=1.0, le=20.0)
    numInferenceSteps: int = Field(default=50, ge=1, le=200)


class RestyleRequest(BaseModel):
    """Video-to-Video: source video + prompt → restyled output"""
    prompt: str = Field(..., min_length=1, max_length=4096)
    video: str = Field(..., description="Base64-encoded MP4 of the source video")
    strength: float = Field(default=0.8, ge=0.0, le=1.0)
    seed: Optional[int] = Field(default=None, ge=0, le=2**32 - 1)
    seedMode: Optional[str] = None
    guidanceScale: float = Field(default=5.5, ge=1.0, le=20.0)
    numInferenceSteps: int = Field(default=50, ge=1, le=200)


class ControlRequest(BaseModel):
    """VACE: controllable generation with depth/pose/sketch/etc."""
    prompt: str = Field(..., min_length=1, max_length=4096)
    controlType: str = Field(..., description="One of: depth, pose, sketch, flow, scribble, inpaint, outpaint, reference")
    controlVideo: str = Field(..., description="Base64-encoded MP4 of the control signal")
    width: int = Field(default=1280, ge=256, le=1920)
    height: int = Field(default=720, ge=256, le=1080)
    numFrames: int = Field(default=81, ge=1, le=257)
    seed: Optional[int] = Field(default=None, ge=0, le=2**32 - 1)
    seedMode: Optional[str] = None
    guidanceScale: float = Field(default=5.5, ge=1.0, le=20.0)
    numInferenceSteps: int = Field(default=50, ge=1, le=200)


class VideoResponse(BaseModel):
    width: int
    height: int
    numFrames: int
    fps: int
    formatHint: str
    videoBase64: str
    modelManifestHash: str
    variant: str
    pipeline: str


app = FastAPI(title="Wan-Video Runner", version="0.1.0")


@app.middleware("http")
async def hmac_middleware(request: Request, call_next):
    """Verify HMAC on POST requests using shared safebox_auth."""
    if request.method == "POST":
        body = await request.body()
        if not verify_hmac(request, body):
            return Response(
                content=json.dumps({"ok": False, "error": "HMAC verification failed"}),
                status_code=401,
                media_type="application/json",
            )
    return await call_next(request)

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
        "wan-video runner ready: variant=%s pipeline=%s manifestHash=%s model_dir=%s",
        _config.variant, _config.pipeline, _config.modelManifestHash, _model_dir,
    )


def _make_response(pipeline_name: str, width: int, height: int,
                    num_frames: int, request: Request, start_time: float) -> Response:
    """Build a stub video response with telemetry headers."""
    import base64

    request_id = request.headers.get("X-Safebox-Request-Id", str(uuid.uuid4()))
    compute_ms = int((time.time() - start_time) * 1000)

    # STUB: return an empty bytes placeholder where the MP4 would go
    body = VideoResponse(
        width=width,
        height=height,
        numFrames=num_frames,
        fps=24,
        formatHint="video/mp4",
        videoBase64=base64.b64encode(b"").decode("ascii"),
        modelManifestHash=_config.modelManifestHash,
        variant=_config.variant,
        pipeline=pipeline_name,
    )
    resp = Response(
        content=body.model_dump_json(),
        media_type="application/json",
    )
    resp.headers["X-Safebox-Request-Id"] = request_id
    resp.headers["X-Safebox-Runner-Id"] = "wan-video"
    resp.headers["X-Safebox-Model-Id"] = f"wan-video/{_config.variant}"
    resp.headers["X-Safebox-Pipeline"] = pipeline_name
    resp.headers["X-Safebox-Compute-Ms"] = str(compute_ms)
    resp.headers["X-Safebox-Capacity-Hint"] = "available"
    return resp


@app.get("/v1/healthz")
def healthz() -> dict:
    return {
        "status": "ok",
        "modelManifestHash": _config.modelManifestHash if _config else None,
        "variant": _config.variant if _config else None,
        "pipeline": _config.pipeline if _config else None,
    }


@app.get("/v1/capabilities")
def capabilities() -> dict:
    """Report which pipelines this runner instance can serve."""
    all_pipelines = ["t2v", "i2v", "flf2v", "v2v", "vace"]
    return {
        "runner": "wan-video",
        "variant": _config.variant if _config else None,
        "pipelines": {p: pipeline_enabled(p) for p in all_pipelines},
        "controlTypes": list(CONTROL_TYPES),
        "maxResolution": {"width": 1920, "height": 1080} if _config and _config.variant == "14B" else {"width": 1280, "height": 720},
    }


@app.get("/v1/capacity")
def capacity() -> dict:
    return {
        "status": "available",
        "queueDepth": 0,
        "gpuUtilization": 0.0,
    }


@app.post("/v1/video/generate")
def generate(req: GenerateRequest, request: Request) -> Response:
    _apply_deterministic_seed(req, request)
    if not pipeline_enabled("t2v"):
        raise HTTPException(status_code=404, detail="T2V pipeline not enabled on this runner")
    if _config is None or _model_dir is None:
        raise HTTPException(status_code=503, detail="runner not initialized")

    start_time = time.time()

    # ── STUB: real inference goes here ──────────────────────────────────────
    # In production, this would:
    #   1. Load WanPipeline from _model_dir
    #   2. pipe(prompt=req.prompt, height=req.height, width=req.width,
    #           num_frames=req.numFrames, guidance_scale=req.guidanceScale,
    #           num_inference_steps=req.numInferenceSteps, generator=...)
    #   3. Encode output frames as MP4 via imageio/ffmpeg
    # ────────────────────────────────────────────────────────────────────────

    return _make_response("t2v", req.width, req.height, req.numFrames, request, start_time)


@app.post("/v1/video/animate")
def animate(req: AnimateRequest, request: Request) -> Response:
    _apply_deterministic_seed(req, request)
    if not pipeline_enabled("i2v"):
        raise HTTPException(status_code=404, detail="I2V pipeline not enabled (requires 14B)")
    if _config is None or _model_dir is None:
        raise HTTPException(status_code=503, detail="runner not initialized")

    start_time = time.time()

    # ── STUB: WanImageToVideoPipeline ──────────────────────────────────────
    # pipe(image=decoded_image, prompt=req.prompt, ...)
    # ────────────────────────────────────────────────────────────────────────

    return _make_response("i2v", req.width, req.height, req.numFrames, request, start_time)


@app.post("/v1/video/interpolate")
def interpolate(req: InterpolateRequest, request: Request) -> Response:
    _apply_deterministic_seed(req, request)
    if not pipeline_enabled("flf2v"):
        raise HTTPException(status_code=404, detail="FLF2V pipeline not enabled (requires 14B)")
    if _config is None or _model_dir is None:
        raise HTTPException(status_code=503, detail="runner not initialized")

    start_time = time.time()

    # ── STUB: WanImageToVideoPipeline with last_image ─────────────────────
    # pipe(image=first_frame, last_image=last_frame, prompt=req.prompt, ...)
    # ────────────────────────────────────────────────────────────────────────

    return _make_response("flf2v", req.width, req.height, req.numFrames, request, start_time)


@app.post("/v1/video/restyle")
def restyle(req: RestyleRequest, request: Request) -> Response:
    _apply_deterministic_seed(req, request)
    if not pipeline_enabled("v2v"):
        raise HTTPException(status_code=404, detail="V2V pipeline not enabled (requires 14B)")
    if _config is None or _model_dir is None:
        raise HTTPException(status_code=503, detail="runner not initialized")

    start_time = time.time()

    # ── STUB: WanVideoToVideoPipeline ─────────────────────────────────────
    # pipe(video=decoded_video, prompt=req.prompt, strength=req.strength, ...)
    # ────────────────────────────────────────────────────────────────────────

    return _make_response("v2v", 0, 0, 0, request, start_time)


@app.post("/v1/video/control")
def control(req: ControlRequest, request: Request) -> Response:
    _apply_deterministic_seed(req, request)
    if not pipeline_enabled("vace"):
        raise HTTPException(status_code=404, detail="VACE pipeline not enabled on this runner")
    if _config is None or _model_dir is None:
        raise HTTPException(status_code=503, detail="runner not initialized")
    if req.controlType not in CONTROL_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"unknown controlType: {req.controlType}. Must be one of: {', '.join(sorted(CONTROL_TYPES))}"
        )

    start_time = time.time()

    # ── STUB: WanVACEPipeline ─────────────────────────────────────────────
    # Preprocess control video with controlnet_aux (depth/pose/canny/...)
    # pipe(prompt=req.prompt, control_video=preprocessed, ...)
    # ────────────────────────────────────────────────────────────────────────

    return _make_response("vace", req.width, req.height, req.numFrames, request, start_time)


if __name__ == "__main__":
    uvicorn.run(app, host=LISTEN_HOST, port=LISTEN_PORT)
