"""
TripoSR Runner — Safebox Local Service v1.0

Wraps TripoSR (Stability AI + Tripo AI, MIT license) as a Safebox-canonical
image-to-3D-mesh service. Takes a single image, returns a 3D mesh in GLB,
OBJ, or PLY format. Single process, lazy import.

Endpoints (Safebox canonical):
    POST /v1/3d/generate       — image → 3D mesh
    GET  /v1/capabilities
    GET  /v1/capacity
    GET  /v1/models
    GET  /health

Inference is fast — typically under 1 second on a consumer GPU after a
60-second cold start. MAX_QUEUE_DEPTH=4 (much higher than the video runner).

Outputs:
  - GLB (default — single-file, textured, ready for web/AR/game engines)
  - OBJ (geometry only, mesh + materials in sibling MTL)
  - PLY (point cloud or mesh, useful for further processing)
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
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
import uvicorn


# ─── Logging ───────────────────────────────────────────────────────────
logger = logging.getLogger("triposr-runner")
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")


# ─── Configuration ─────────────────────────────────────────────────────
RUNNER_ID  = os.getenv("RUNNER_ID",  "safebox-triposr-1")
SERVICE_ID = os.getenv("SERVICE_ID", "3d-1")
HMAC_KEY_PATH = os.getenv("HMAC_KEY_PATH", "/etc/safebox/model-api.key")
REQUIRE_HMAC  = os.getenv("SAFEBOX_REQUIRE_HMAC", "false").lower() == "true"

SAFEBOX_SOCKET_PATH = os.getenv("SAFEBOX_SOCKET_PATH",
                                 f"/run/safebox/services/{SERVICE_ID}.sock")
ENABLE_UNIX_SOCKET  = os.getenv("ENABLE_UNIX_SOCKET", "true").lower() == "true"

MODEL_NAME            = os.getenv("MODEL_NAME",        "triposr")
TRIPOSR_MODEL_PATH    = os.getenv("TRIPOSR_MODEL_PATH","stabilityai/TripoSR")
DEFAULT_FOREGROUND_RATIO = float(os.getenv("DEFAULT_FOREGROUND_RATIO", "0.85"))
DEFAULT_MESH_RESOLUTION  = int(os.getenv("DEFAULT_MESH_RESOLUTION", "256"))
DEFAULT_FORMAT           = os.getenv("DEFAULT_FORMAT", "glb")
DEFAULT_REMOVE_BG        = os.getenv("DEFAULT_REMOVE_BG", "true").lower() == "true"

MAX_QUEUE_DEPTH = int(os.getenv("MAX_QUEUE_DEPTH", "4"))
WORK_DIR = Path(os.getenv("TRIPOSR_WORK_DIR", "/data/output"))
WORK_DIR.mkdir(parents=True, exist_ok=True)

CAP_IMAGE2MESH = os.getenv("CAP_IMAGE2MESH", "true").lower() == "true"
CAP_TEXT2MESH  = False  # TripoSR is image-only; text→3D needs a different runner
CAP_PBR_TEXTURES = False  # TripoSR produces vertex colors, not PBR
CAP_STREAMING  = False

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
total_meshes_generated: int = 0
total_compute_ms: int = 0
seen_nonces = collections.OrderedDict()  # nonce -> timestamp_sec (insertion-ordered)
# ─── Pydantic request model ────────────────────────────────────────────
class MeshGenerateRequest(BaseModel):
    model:             str
    inputImage:        str = Field(..., description="Path or data: URL to input image")
    foregroundRatio:   Optional[float] = None
    meshResolution:    Optional[int]   = None
    removeBackground:  Optional[bool]  = None
    format:            Optional[str]   = None      # glb | obj | ply
    outputMode:        Optional[str]   = "path"
    filenamePrefix:    Optional[str]   = "safebox-mesh"


# ─── App ───────────────────────────────────────────────────────────────
app = FastAPI(title="TripoSR Safebox Runner", version="1.0")


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
    if requested == TRIPOSR_MODEL_PATH:
        return True
    if "/" in TRIPOSR_MODEL_PATH and requested == TRIPOSR_MODEL_PATH.rsplit("/", 1)[-1]:
        return True
    return False


def resolve_input_image(input_image: str) -> bytes:
    """Accept a /data/input/foo.png path or a data: URL base64. Returns
    image bytes."""
    if not input_image:
        raise ValueError("inputImage is required")
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


# ─── TripoSR wrapper ───────────────────────────────────────────────────
class TriposrRunner:
    def __init__(self):
        self.ready  = False
        self.model  = None
        self.device = "cpu"

    def load(self):
        if self.ready:
            return
        try:
            import torch
            from tsr.system import TSR  # type: ignore
            from tsr.utils import remove_background as _rmbg, resize_foreground as _rsfg  # type: ignore
        except Exception as e:
            logger.error(f"Failed to import tsr / torch: {e}")
            raise
        logger.info(f"Loading TripoSR from {TRIPOSR_MODEL_PATH}")
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = TSR.from_pretrained(
            TRIPOSR_MODEL_PATH,
            config_name="config.yaml",
            weight_name="model.ckpt",
        )
        self.model.renderer.set_chunk_size(8192)
        self.model.to(self.device)
        # Stash the bg-removal helpers (lazy import so they're already loaded)
        self._remove_background = _rmbg
        self._resize_foreground = _rsfg
        self.ready = True
        logger.info(f"TripoSR ready — device={self.device}")

    def generate(self, req: MeshGenerateRequest) -> Dict[str, Any]:
        self.load()
        import torch
        from PIL import Image
        try:
            import rembg
        except ImportError:
            rembg = None

        fg_ratio   = req.foregroundRatio if req.foregroundRatio is not None else DEFAULT_FOREGROUND_RATIO
        resolution = req.meshResolution  if req.meshResolution  is not None else DEFAULT_MESH_RESOLUTION
        fmt        = (req.format or DEFAULT_FORMAT).lower()
        remove_bg  = req.removeBackground if req.removeBackground is not None else DEFAULT_REMOVE_BG
        if fmt not in ("glb", "obj", "ply"):
            raise ValueError(f"format must be glb, obj, or ply (got {fmt!r})")

        t0 = time.time()
        img_bytes = resolve_input_image(req.inputImage)
        image = Image.open(io.BytesIO(img_bytes))

        source_sha = hashlib.sha256(
            json.dumps({
                "imageSha": hashlib.sha256(img_bytes).hexdigest(),
                "fgRatio": fg_ratio, "resolution": resolution,
                "removeBg": remove_bg, "format": fmt,
            }, sort_keys=True).encode("utf-8")
        ).hexdigest()

        # Preprocess: optional background removal, foreground sizing
        if remove_bg and rembg is not None:
            session = rembg.new_session()
            image = self._remove_background(image, session)
        if image.mode != "RGBA":
            image = image.convert("RGBA")
        image = self._resize_foreground(image, fg_ratio)
        # Composite onto a neutral gray background (TripoSR convention)
        if image.mode == "RGBA":
            import numpy as np
            arr = (np.asarray(image).astype("float32") / 255.0)
            alpha = arr[:, :, 3:4]
            rgb   = arr[:, :, :3] * alpha + (1 - alpha) * 0.5
            image = Image.fromarray((rgb * 255).clip(0, 255).astype("uint8"))

        with torch.no_grad():
            scene_codes = self.model([image], device=self.device)
            mesh_obj = self.model.extract_mesh(scene_codes, has_vertex_color=True,
                                                resolution=resolution)[0]

        # Export
        stem    = (req.filenamePrefix or "safebox-mesh") + "-" + uuid.uuid4().hex[:12]
        out_path = WORK_DIR / f"{stem}.{fmt}"
        # trimesh handles all three formats
        mesh_obj.export(str(out_path))

        elapsed_ms = int((time.time() - t0) * 1000)
        size_bytes = out_path.stat().st_size
        output_sha = hashlib.sha256(out_path.read_bytes()).hexdigest()

        result: Dict[str, Any] = {
            "model": MODEL_NAME,
            "mesh": {
                "format":    fmt,
                "vertices":  int(getattr(mesh_obj.vertices, "shape", [0])[0]) if hasattr(mesh_obj, "vertices") else None,
                "faces":     int(getattr(mesh_obj.faces, "shape", [0])[0])     if hasattr(mesh_obj, "faces")    else None,
                "sizeBytes": size_bytes,
                "hasVertexColors": True,
            },
            "sourceSha256": source_sha,
            "outputSha256": output_sha,
            "usage": {
                "meshResolution":  resolution,
                "foregroundRatio": fg_ratio,
                "removedBackground": remove_bg and rembg is not None,
                "elapsedMs":       elapsed_ms,
            },
        }
        if req.outputMode == "base64":
            result["mesh"]["base64"] = base64.b64encode(out_path.read_bytes()).decode("ascii")
        else:
            result["mesh"]["path"] = str(out_path)
        return result


mesh_runner = TriposrRunner()


# ─── Endpoints ─────────────────────────────────────────────────────────

@app.post("/v1/3d/generate")
async def v1_3d_generate(request: Request):
    global in_flight, request_count, total_meshes_generated, total_compute_ms

    body_bytes = await request.body()
    if not verify_hmac(request, body_bytes):
        raise HTTPException(status_code=401, detail="HMAC verification failed")
    try:
        req = MeshGenerateRequest(**json.loads(body_bytes))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Bad request: {e}")

    if not model_matches(req.model):
        raise HTTPException(status_code=400,
            detail=f"Model '{req.model}' not loaded. This runner serves '{MODEL_NAME}'.")
    if not CAP_IMAGE2MESH:
        raise HTTPException(status_code=400, detail="Image-to-mesh disabled.")
    if req.outputMode not in (None, "path", "base64"):
        raise HTTPException(status_code=400, detail=f"Unknown outputMode: {req.outputMode}")
    if not mesh_runner.ready:
        raise HTTPException(status_code=503,
            detail="Model is still loading; retry shortly")

    request_id = request.headers.get("X-Safebox-Request-Id") or str(uuid.uuid4())

    in_flight += 1
    t0 = time.time()
    try:
        result = await asyncio.to_thread(mesh_runner.generate, req)
        request_count          += 1
        total_meshes_generated += 1
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
        "runnerType": "3d-generation",
        "runnerId":   RUNNER_ID,
        "serviceId":  SERVICE_ID,
        "transport":  transport,
        "models": {
            "loaded":     [MODEL_NAME] if (mesh_runner.ready and MODEL_NAME) else [],
            "loading":    [MODEL_NAME] if (not mesh_runner.ready and MODEL_NAME) else [],
            "underlying": TRIPOSR_MODEL_PATH,
        },
        "capabilities": {
            "image2mesh":   CAP_IMAGE2MESH,
            "text2mesh":    CAP_TEXT2MESH,
            "pbrTextures":  CAP_PBR_TEXTURES,
            "vertexColors": True,
            "streaming":    CAP_STREAMING,
            "outputFormats":["glb", "obj", "ply"],
            "outputModes":  ["path", "base64"],
        },
        "defaults": {
            "foregroundRatio":  DEFAULT_FOREGROUND_RATIO,
            "meshResolution":   DEFAULT_MESH_RESOLUTION,
            "removeBackground": DEFAULT_REMOVE_BG,
            "format":           DEFAULT_FORMAT,
        },
        "health": "healthy" if mesh_runner.ready else "loading",
    }


@app.get("/v1/capacity")
async def capacity():
    return {
        "canAccept":         mesh_runner.ready and in_flight < MAX_QUEUE_DEPTH,
        "inFlight":          in_flight,
        "maxQueueDepth":     MAX_QUEUE_DEPTH,
        "capacityHint":      get_capacity_hint(),
        "requestCount":      request_count,
        "totalMeshes":       total_meshes_generated,
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
                "underlying": TRIPOSR_MODEL_PATH,
            }
        ] if MODEL_NAME else [],
    }


@app.get("/health")
async def health():
    return Response(
        content=json.dumps({
            "status":      "healthy" if mesh_runner.ready else "loading",
            "modelReady":  mesh_runner.ready,
            "requestCount": request_count,
            "inFlight":    in_flight,
            "totalMeshes": total_meshes_generated,
        }),
        status_code=200 if mesh_runner.ready else 503,
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
    logger.info(f"TripoSR runner starting — model={MODEL_NAME!r}")
    setup_unix_socket()
    asyncio.get_event_loop().run_in_executor(None, mesh_runner.load)


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
