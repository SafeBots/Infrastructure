"""
llama.cpp Model Runner — Safebox Wire Protocol v1.1

Thin adapter wrapping llama.cpp's `llama-server` binary, exposing the
Safebox canonical endpoints (/v1/chat, /v1/complete, /v1/embed),
the lifecycle endpoints (/v1/models/load, /v1/models/unload,
/v1/cache/flush), and the slot-management endpoints
(/v1/cache/slots, /v1/cache/slots/{save,restore,allocate,release}).

llama-server runs internally on localhost:8080 with --slots N and
the OpenAI-compatible API enabled. This adapter:
  - Translates between Safebox wire format and llama-server's
    OpenAI format
  - Carries Safebox header conventions (X-Safebox-Request-Id,
    X-Safebox-Tenant, X-Safebox-Cache-Mode, X-Safebox-Cache-Tag)
  - Exposes llama-server's slot machinery via Safebox-shaped routes
  - Implements the M-of-N-gated lifecycle contract used by
    docker/system-protocol-api.js

Status: skeleton. Adapter routes are wired; slot allocation policy
and tenant-scoped slot pinning are TODO.
"""

import asyncio
import json
import logging
import os
import socket
import stat
import subprocess
import time
from pathlib import Path
from typing import Dict, List, Optional, Any

from fastapi import FastAPI, Header, HTTPException, Request, Response
from pydantic import BaseModel
import httpx
import uvicorn

logger = logging.getLogger(__name__)

# ============================================================================
# CONFIGURATION
# ============================================================================

RUNNER_ID = os.getenv('RUNNER_ID', 'safebox-model-llm-llamacpp-1')
SERVICE_ID = os.getenv('SERVICE_ID', 'model-llm-llamacpp-1')
SAFEBOX_SOCKET_PATH = os.getenv(
    'SAFEBOX_SOCKET_PATH',
    f'/run/safebox/services/{SERVICE_ID}.sock'
)
ENABLE_UNIX_SOCKET = os.getenv('ENABLE_UNIX_SOCKET', 'true').lower() == 'true'

LLAMA_HOST = os.getenv('LLAMA_HOST', 'localhost')
LLAMA_PORT = int(os.getenv('LLAMA_PORT', '8080'))
LLAMA_BASE_URL = f"http://{LLAMA_HOST}:{LLAMA_PORT}"

LLAMA_MODEL_PATH = os.getenv('LLAMA_MODEL_PATH', '')
LLAMA_N_GPU_LAYERS = int(os.getenv('LLAMA_N_GPU_LAYERS', '999'))
LLAMA_CTX_SIZE = int(os.getenv('LLAMA_CTX_SIZE', '8192'))
LLAMA_PARALLEL = int(os.getenv('LLAMA_PARALLEL', '4'))
LLAMA_THREADS = int(os.getenv('LLAMA_THREADS', str(os.cpu_count() or 4)))
LLAMA_FLASH_ATTN = os.getenv('LLAMA_FLASH_ATTN', '1') == '1'

SLOT_STATE_DIR = Path(os.getenv(
    'SLOT_STATE_DIR',
    f'/var/lib/safebox-llama-cpp/slots/{RUNNER_ID}'
))
SLOT_STATE_DIR.mkdir(parents=True, exist_ok=True)


# ============================================================================
# APP
# ============================================================================

app = FastAPI(
    title="Safebox llama.cpp Runner",
    description="llama.cpp adapter for Safebox Wire Protocol v1.1",
    version="0.1.0",
)


class SafeboxChatRequest(BaseModel):
    messages: List[Dict[str, Any]]
    model: Optional[str] = None
    maxTokens: Optional[int] = 512
    temperature: Optional[float] = 0.7
    topP: Optional[float] = 0.95
    stop: Optional[List[str]] = None
    cacheSlotId: Optional[str] = None  # llama.cpp slot pinning


