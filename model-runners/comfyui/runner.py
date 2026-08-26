"""
ComfyUI Image Generation Runner — Safebox Local Service v1.0

Translates Safebox-canonical text-to-image requests into ComfyUI workflow
graphs, submits to ComfyUI's HTTP API, polls for completion, and returns
the resulting images.

Architecture (single container, two processes via supervisord):

    ┌─ container ─────────────────────────────────────────────────────────┐
    │                                                                     │
    │  ComfyUI (text-to-image diffusion engine)                           │
    │      listens on 127.0.0.1:8188  (ComfyUI HTTP/WS)                   │
    │         ▲                                                           │
    │         │ POST /prompt    (submit workflow)                         │
    │         │ GET  /history   (poll for completion)                     │
    │         │ GET  /view      (fetch output image bytes)                │
    │         │                                                           │
    │  runner.py  (this file)                                             │
    │      listens on Unix socket  /run/safebox/services/image-1.sock     │
    │      maps Safebox protocol → ComfyUI workflow graphs                │
    │      HMAC, audit-trail SHA-256, capability gating                   │
    │                                                                     │
    └─────────────────────────────────────────────────────────────────────┘

Endpoints (Safebox canonical):
    POST /v1/image/generate    — text-to-image
    GET  /v1/capabilities
    GET  /v1/capacity
    GET  /v1/models
    GET  /health

Workflow templates live at /app/workflows/<family>-text2image.json. Each
manifest declares which family it uses (sdxl, flux, sd3). The wrapper
takes the user's prompt/dimensions/seed/etc., loads the matching template,
substitutes the values, and submits.

Output modes:
  - "path" (default): the image is written to /data/output/ and the
    response includes the file path. The Safebox plugin then creates a
    Streams/image stream from that file.
  - "base64": the image bytes are returned inline as base64. Convenient
    for HTTP-only clients but larger response payloads.

Notes:
  - Diffusion is slow. Even a fast workflow (FLUX schnell, 4 steps, 1024x1024)
    takes 2-8 seconds on a consumer GPU. SDXL with 25 steps lands around
    10-30 seconds. The wrapper does no streaming — it polls /history and
    returns when the image is ready. WebSocket progress events are post-1.0.
  - One ComfyUI process loads one set of models. For multiple model families
    in one tenant, run multiple containers.
"""

import asyncio
import base64
import copy
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
from typing import Any, Dict, List, Optional, Set

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
import httpx
import uvicorn


# ─── Logging ───────────────────────────────────────────────────────────
logger = logging.getLogger("comfyui-runner")
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")


# ─── Configuration ─────────────────────────────────────────────────────
RUNNER_ID  = os.getenv("RUNNER_ID",  "safebox-image-1")
SERVICE_ID = os.getenv("SERVICE_ID", "image-1")
HMAC_KEY_PATH = os.getenv("HMAC_KEY_PATH", "/etc/safebox/model-api.key")
REQUIRE_HMAC  = os.getenv("SAFEBOX_REQUIRE_HMAC", "false").lower() == "true"

SAFEBOX_SOCKET_PATH = os.getenv("SAFEBOX_SOCKET_PATH",
                                 f"/run/safebox/services/{SERVICE_ID}.sock")
ENABLE_UNIX_SOCKET  = os.getenv("ENABLE_UNIX_SOCKET", "true").lower() == "true"

# ComfyUI server (running internally in the same container)
COMFYUI_HOST = os.getenv("COMFYUI_HOST", "127.0.0.1")
COMFYUI_PORT = int(os.getenv("COMFYUI_PORT", "8188"))
COMFYUI_BASE_URL = f"http://{COMFYUI_HOST}:{COMFYUI_PORT}"

# Model config — clients send this name, the wrapper validates and resolves.
MODEL_NAME       = os.getenv("MODEL_NAME",        "")
WORKFLOW_FAMILY  = os.getenv("WORKFLOW_FAMILY",   "sdxl")  # sdxl | flux | sd3
CHECKPOINT_NAME  = os.getenv("CHECKPOINT_NAME",   "")        # e.g. sd_xl_base_1.0.safetensors
UNET_NAME        = os.getenv("UNET_NAME",         "")        # FLUX uses unet/vae/clip separately
VAE_NAME         = os.getenv("VAE_NAME",          "")
CLIP_NAMES       = os.getenv("CLIP_NAMES",        "")        # comma-separated for FLUX
DEFAULT_STEPS    = int(os.getenv("DEFAULT_STEPS", "25"))
DEFAULT_CFG      = float(os.getenv("DEFAULT_CFG", "7.0"))
DEFAULT_WIDTH    = int(os.getenv("DEFAULT_WIDTH", "1024"))
DEFAULT_HEIGHT   = int(os.getenv("DEFAULT_HEIGHT","1024"))
DEFAULT_SAMPLER  = os.getenv("DEFAULT_SAMPLER",   "euler")
DEFAULT_SCHEDULER= os.getenv("DEFAULT_SCHEDULER", "normal")

