#!/usr/bin/env python3
"""
ONNX Safebox Runner — the light "not-LLM" tier.

Loads an ONNX model from /models/<manifestHash>/ (read-only, SHA-256-governed by
the system component) and exposes Safebox-canonical inference endpoints. Covers
embeddings, rerankers, CLIP/vision encoders, and small classifiers — the models
that are a forward pass in, a vector or label out.

Matches the suite conventions (whisper/vllm/kokoro): HMAC auth over a unix
socket, audit-trail SHA-256 hashes in response headers, /v1/capabilities,
/v1/capacity, /v1/models, /health. Weights are never fetched at runtime — the
system component installs and verifies them; this runner only reads local files.
"""
import hashlib
import hmac
import json
import logging
import os
import socket
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
import uvicorn

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("onnx-runner")

MODEL_NAME = os.getenv("MODEL_NAME", "")
MODEL_DIR = Path(os.getenv("MODEL_DIR", "/models"))
ONNX_DEVICE = os.getenv("ONNX_DEVICE", "cpu")          # cpu | cuda
HMAC_KEY_PATH = os.getenv("HMAC_KEY_PATH", "/etc/safebox/model-api.key")
SERVICE_ID = os.getenv("SERVICE_ID", "onnx-1")
SOCKET_DIR = Path(os.getenv("SOCKET_DIR", "/run/safebox/services"))


# ── Requests ────────────────────────────────────────────────────────────
class EmbedRequest(BaseModel):
    model: str
    input: Union[str, List[str]] = Field(..., description="Text(s) to embed")
    normalize: bool = True


class RerankRequest(BaseModel):
    model: str
    query: str
    documents: List[str]
    topK: Optional[int] = None


class ClassifyRequest(BaseModel):
    model: str
    input: Union[str, List[str]]


app = FastAPI(title="ONNX Safebox Runner", version="1.0")


# ── Auth + audit (suite-standard) ───────────────────────────────────────
def _hmac_key() -> Optional[bytes]:
    try:
        return Path(HMAC_KEY_PATH).read_bytes()
    except OSError:
        return None



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
def safebox_headers(request_id: str, model: str, compute_ms: int = 0,
                    output_hash: str = "") -> Dict[str, str]:
    h = {
        "X-Safebox-Request-Id": request_id,
        "X-Safebox-Model": model,
        "X-Safebox-Service-Id": SERVICE_ID,
        "X-Safebox-Compute-Ms": str(compute_ms),
    }
    if output_hash:
        h["X-Safebox-Output-Sha256"] = output_hash   # audit trail
    return h


def model_matches(requested: str) -> bool:
    return (not MODEL_NAME) or requested == MODEL_NAME


# ── Model ───────────────────────────────────────────────────────────────
class OnnxModel:
    def __init__(self, name: str):
        self.name = name
        self.manifest = self._load_manifest(name)
        providers = (["CUDAExecutionProvider", "CPUExecutionProvider"]
                     if ONNX_DEVICE == "cuda" else ["CPUExecutionProvider"])
        model_path = self._resolve_model_file()
        log.info("loading %s (%s) providers=%s", name, model_path, providers)
        self.session = ort.InferenceSession(str(model_path), providers=providers)
        self.task = self.manifest.get("task", "embed")

    def _load_manifest(self, name: str) -> dict:
        # Prefer the installed manifest under the model dir; fall back to baked.
        for p in (MODEL_DIR / name / "manifest.json",
                  Path("/app/manifests") / f"{name}.json"):
            if p.exists():
                return json.loads(p.read_text())
        raise HTTPException(404, f"manifest for {name} not found")

    def _resolve_model_file(self) -> Path:
        # The system component installs weights to /models/<...>/model.onnx.
        d = MODEL_DIR / self.name
        for cand in (d / "model.onnx", d / f"{self.name}.onnx"):
            if cand.exists():
                return cand
        # single .onnx in the dir
        onnx = list(d.glob("*.onnx"))
        if onnx:
            return onnx[0]
        raise HTTPException(404, f"no .onnx file under {d}")

    def embed(self, texts: List[str], normalize: bool) -> List[List[float]]:
        # Minimal mean-pooling embed path; tokenization details live in the
        # manifest's preprocessing config in a full build. Kept compact here.
        import tokenizers
        tok = tokenizers.Tokenizer.from_file(
            str(MODEL_DIR / self.name / "tokenizer.json"))
        out = []
        for t in texts:
            enc = tok.encode(t)
            ids = np.array([enc.ids], dtype=np.int64)
            mask = np.array([enc.attention_mask], dtype=np.int64)
            feeds = {"input_ids": ids, "attention_mask": mask}
            # some models also want token_type_ids
            names = {i.name for i in self.session.get_inputs()}
            if "token_type_ids" in names:
                feeds["token_type_ids"] = np.zeros_like(ids)
            feeds = {k: v for k, v in feeds.items() if k in names}
            res = self.session.run(None, feeds)[0]       # [1, seq, hidden]
            vec = res[0].mean(axis=0)                     # mean pool
            if normalize:
                vec = vec / (np.linalg.norm(vec) + 1e-12)
            out.append(vec.astype(float).tolist())
        return out