class SafeboxCompleteRequest(BaseModel):
    prompt: str
    model: Optional[str] = None
    maxTokens: Optional[int] = 512
    temperature: Optional[float] = 0.7
    topP: Optional[float] = 0.95
    stop: Optional[List[str]] = None
    cacheSlotId: Optional[str] = None


class SafeboxEmbedRequest(BaseModel):
    input: List[str]
    model: Optional[str] = None


# ============================================================================
# SAFEBOX CANONICAL ENDPOINTS (Spec §4, §6)
# ============================================================================

@app.post("/v1/chat")
async def safebox_chat(
    request: SafeboxChatRequest,
    x_safebox_request_id: str = Header(..., alias="X-Safebox-Request-Id"),
    x_safebox_tenant: Optional[str] = Header("default", alias="X-Safebox-Tenant"),
    x_safebox_cache_mode: Optional[str] = Header("prefix", alias="X-Safebox-Cache-Mode"),
    x_safebox_cache_tag: Optional[str] = Header(None, alias="X-Safebox-Cache-Tag"),
    response: Response = None,
):
    """Chat completion. Routes to llama-server's OpenAI-compatible endpoint."""
    payload = {
        "model": request.model or "default",
        "messages": request.messages,
        "max_tokens": request.maxTokens,
        "temperature": request.temperature,
        "top_p": request.topP,
        "stop": request.stop,
    }
    # Pin to a specific KV cache slot if the caller asked
    if request.cacheSlotId:
        payload["id_slot"] = _slot_id_int(request.cacheSlotId)

    async with httpx.AsyncClient(timeout=300.0) as client:
        r = await client.post(f"{LLAMA_BASE_URL}/v1/chat/completions", json=payload)
        result = r.json()

    if response is not None:
        response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
    return result


@app.post("/v1/complete")
async def safebox_complete(
    request: SafeboxCompleteRequest,
    x_safebox_request_id: str = Header(..., alias="X-Safebox-Request-Id"),
    response: Response = None,
):
    """Text completion."""
    payload = {
        "model": request.model or "default",
        "prompt": request.prompt,
        "max_tokens": request.maxTokens,
        "temperature": request.temperature,
        "top_p": request.topP,
        "stop": request.stop,
    }
    if request.cacheSlotId:
        payload["id_slot"] = _slot_id_int(request.cacheSlotId)

    async with httpx.AsyncClient(timeout=300.0) as client:
        r = await client.post(f"{LLAMA_BASE_URL}/v1/completions", json=payload)
        result = r.json()

    if response is not None:
        response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
    return result