MAX_QUEUE_DEPTH    = int(os.getenv("MAX_QUEUE_DEPTH", "4"))
COMFYUI_TIMEOUT_S  = int(os.getenv("COMFYUI_TIMEOUT_S", "300"))
COMFYUI_WARMUP_S   = int(os.getenv("COMFYUI_WARMUP_S",  "180"))
OUTPUT_DIR         = Path(os.getenv("OUTPUT_DIR", "/data/output"))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Capability flags (manifest overrides)
CAP_TEXT2IMG = os.getenv("CAP_TEXT2IMG", "true").lower() == "true"
CAP_IMG2IMG  = os.getenv("CAP_IMG2IMG",  "false").lower() == "true"  # post-1.0
CAP_INPAINT  = os.getenv("CAP_INPAINT",  "false").lower() == "true"  # post-1.0
CAP_CONTROLNET = os.getenv("CAP_CONTROLNET", "false").lower() == "true"  # post-1.0
CAP_LORA     = os.getenv("CAP_LORA",     "false").lower() == "true"  # post-1.0

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
comfyui_ready: bool = False
in_flight:     int  = 0
request_count: int  = 0
total_images:  int  = 0
total_compute_ms: int = 0
seen_nonces = collections.OrderedDict()  # nonce -> timestamp_sec (insertion-ordered)
_workflow_cache: Dict[str, Dict[str, Any]] = {}
_http_client: Optional[httpx.AsyncClient] = None


# ─── Pydantic request model ────────────────────────────────────────────
class ImageGenerateRequest(BaseModel):
    model:          str
    prompt:         str = Field(..., description="Text prompt")
    negativePrompt: Optional[str] = ""
    width:          Optional[int] = None
    height:         Optional[int] = None
    steps:          Optional[int] = None
    guidance:       Optional[float] = Field(None, description="CFG scale (SDXL) or distilled guidance (FLUX)")
    seed:           Optional[int] = None
    batchSize:      Optional[int] = 1
    sampler:        Optional[str] = None
    scheduler:      Optional[str] = None
    outputMode:     Optional[str] = "path"   # "path" or "base64"
    filenamePrefix: Optional[str] = "safebox"


# ─── App ───────────────────────────────────────────────────────────────
app = FastAPI(title="ComfyUI Safebox Runner", version="1.0")


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
    # Match against the bare checkpoint name (without .safetensors)
    if CHECKPOINT_NAME and requested == CHECKPOINT_NAME.rsplit(".", 1)[0]:
        return True
    return False


async def get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(COMFYUI_TIMEOUT_S, connect=10.0))
    return _http_client


# ─── Workflow template handling ────────────────────────────────────────
def load_workflow_template(family: str) -> Dict[str, Any]:
    """Load and cache a workflow template JSON. Templates live at
    /app/workflows/<family>-text2image.json in the container, or in
    ./workflows/ relative to the runner when running locally for tests."""
    if family in _workflow_cache:
        return copy.deepcopy(_workflow_cache[family])
    paths = [
        f"/app/workflows/{family}-text2image.json",
        f"/etc/safebox/runners/comfyui/workflows/{family}-text2image.json",
        os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "workflows", f"{family}-text2image.json"),
    ]
    for p in paths:
        if os.path.exists(p):
            with open(p) as f:
                tpl = json.load(f)
            _workflow_cache[family] = tpl
            return copy.deepcopy(tpl)
    raise FileNotFoundError(f"No workflow template for family={family}")