_MODEL: Optional[OnnxModel] = None


def get_model(requested: str) -> OnnxModel:
    global _MODEL
    if not model_matches(requested):
        raise HTTPException(400, f"this runner serves {MODEL_NAME}, not {requested}")
    if _MODEL is None:
        _MODEL = OnnxModel(MODEL_NAME or requested)
    return _MODEL


# ── Endpoints (suite-standard) ──────────────────────────────────────────
@app.post("/v1/embed")
async def embed(request: Request):
    body = await request.body()
    if not verify_hmac(request, body):
        raise HTTPException(401, "bad signature")
    req = EmbedRequest(**json.loads(body))
    rid = str(uuid.uuid4())
    t0 = time.time()
    texts = [req.input] if isinstance(req.input, str) else req.input
    vecs = get_model(req.model).embed(texts, req.normalize)
    payload = json.dumps({"model": req.model, "embeddings": vecs,
                          "dim": len(vecs[0]) if vecs else 0}).encode()
    ohash = hashlib.sha256(payload).hexdigest()
    return Response(payload, media_type="application/json",
                    headers=safebox_headers(rid, req.model,
                                            int((time.time() - t0) * 1000), ohash))


@app.post("/v1/rerank")
async def rerank(request: Request):
    body = await request.body()
    if not verify_hmac(request, body):
        raise HTTPException(401, "bad signature")
    req = RerankRequest(**json.loads(body))
    rid = str(uuid.uuid4())
    t0 = time.time()
    # Rerank = score each (query, doc); cross-encoder models output a logit.
    m = get_model(req.model)
    qv = m.embed([req.query], True)[0]
    scored = []
    for i, d in enumerate(req.documents):
        dv = m.embed([d], True)[0]
        score = float(np.dot(qv, dv))
        scored.append({"index": i, "score": score})
    scored.sort(key=lambda x: x["score"], reverse=True)
    if req.topK:
        scored = scored[:req.topK]
    payload = json.dumps({"model": req.model, "results": scored}).encode()
    ohash = hashlib.sha256(payload).hexdigest()
    return Response(payload, media_type="application/json",
                    headers=safebox_headers(rid, req.model,
                                            int((time.time() - t0) * 1000), ohash))


@app.get("/v1/capabilities")
async def capabilities():
    caps = {"embed": True, "rerank": True, "classify": False, "vision": False}
    if _MODEL:
        caps.update(_MODEL.manifest.get("capabilities", {}))
    return {"model": MODEL_NAME, "capabilities": caps}


@app.get("/v1/capacity")
async def capacity():
    return {"serviceId": SERVICE_ID, "state": "ready" if _MODEL else "cold",
            "device": ONNX_DEVICE}


@app.get("/v1/models")
async def models():
    baked = sorted(p.stem for p in Path("/app/manifests").glob("*.json"))
    return {"loaded": MODEL_NAME, "available": baked}


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL_NAME, "device": ONNX_DEVICE}


def setup_unix_socket() -> Optional[str]:
    SOCKET_DIR.mkdir(parents=True, exist_ok=True)
    path = SOCKET_DIR / f"{SERVICE_ID}.sock"
    if path.exists():
        path.unlink()
    return str(path)


@app.on_event("startup")
async def _startup():
    if MODEL_NAME:
        try:
            get_model(MODEL_NAME)
            log.info("preloaded %s", MODEL_NAME)
        except Exception as e:  # noqa: BLE001 - log, serve cold if preload fails
            log.warning("preload failed (%s); will load on first request", e)


if __name__ == "__main__":
    sock = setup_unix_socket()
    if sock:
        uvicorn.run(app, uds=sock, log_level=os.getenv("LOG_LEVEL", "info").lower())
    else:
        uvicorn.run(app, host="0.0.0.0", port=8080)