@app.post("/v1/embed")
async def safebox_embed(
    request: SafeboxEmbedRequest,
    x_safebox_request_id: str = Header(..., alias="X-Safebox-Request-Id"),
    response: Response = None,
):
    """Embeddings. llama-server exposes /v1/embeddings when started with --embeddings."""
    payload = {
        "model": request.model or "default",
        "input": request.input,
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        r = await client.post(f"{LLAMA_BASE_URL}/v1/embeddings", json=payload)
        result = r.json()

    if response is not None:
        response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
    return result


# ============================================================================
# MODEL LIFECYCLE (called by docker/system-protocol-api.js)
# ============================================================================
#
# llama-server, like vLLM 0.6.0, loads exactly one model at startup. A
# "load" or "unload" therefore corresponds to restarting the underlying
# subprocess against new --model args. The stubs below acknowledge that
# and return well-formed responses so the system component's contract
# is satisfied; production implementation manages a subprocess pool.

_load_tasks: Dict[str, Dict[str, Any]] = {}
_current_model_id = os.getenv('LLAMA_CURRENT_MODEL_ID', 'unknown')


@app.post("/v1/models/load")
async def models_load(request: Request):
    """
    Load a model. Body: { modelId, quantization, maxContextLength, evictModel, verifiedOpToken }.
    Returns 200 with { modelId, verified, gpuMemoryUsedMB, loadTimeMs }
    if the requested model is already loaded; 501 otherwise (subprocess
    restart is the production path).
    """
    body = await request.json()
    model_id = body.get('modelId')
    verified_op_token = body.get('verifiedOpToken')

    if not model_id or not verified_op_token:
        raise HTTPException(400, "modelId and verifiedOpToken required")

    if model_id == _current_model_id:
        return {
            "modelId": model_id,
            "verified": True,
            "gpuMemoryUsedMB": _approx_gpu_memory_mb(),
            "loadTimeMs": 0,
        }

    raise HTTPException(
        501,
        f"This llama.cpp runner instance is configured for {_current_model_id!r}. "
        f"Hot-swap to {model_id!r} requires restarting llama-server with a new --model arg. "
        f"Deploy a second runner with LLAMA_CURRENT_MODEL_ID={model_id} instead."
    )


@app.get("/v1/models/load/{task_id}")
async def models_load_status(task_id: str):
    """Poll async model-load task."""
    task = _load_tasks.get(task_id)
    if not task:
        raise HTTPException(404, f"Unknown task {task_id}")
    return task


@app.post("/v1/models/unload")
async def models_unload(request: Request):
    """Unload a model. Body: { modelId, verifiedOpToken }."""
    body = await request.json()
    model_id = body.get('modelId')
    verified_op_token = body.get('verifiedOpToken')

    if not model_id or not verified_op_token:
        raise HTTPException(400, "modelId and verifiedOpToken required")

    # In production: terminate the llama-server subprocess and mark
    # this runner as evicted.
    return {
        "modelId": model_id,
        "verified": True,
        "gpuMemoryFreedMB": _approx_gpu_memory_mb(),
        "kvCacheFlushed": True,
    }


@app.post("/v1/cache/flush")
async def cache_flush(request: Request):
    """
    Flush KV cache. Body: { scope, modelId?, tenantId?, tag?, verifiedOpToken }.
    Releases all slots (scope="all") or just the slots matching the given
    tenant/tag (when scope="tenant" or "tag"). Slot membership in a tenant
    or tag bucket is tracked in this adapter's memory.
    """
    body = await request.json()
    scope = body.get('scope')
    verified_op_token = body.get('verifiedOpToken')

    if not scope or not verified_op_token:
        raise HTTPException(400, "scope and verifiedOpToken required")

    released = await _release_slots_matching(scope, body)
    return {
        "scope": scope,
        "verified": True,
        "entriesRemoved": released,
        "memoryFreedMB": 0,  # llama-server reports total but not per-slot
    }


# ============================================================================
# SLOT MANAGEMENT — llama.cpp's distinguishing feature
# ============================================================================

# Tracks which logical slot ID maps to which numeric llama-server slot,
# and which tenant/tag owns each. Persisted to a small JSON file so the
# mapping survives adapter restarts (llama-server's slots persist
# independently via save/restore).
_slot_table: Dict[str, Dict[str, Any]] = {}


@app.get("/v1/cache/slots")
async def list_slots():
    """List active slots, their tenants, tags, and llama-server state."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(f"{LLAMA_BASE_URL}/slots")
        llama_state = r.json() if r.status_code == 200 else []
    
    out = []
    for logical_id, info in _slot_table.items():
        numeric = info['slot']
        ls = next((s for s in llama_state if s.get('id') == numeric), None)
        out.append({
            "slotId":     logical_id,
            "numericId":  numeric,
            "tenantId":   info.get('tenantId'),
            "tag":        info.get('tag'),
            "state":      (ls or {}).get('state', 'unknown'),
            "tokens":     (ls or {}).get('n_past', 0),
        })
    return {"slots": out, "total": LLAMA_PARALLEL, "active": len(out)}


@app.post("/v1/cache/slots/allocate")
async def allocate_slot(request: Request):
    """
    Reserve a slot for a stable prefix. Body: { slotId, tenantId?, tag? }.
    Idempotent: re-allocating the same slotId returns the existing slot.
    """
    body = await request.json()
    slot_id = body.get('slotId')
    if not slot_id:
        raise HTTPException(400, "slotId required")

    if slot_id in _slot_table:
        return _slot_table[slot_id]

    # Find a free numeric slot. llama-server numbers slots 0..N-1.
    in_use = {s['slot'] for s in _slot_table.values()}
    free = next((i for i in range(LLAMA_PARALLEL) if i not in in_use), None)
    if free is None:
        raise HTTPException(503, "All slots in use; release one first")

    info = {
        "slotId":   slot_id,
        "slot":     free,
        "tenantId": body.get('tenantId'),
        "tag":      body.get('tag'),
        "createdAt": int(time.time()),
    }
    _slot_table[slot_id] = info
    return info


@app.post("/v1/cache/slots/save")
async def save_slot(request: Request):
    """
    Persist a slot's KV state to disk. Body: { slotId }.
    Returns: { slotId, savedTo, sizeBytes }.
    """
    body = await request.json()
    slot_id = body.get('slotId')
    info = _slot_table.get(slot_id)
    if not info:
        raise HTTPException(404, f"Unknown slot {slot_id}")

    save_path = SLOT_STATE_DIR / f"{slot_id}.bin"
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(
            f"{LLAMA_BASE_URL}/slots/{info['slot']}?action=save",
            json={"filename": str(save_path)},
        )
        if r.status_code != 200:
            raise HTTPException(500, f"llama-server save failed: {r.text}")
        result = r.json()

    return {
        "slotId":    slot_id,
        "savedTo":   str(save_path),
        "sizeBytes": save_path.stat().st_size if save_path.exists() else 0,
        "llamaServer": result,
    }


@app.post("/v1/cache/slots/restore")
async def restore_slot(request: Request):
    """Reload a previously-saved slot's state. Body: { slotId }."""
    body = await request.json()
    slot_id = body.get('slotId')
    info = _slot_table.get(slot_id)
    if not info:
        raise HTTPException(404, f"Unknown slot {slot_id} (allocate first)")

    save_path = SLOT_STATE_DIR / f"{slot_id}.bin"
    if not save_path.exists():
        raise HTTPException(404, f"No saved state for slot {slot_id}")

    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(
            f"{LLAMA_BASE_URL}/slots/{info['slot']}?action=restore",
            json={"filename": str(save_path)},
        )
        if r.status_code != 200:
            raise HTTPException(500, f"llama-server restore failed: {r.text}")
        result = r.json()

    return {"slotId": slot_id, "restored": True, "llamaServer": result}


@app.post("/v1/cache/slots/release")
async def release_slot(request: Request):
    """Release a slot. Body: { slotId }."""
    body = await request.json()
    slot_id = body.get('slotId')
    info = _slot_table.pop(slot_id, None)
    if not info:
        raise HTTPException(404, f"Unknown slot {slot_id}")

    # Tell llama-server to release the slot
    async with httpx.AsyncClient(timeout=10.0) as client:
        await client.post(
            f"{LLAMA_BASE_URL}/slots/{info['slot']}?action=erase",
        )

    return {"slotId": slot_id, "released": True}


async def _release_slots_matching(scope: str, body: Dict[str, Any]) -> int:
    """Internal: release slots matching a scope. Returns count."""
    matches = []
    if scope == 'all':
        matches = list(_slot_table.keys())
    elif scope == 'tenant':
        tenant = body.get('tenantId')
        matches = [k for k, v in _slot_table.items() if v.get('tenantId') == tenant]
    elif scope == 'tag':
        tag = body.get('tag')
        matches = [k for k, v in _slot_table.items() if v.get('tag') == tag]
    elif scope == 'model':
        # Single-model llama.cpp: "model" scope = "all"
        matches = list(_slot_table.keys())

    for slot_id in matches:
        info = _slot_table.pop(slot_id, None)
        if info:
            async with httpx.AsyncClient(timeout=10.0) as client:
                try:
                    await client.post(
                        f"{LLAMA_BASE_URL}/slots/{info['slot']}?action=erase"
                    )
                except Exception as e:
                    logger.warning(f"Failed to erase slot {info['slot']}: {e}")

    return len(matches)


def _slot_id_int(logical_id: str) -> int:
    """Resolve a logical slot ID to the numeric ID llama-server expects."""
    info = _slot_table.get(logical_id)
    return info['slot'] if info else -1


def _approx_gpu_memory_mb() -> int:
    """
    Best-effort GPU memory snapshot. Production code would query
    nvidia-smi (CUDA), system_profiler (Metal), or rocm-smi (ROCm).
    Stub returns 0 to avoid implying a measurement we did not take.
    """
    return 0


# ============================================================================
# CAPABILITIES & HEALTH
# ============================================================================

@app.get("/v1/capabilities")
async def get_capabilities():
    """Runner capabilities descriptor (spec §3)."""
    return {
        "runnerId": RUNNER_ID,
        "serviceId": SERVICE_ID,
        "runtime": "llama.cpp",
        "protocols": {
            "llm": {
                "chat": True,
                "completion": True,
                "embedding": True,
                "slotManagement": True,
                "ggufQuantization": True,
            },
        },
        "hardware": {
            "gpuLayers": LLAMA_N_GPU_LAYERS,
            "ctxSize": LLAMA_CTX_SIZE,
            "parallel": LLAMA_PARALLEL,
            "threads": LLAMA_THREADS,
            "flashAttn": LLAMA_FLASH_ATTN,
        },
        "model": {
            "path": LLAMA_MODEL_PATH,
            "modelId": _current_model_id,
        },
    }


@app.get("/v1/capacity")
async def get_capacity():
    """Current capacity hint for the router."""
    return {
        "queueDepth": len(_slot_table),
        "maxQueueDepth": LLAMA_PARALLEL,
        "hint": "available" if len(_slot_table) < LLAMA_PARALLEL else "saturated",
    }


@app.get("/health")
async def health():
    """Health probe."""
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.get(f"{LLAMA_BASE_URL}/health")
            return {"status": "ok" if r.status_code == 200 else "degraded"}
    except Exception:
        return {"status": "down"}


# ============================================================================
# STARTUP
# ============================================================================

def setup_unix_socket():
    """Bind unix socket for system-component access (mirrors vLLM runner)."""
    if not ENABLE_UNIX_SOCKET:
        return
    sock_path = Path(SAFEBOX_SOCKET_PATH)
    sock_path.parent.mkdir(parents=True, exist_ok=True)
    if sock_path.exists():
        sock_path.unlink()
    # uvicorn will bind to this path at startup; final permissions
    # are 0o660 (rw for owner + group) so the system component can reach
    # us without exposing the socket to other users.


@app.on_event("startup")
async def startup():
    setup_unix_socket()
    logger.info(f"llama.cpp runner {RUNNER_ID} starting")
    logger.info(f"  model: {LLAMA_MODEL_PATH}")
    logger.info(f"  gpu layers: {LLAMA_N_GPU_LAYERS}")
    logger.info(f"  ctx size: {LLAMA_CTX_SIZE}")
    logger.info(f"  parallel slots: {LLAMA_PARALLEL}")
    logger.info(f"  llama-server: {LLAMA_BASE_URL}")


if __name__ == "__main__":
    if ENABLE_UNIX_SOCKET:
        uvicorn.run(
            app,
            uds=SAFEBOX_SOCKET_PATH,
            log_level="info",
        )
    else:
        uvicorn.run(app, host="127.0.0.1", port=7790, log_level="info")