def populate_sdxl_workflow(tpl: Dict[str, Any], req: ImageGenerateRequest,
                            client_id: str) -> Dict[str, Any]:
    """Substitute user values into the SDXL workflow template.

    Template node IDs (by convention in the shipped templates):
      3  KSampler
      4  CheckpointLoaderSimple
      5  EmptyLatentImage
      6  CLIPTextEncode (positive)
      7  CLIPTextEncode (negative)
      8  VAEDecode
      9  SaveImage
    """
    seed = req.seed if req.seed is not None else int.from_bytes(os.urandom(8), "big")
    tpl["3"]["inputs"].update({
        "seed":          seed,
        "steps":         req.steps    or DEFAULT_STEPS,
        "cfg":           req.guidance or DEFAULT_CFG,
        "sampler_name":  req.sampler   or DEFAULT_SAMPLER,
        "scheduler":     req.scheduler or DEFAULT_SCHEDULER,
        "denoise":       1.0,
    })
    if CHECKPOINT_NAME:
        tpl["4"]["inputs"]["ckpt_name"] = CHECKPOINT_NAME
    tpl["5"]["inputs"].update({
        "width":      req.width      or DEFAULT_WIDTH,
        "height":     req.height     or DEFAULT_HEIGHT,
        "batch_size": req.batchSize  or 1,
    })
    tpl["6"]["inputs"]["text"] = req.prompt
    tpl["7"]["inputs"]["text"] = req.negativePrompt or ""
    tpl["9"]["inputs"]["filename_prefix"] = req.filenamePrefix or "safebox"
    return tpl


def populate_flux_workflow(tpl: Dict[str, Any], req: ImageGenerateRequest,
                            client_id: str) -> Dict[str, Any]:
    """Substitute user values into the FLUX workflow template.

    FLUX workflow uses separate UNET/VAE/dual-CLIP loaders, ModelSamplingFlux,
    FluxGuidance instead of CFG. See workflows/flux-text2image.json for the
    canonical node ID layout.
    """
    seed = req.seed if req.seed is not None else int.from_bytes(os.urandom(8), "big")
    tpl["3"]["inputs"].update({
        "seed":          seed,
        "steps":         req.steps    or DEFAULT_STEPS,
        "cfg":           1.0,  # FLUX uses guidance node, not classical CFG
        "sampler_name":  req.sampler   or DEFAULT_SAMPLER,
        "scheduler":     req.scheduler or DEFAULT_SCHEDULER,
        "denoise":       1.0,
    })
    if UNET_NAME:
        tpl["10"]["inputs"]["unet_name"] = UNET_NAME
    if VAE_NAME:
        tpl["11"]["inputs"]["vae_name"] = VAE_NAME
    if CLIP_NAMES:
        clips = [c.strip() for c in CLIP_NAMES.split(",") if c.strip()]
        if len(clips) >= 2:
            tpl["12"]["inputs"]["clip_name1"] = clips[0]
            tpl["12"]["inputs"]["clip_name2"] = clips[1]
    tpl["5"]["inputs"].update({
        "width":      req.width      or DEFAULT_WIDTH,
        "height":     req.height     or DEFAULT_HEIGHT,
        "batch_size": req.batchSize  or 1,
    })
    tpl["6"]["inputs"]["text"] = req.prompt
    tpl["7"]["inputs"]["text"] = req.negativePrompt or ""
    # FluxGuidance node
    if "13" in tpl and tpl["13"]["class_type"] == "FluxGuidance":
        tpl["13"]["inputs"]["guidance"] = req.guidance or DEFAULT_CFG
    tpl["9"]["inputs"]["filename_prefix"] = req.filenamePrefix or "safebox"
    return tpl


def populate_workflow(family: str, tpl: Dict[str, Any],
                       req: ImageGenerateRequest, client_id: str
                       ) -> Dict[str, Any]:
    if family == "sdxl":
        return populate_sdxl_workflow(tpl, req, client_id)
    if family == "flux":
        return populate_flux_workflow(tpl, req, client_id)
    raise ValueError(f"Unknown workflow family: {family}")


# ─── ComfyUI calls ─────────────────────────────────────────────────────
async def submit_workflow(workflow: Dict[str, Any], client_id: str) -> str:
    """POST the workflow to ComfyUI's /prompt endpoint. Returns prompt_id."""
    client = await get_http_client()
    r = await client.post(f"{COMFYUI_BASE_URL}/prompt",
                           json={"prompt": workflow, "client_id": client_id})
    if r.status_code >= 400:
        raise HTTPException(status_code=502,
                            detail=f"ComfyUI rejected workflow: {r.text}")
    d = r.json()
    pid = d.get("prompt_id")
    if not pid:
        raise HTTPException(status_code=502,
                            detail=f"ComfyUI returned no prompt_id: {d}")
    return pid


async def wait_for_completion(prompt_id: str,
                                deadline_s: float) -> Dict[str, Any]:
    """Poll /history/{prompt_id} until it shows up. Returns the history entry."""
    client = await get_http_client()
    sleep_s = 0.5
    end = time.time() + deadline_s
    while time.time() < end:
        try:
            r = await client.get(f"{COMFYUI_BASE_URL}/history/{prompt_id}",
                                  timeout=10.0)
            if r.status_code == 200:
                d = r.json()
                if prompt_id in d:
                    return d[prompt_id]
        except Exception as e:
            logger.warning(f"history poll error: {e}")
        await asyncio.sleep(sleep_s)
        sleep_s = min(sleep_s * 1.3, 4.0)  # gentle backoff
    raise HTTPException(status_code=504,
                        detail=f"ComfyUI did not finish within {deadline_s}s")


async def fetch_image_bytes(filename: str, subfolder: str, type_: str
                             ) -> bytes:
    """Fetch an output image from ComfyUI's /view endpoint."""
    client = await get_http_client()
    r = await client.get(f"{COMFYUI_BASE_URL}/view",
                          params={"filename": filename,
                                  "subfolder": subfolder,
                                  "type": type_},
                          timeout=30.0)
    if r.status_code != 200:
        raise HTTPException(status_code=502,
                            detail=f"ComfyUI /view failed: {r.status_code}")
    return r.content


def extract_output_images(history_entry: Dict[str, Any]) -> List[Dict[str, str]]:
    """Walk the history entry's outputs and return a list of
    {filename, subfolder, type} dicts for every saved image."""
    out = []
    outputs = history_entry.get("outputs") or {}
    for node_id, node_out in outputs.items():
        for img in (node_out.get("images") or []):
            out.append({
                "filename":  img.get("filename"),
                "subfolder": img.get("subfolder", ""),
                "type":      img.get("type", "output"),
            })
    return out


# ─── Endpoints ─────────────────────────────────────────────────────────

@app.post("/v1/image/generate")
async def v1_image_generate(request: Request):
    global in_flight, request_count, total_images, total_compute_ms

    body_bytes = await request.body()
    if not verify_hmac(request, body_bytes):
        raise HTTPException(status_code=401, detail="HMAC verification failed")

    try:
        req = ImageGenerateRequest(**json.loads(body_bytes))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Bad request: {e}")

    if not model_matches(req.model):
        raise HTTPException(status_code=400,
            detail=f"Model '{req.model}' not loaded. This runner serves '{MODEL_NAME}'.")
    if not CAP_TEXT2IMG:
        raise HTTPException(status_code=400, detail="Text-to-image disabled.")
    if req.outputMode not in (None, "path", "base64"):
        raise HTTPException(status_code=400,
            detail=f"Unknown outputMode: {req.outputMode}")
    if not comfyui_ready:
        raise HTTPException(status_code=503,
            detail="ComfyUI is still loading; retry shortly")

    request_id = request.headers.get("X-Safebox-Request-Id") or str(uuid.uuid4())
    client_id  = uuid.uuid4().hex

    # Load and populate the workflow template
    try:
        tpl = load_workflow_template(WORKFLOW_FAMILY)
        workflow = populate_workflow(WORKFLOW_FAMILY, tpl, req, client_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    in_flight += 1
    t0 = time.time()
    try:
        prompt_id = await submit_workflow(workflow, client_id)
        history   = await wait_for_completion(prompt_id, COMFYUI_TIMEOUT_S)

        # Extract images
        image_descs = extract_output_images(history)
        if not image_descs:
            raise HTTPException(status_code=500,
                detail="ComfyUI returned no images")

        out_images: List[Dict[str, Any]] = []
        all_bytes = b""
        for d in image_descs:
            img_bytes = await fetch_image_bytes(d["filename"],
                                                 d["subfolder"],
                                                 d["type"])
            all_bytes += img_bytes

            entry: Dict[str, Any] = {
                "filename": d["filename"],
                "width":    req.width  or DEFAULT_WIDTH,
                "height":   req.height or DEFAULT_HEIGHT,
                "format":   "png",
            }
            if req.outputMode == "base64":
                entry["base64"] = base64.b64encode(img_bytes).decode("ascii")
            else:
                # Save to /data/output/ for the Safebox plugin to consume
                target = OUTPUT_DIR / d["filename"]
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(img_bytes)
                entry["path"] = str(target)
            out_images.append(entry)

        compute_ms = int((time.time() - t0) * 1000)
        request_count    += 1
        total_images     += len(out_images)
        total_compute_ms += compute_ms

        result = {
            "model":        MODEL_NAME or req.model,
            "images":       out_images,
            "sourceSha256": hashlib.sha256(body_bytes).hexdigest(),
            "outputSha256": hashlib.sha256(all_bytes).hexdigest(),
            "usage": {
                "imageCount": len(out_images),
                "steps":      req.steps or DEFAULT_STEPS,
                "elapsedMs":  compute_ms,
            },
        }
        return JSONResponse(content=result,
                            headers=safebox_headers(request_id,
                                                     MODEL_NAME or req.model,
                                                     compute_ms))
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        logger.error(f"ComfyUI HTTP error: {e}")
        raise HTTPException(status_code=502, detail=f"ComfyUI upstream error: {e}")
    except Exception as e:
        logger.exception("Generation failed")
        raise HTTPException(status_code=500, detail=str(e))
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
        "runnerType": "image",
        "runnerId":   RUNNER_ID,
        "serviceId":  SERVICE_ID,
        "transport":  transport,
        "models": {
            "loaded":      [MODEL_NAME] if (comfyui_ready and MODEL_NAME) else [],
            "loading":     [MODEL_NAME] if (not comfyui_ready and MODEL_NAME) else [],
            "family":      WORKFLOW_FAMILY,
            "checkpoint":  CHECKPOINT_NAME or None,
        },
        "capabilities": {
            "text2img":   CAP_TEXT2IMG,
            "img2img":    CAP_IMG2IMG,
            "inpaint":    CAP_INPAINT,
            "controlnet": CAP_CONTROLNET,
            "lora":       CAP_LORA,
            "batch":      True,
            "outputModes": ["path", "base64"],
        },
        "defaults": {
            "width":     DEFAULT_WIDTH,
            "height":    DEFAULT_HEIGHT,
            "steps":     DEFAULT_STEPS,
            "cfg":       DEFAULT_CFG,
            "sampler":   DEFAULT_SAMPLER,
            "scheduler": DEFAULT_SCHEDULER,
        },
        "health": "healthy" if comfyui_ready else "loading",
    }


@app.get("/v1/capacity")
async def capacity():
    return {
        "canAccept":      comfyui_ready and in_flight < MAX_QUEUE_DEPTH,
        "inFlight":       in_flight,
        "maxQueueDepth":  MAX_QUEUE_DEPTH,
        "capacityHint":   get_capacity_hint(),
        "requestCount":   request_count,
        "totalImages":    total_images,
        "totalComputeMs": total_compute_ms,
    }


@app.get("/v1/models")
async def models():
    return {
        "object": "list",
        "data": [
            {
                "id":       MODEL_NAME,
                "object":   "model",
                "owned_by": "safebox",
                "created":  int(time.time()),
                "family":   WORKFLOW_FAMILY,
                "checkpoint": CHECKPOINT_NAME or None,
            }
        ] if MODEL_NAME else [],
    }


@app.get("/health")
async def health():
    return Response(
        content=json.dumps({
            "status":           "healthy" if comfyui_ready else "loading",
            "comfyuiReady":     comfyui_ready,
            "requestCount":     request_count,
            "inFlight":         in_flight,
            "totalImages":      total_images,
            "totalComputeMs":   total_compute_ms,
        }),
        status_code=200 if comfyui_ready else 503,
        media_type="application/json",
    )


# ─── ComfyUI warmup probe ─────────────────────────────────────────────
async def wait_for_comfyui():
    global comfyui_ready
    deadline = time.time() + COMFYUI_WARMUP_S
    while time.time() < deadline:
        try:
            client = await get_http_client()
            r = await client.get(f"{COMFYUI_BASE_URL}/system_stats",
                                  timeout=5.0)
            if r.status_code == 200:
                comfyui_ready = True
                logger.info("ComfyUI is ready")
                return
        except Exception:
            pass
        await asyncio.sleep(2)
    logger.error(f"ComfyUI did not become ready within {COMFYUI_WARMUP_S}s")


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
    logger.info(f"ComfyUI runner starting — model={MODEL_NAME!r} "
                f"family={WORKFLOW_FAMILY} ckpt={CHECKPOINT_NAME!r}")
    setup_unix_socket()
    asyncio.create_task(wait_for_comfyui())


@app.on_event("shutdown")
async def on_shutdown():
    global _http_client
    if _http_client is not None:
        await _http_client.aclose()
        _http_client = None


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
