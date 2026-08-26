"""
vLLM Runner — Safebox Local Service v1.2

Thin Safebox-protocol adapter that wraps vLLM's OpenAI-compatible server,
turning it into a Safebox-canonical LLM runner.

Architecture (single container, two processes via supervisord):

    ┌─ container ─────────────────────────────────────────────┐
    │                                                         │
    │  vLLM (HF model loaded into GPU)                        │
    │      listens on 127.0.0.1:8000  (OpenAI HTTP)           │
    │         ▲                                               │
    │         │ POST /v1/chat/completions etc.                │
    │         │                                               │
    │  runner.py  (this file)                                 │
    │      listens on Unix socket  /run/safebox/services/…    │
    │      translates Safebox protocol ↔ OpenAI               │
    │      handles HMAC, streaming SSE, audit-trail SHA-256   │
    │                                                         │
    └─────────────────────────────────────────────────────────┘

Endpoints (Safebox canonical, camelCase, flat):

    POST /v1/chat              — chat completion (supports streaming)
    POST /v1/complete          — text completion (supports streaming)
    POST /v1/embed             — embeddings
    GET  /v1/capabilities      — runner introspection
    GET  /v1/capacity          — current load
    GET  /v1/models            — what's loaded
    GET  /health               — liveness probe

Transport: Unix domain socket at /run/safebox/services/{SERVICE_ID}.sock
           Permissions 0660, group safebox-services.

Auth: HMAC-SHA256 of (timestamp.nonce.body) signed with the per-Safebox key,
      gated on SAFEBOX_REQUIRE_HMAC=true. Off by default for local development.
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
from typing import Any, Dict, List, Optional, Set, Union

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse, Response
from pydantic import BaseModel, Field
import httpx
import uvicorn


# ─── Logging ───────────────────────────────────────────────────────────
logger = logging.getLogger("vllm-runner")
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")


# ─── Configuration ─────────────────────────────────────────────────────
RUNNER_ID    = os.getenv("RUNNER_ID",    "safebox-llm-1")
SERVICE_ID   = os.getenv("SERVICE_ID",   "llm-1")
HMAC_KEY_PATH = os.getenv("HMAC_KEY_PATH", "/etc/safebox/model-api.key")
REQUIRE_HMAC  = os.getenv("SAFEBOX_REQUIRE_HMAC", "false").lower() == "true"

SAFEBOX_SOCKET_PATH = os.getenv("SAFEBOX_SOCKET_PATH",
                                 f"/run/safebox/services/{SERVICE_ID}.sock")
ENABLE_UNIX_SOCKET  = os.getenv("ENABLE_UNIX_SOCKET", "true").lower() == "true"

VLLM_HOST = os.getenv("VLLM_HOST", "127.0.0.1")
VLLM_PORT = int(os.getenv("VLLM_PORT", "8000"))
VLLM_BASE_URL = f"http://{VLLM_HOST}:{VLLM_PORT}"

# The model name the wrapper expects clients to send. The vLLM process is
# launched separately (by start.sh, from a manifest) with one model loaded.
# If clients send a different model name the wrapper rejects the request
# rather than silently mis-routing.
MODEL_NAME      = os.getenv("MODEL_NAME",      "")        # canonical Safebox name
VLLM_MODEL_ARG  = os.getenv("VLLM_MODEL_ARG",  "")        # what vLLM was started with
MAX_QUEUE_DEPTH = int(os.getenv("MAX_QUEUE_DEPTH", "16"))

# How long to wait at startup for vLLM to come up. vLLM can take a long time
# to load weights on big models. Default: 5 minutes.
VLLM_WARMUP_TIMEOUT_S = int(os.getenv("VLLM_WARMUP_TIMEOUT_S", "300"))

# Capability flags (manifest can override via env)
CAP_CHAT       = os.getenv("CAP_CHAT",       "true").lower() == "true"
CAP_COMPLETE   = os.getenv("CAP_COMPLETE",   "true").lower() == "true"
CAP_EMBED      = os.getenv("CAP_EMBED",      "false").lower() == "true"
CAP_TOOL_USE   = os.getenv("CAP_TOOL_USE",   "false").lower() == "true"
CAP_VISION     = os.getenv("CAP_VISION",     "false").lower() == "true"
CAP_STREAMING  = True   # we always support streaming if vLLM does

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
vllm_ready: bool = False
in_flight: int   = 0
request_count: int = 0
total_prompt_tokens: int = 0
total_completion_tokens: int = 0
seen_nonces = collections.OrderedDict()  # nonce -> timestamp_sec (insertion-ordered)

# Single shared HTTP client to vLLM for connection reuse
_http_client: Optional[httpx.AsyncClient] = None


# ─── Pydantic request models (Safebox canonical, camelCase) ────────────

class ChatMessage(BaseModel):
    role: str
    content: Union[str, List[Dict[str, Any]]]  # plain text or content blocks (for vision)

class ChatRequest(BaseModel):
    model: str
    messages: List[ChatMessage]
    maxTokens:      Optional[int]   = 2048
    temperature:    Optional[float] = 0.7
    topP:           Optional[float] = None
    topK:           Optional[int]   = None
    stop:           Optional[Union[str, List[str]]] = None
    stream:         Optional[bool]  = False
    seed:           Optional[int]   = None
    presencePenalty:  Optional[float] = None
    frequencyPenalty: Optional[float] = None
    tools:          Optional[List[Dict[str, Any]]] = None
    toolChoice:     Optional[Union[str, Dict[str, Any]]] = None
    responseFormat: Optional[Dict[str, Any]] = None
    user:           Optional[str]   = None

class CompleteRequest(BaseModel):
    model: str
    prompt: Union[str, List[str]]
    maxTokens:    Optional[int]   = 2048
    temperature:  Optional[float] = 0.7
    topP:         Optional[float] = None
    topK:         Optional[int]   = None
    stop:         Optional[Union[str, List[str]]] = None
    stream:       Optional[bool]  = False
    seed:         Optional[int]   = None
    n:            Optional[int]   = 1

class EmbedRequest(BaseModel):
    model: str
    input: Union[str, List[str]]
    encodingFormat: Optional[str] = "float"


# ─── App ───────────────────────────────────────────────────────────────
app = FastAPI(title="vLLM Safebox Runner", version="1.2")


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
    """Accept either the canonical Safebox name or the vLLM model arg.
    Clients that don't know which is which can use either."""
    if not requested:
        return False
    if MODEL_NAME and requested == MODEL_NAME:
        return True
    if VLLM_MODEL_ARG and requested == VLLM_MODEL_ARG:
        return True
    # Allow short-name match against the basename of the vLLM arg too
    if VLLM_MODEL_ARG and "/" in VLLM_MODEL_ARG:
        if requested == VLLM_MODEL_ARG.rsplit("/", 1)[-1]:
            return True
    return False

async def get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0))
    return _http_client


# ─── Translation: Safebox → vLLM (OpenAI shape) ────────────────────────
def _camel_to_openai_chat(req: ChatRequest) -> Dict[str, Any]:
    """Translate camelCase Safebox chat request to snake_case OpenAI."""
    out: Dict[str, Any] = {
        "model":       VLLM_MODEL_ARG or req.model,
        "messages":    [m.model_dump() for m in req.messages],
        "max_tokens":  req.maxTokens,
        "temperature": req.temperature,
        "stream":      bool(req.stream),
    }
    if req.topP             is not None: out["top_p"]              = req.topP
    if req.topK             is not None: out["top_k"]              = req.topK
    if req.stop             is not None: out["stop"]               = req.stop
    if req.seed             is not None: out["seed"]               = req.seed
    if req.presencePenalty  is not None: out["presence_penalty"]   = req.presencePenalty
    if req.frequencyPenalty is not None: out["frequency_penalty"]  = req.frequencyPenalty
    if req.tools            is not None: out["tools"]              = req.tools
    if req.toolChoice       is not None: out["tool_choice"]        = req.toolChoice
    if req.responseFormat   is not None: out["response_format"]    = req.responseFormat
    if req.user             is not None: out["user"]               = req.user
    return out

def _camel_to_openai_complete(req: CompleteRequest) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "model":       VLLM_MODEL_ARG or req.model,
        "prompt":      req.prompt,
        "max_tokens":  req.maxTokens,
        "temperature": req.temperature,
        "stream":      bool(req.stream),
        "n":           req.n,
    }
    if req.topP   is not None: out["top_p"] = req.topP
    if req.topK   is not None: out["top_k"] = req.topK
    if req.stop   is not None: out["stop"]  = req.stop
    if req.seed   is not None: out["seed"]  = req.seed
    return out


# ─── Translation: vLLM (OpenAI) → Safebox (camelCase) ──────────────────
def _vllm_chat_to_safebox(d: Dict[str, Any], model_name: str) -> Dict[str, Any]:
    choice = (d.get("choices") or [{}])[0]
    msg    = choice.get("message", {}) or {}
    usage  = d.get("usage", {}) or {}
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0) or 0
    out: Dict[str, Any] = {
        "model":        model_name,
        "content":      msg.get("content", ""),
        "role":         msg.get("role", "assistant"),
        "finishReason": choice.get("finish_reason"),
        "usage": {
            "promptTokens":     usage.get("prompt_tokens", 0),
            "completionTokens": usage.get("completion_tokens", 0),
            "totalTokens":      usage.get("total_tokens", 0),
            "cachedTokens":     cached,
        },
    }
    if msg.get("tool_calls"):
        out["toolCalls"] = msg["tool_calls"]
    return out

def _vllm_complete_to_safebox(d: Dict[str, Any], model_name: str) -> Dict[str, Any]:
    choices = d.get("choices") or [{}]
    usage   = d.get("usage", {}) or {}
    return {
        "model":        model_name,
        "text":         choices[0].get("text", "") if choices else "",
        "finishReason": choices[0].get("finish_reason"),
        "choices":      [{"text": c.get("text", ""),
                          "finishReason": c.get("finish_reason")}
                         for c in choices],
        "usage": {
            "promptTokens":     usage.get("prompt_tokens", 0),
            "completionTokens": usage.get("completion_tokens", 0),
            "totalTokens":      usage.get("total_tokens", 0),
        },
    }


# ─── Streaming SSE translation ─────────────────────────────────────────
async def _stream_chat_sse(openai_req: Dict[str, Any],
                           request_id: str,
                           model_name: str):
    """Translate vLLM's OpenAI-format SSE stream into Safebox-canonical SSE.

    Each upstream chunk arrives as:
        data: {"choices":[{"delta":{"content":"foo"}, ...}], ...}
        data: [DONE]
    We re-emit camelCase chunks:
        data: {"deltaContent":"foo","finishReason":null, ...}
        data: [DONE]
    """
    client = await get_http_client()
    accumulated_text  = []
    prompt_tokens = completion_tokens = 0
    async with client.stream("POST", f"{VLLM_BASE_URL}/v1/chat/completions",
                              json=openai_req) as up:
        async for line in up.aiter_lines():
            if not line:
                continue
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                yield "data: [DONE]\n\n"
                break
            try:
                d = json.loads(payload)
            except json.JSONDecodeError:
                continue
            choice = (d.get("choices") or [{}])[0]
            delta  = choice.get("delta", {}) or {}
            chunk: Dict[str, Any] = {
                "model":        model_name,
                "deltaContent": delta.get("content", "") or "",
                "deltaRole":    delta.get("role"),
                "finishReason": choice.get("finish_reason"),
            }
            if delta.get("tool_calls"):
                chunk["deltaToolCalls"] = delta["tool_calls"]
            if d.get("usage"):
                u = d["usage"]
                prompt_tokens     = u.get("prompt_tokens", prompt_tokens)
                completion_tokens = u.get("completion_tokens", completion_tokens)
                chunk["usage"] = {
                    "promptTokens":     prompt_tokens,
                    "completionTokens": completion_tokens,
                    "totalTokens":      u.get("total_tokens", 0),
                }
            if chunk["deltaContent"]:
                accumulated_text.append(chunk["deltaContent"])
            yield f"data: {json.dumps(chunk)}\n\n"
    # Update global usage counters at end of stream
    global total_prompt_tokens, total_completion_tokens
    total_prompt_tokens     += prompt_tokens
    total_completion_tokens += completion_tokens


async def _stream_complete_sse(openai_req: Dict[str, Any],
                               request_id: str,
                               model_name: str):
    client = await get_http_client()
    prompt_tokens = completion_tokens = 0
    async with client.stream("POST", f"{VLLM_BASE_URL}/v1/completions",
                              json=openai_req) as up:
        async for line in up.aiter_lines():
            if not line or not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                yield "data: [DONE]\n\n"
                break
            try:
                d = json.loads(payload)
            except json.JSONDecodeError:
                continue
            ch = (d.get("choices") or [{}])[0]
            chunk = {
                "model":        model_name,
                "deltaText":    ch.get("text", "") or "",
                "finishReason": ch.get("finish_reason"),
            }
            if d.get("usage"):
                u = d["usage"]
                prompt_tokens     = u.get("prompt_tokens", prompt_tokens)
                completion_tokens = u.get("completion_tokens", completion_tokens)
                chunk["usage"] = {
                    "promptTokens":     prompt_tokens,
                    "completionTokens": completion_tokens,
                    "totalTokens":      u.get("total_tokens", 0),
                }
            yield f"data: {json.dumps(chunk)}\n\n"
    global total_prompt_tokens, total_completion_tokens
    total_prompt_tokens     += prompt_tokens
    total_completion_tokens += completion_tokens


# ─── Endpoints ─────────────────────────────────────────────────────────

@app.post("/v1/chat")
async def v1_chat(request: Request):
    global in_flight, request_count, total_prompt_tokens, total_completion_tokens

    body_bytes = await request.body()
    if not verify_hmac(request, body_bytes):
        raise HTTPException(status_code=401, detail="HMAC verification failed")

    try:
        req = ChatRequest(**json.loads(body_bytes))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Bad request: {e}")

    if not model_matches(req.model):
        raise HTTPException(
            status_code=400,
            detail=f"Model '{req.model}' not loaded in this runner. "
                   f"This runner serves '{MODEL_NAME or VLLM_MODEL_ARG}'."
        )
    if not vllm_ready:
        raise HTTPException(status_code=503, detail="vLLM is still loading; retry shortly")
    if not CAP_CHAT:
        raise HTTPException(status_code=400, detail="Chat capability disabled on this runner")

    request_id = request.headers.get("X-Safebox-Request-Id") or str(uuid.uuid4())
    openai_req = _camel_to_openai_chat(req)

    in_flight += 1
    t0 = time.time()
    try:
        # Streaming path: return SSE with the upstream stream re-translated.
        if req.stream:
            request_count += 1
            return StreamingResponse(
                _stream_chat_sse(openai_req, request_id, MODEL_NAME or req.model),
                media_type="text/event-stream",
                headers=safebox_headers(request_id, MODEL_NAME or req.model),
            )

        # Non-streaming path: collect, translate, return JSON.
        client = await get_http_client()
        r = await client.post(f"{VLLM_BASE_URL}/v1/chat/completions",
                               json=openai_req)
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=r.text)
        d = r.json()
        out = _vllm_chat_to_safebox(d, MODEL_NAME or req.model)
        # Audit trail: hash the request body and the output content
        out["sourceSha256"] = hashlib.sha256(body_bytes).hexdigest()
        out["outputSha256"] = hashlib.sha256(
            out["content"].encode("utf-8") if isinstance(out["content"], str) else b""
        ).hexdigest()
        request_count += 1
        total_prompt_tokens     += out["usage"]["promptTokens"]
        total_completion_tokens += out["usage"]["completionTokens"]
        compute_ms = int((time.time() - t0) * 1000)
        return JSONResponse(content=out,
                            headers=safebox_headers(request_id,
                                                    MODEL_NAME or req.model,
                                                    compute_ms))
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        logger.error(f"vLLM HTTP error: {e}")
        raise HTTPException(status_code=502, detail=f"vLLM upstream error: {e}")
    except Exception as e:
        logger.exception("Chat failed")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        in_flight -= 1


@app.post("/v1/complete")
async def v1_complete(request: Request):
    global in_flight, request_count, total_prompt_tokens, total_completion_tokens

    body_bytes = await request.body()
    if not verify_hmac(request, body_bytes):
        raise HTTPException(status_code=401, detail="HMAC verification failed")

    try:
        req = CompleteRequest(**json.loads(body_bytes))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Bad request: {e}")

    if not model_matches(req.model):
        raise HTTPException(
            status_code=400,
            detail=f"Model '{req.model}' not loaded in this runner."
        )
    if not vllm_ready:
        raise HTTPException(status_code=503, detail="vLLM is still loading")
    if not CAP_COMPLETE:
        raise HTTPException(status_code=400, detail="Completion capability disabled")

    request_id = request.headers.get("X-Safebox-Request-Id") or str(uuid.uuid4())
    openai_req = _camel_to_openai_complete(req)

    in_flight += 1
    t0 = time.time()
    try:
        if req.stream:
            request_count += 1
            return StreamingResponse(
                _stream_complete_sse(openai_req, request_id, MODEL_NAME or req.model),
                media_type="text/event-stream",
                headers=safebox_headers(request_id, MODEL_NAME or req.model),
            )

        client = await get_http_client()
        r = await client.post(f"{VLLM_BASE_URL}/v1/completions",
                               json=openai_req)
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=r.text)
        d = r.json()
        out = _vllm_complete_to_safebox(d, MODEL_NAME or req.model)
        out["sourceSha256"] = hashlib.sha256(body_bytes).hexdigest()
        out["outputSha256"] = hashlib.sha256(out["text"].encode("utf-8")).hexdigest()
        request_count += 1
        total_prompt_tokens     += out["usage"]["promptTokens"]
        total_completion_tokens += out["usage"]["completionTokens"]
        compute_ms = int((time.time() - t0) * 1000)
        return JSONResponse(content=out,
                            headers=safebox_headers(request_id,
                                                    MODEL_NAME or req.model,
                                                    compute_ms))
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"vLLM upstream error: {e}")
    except Exception as e:
        logger.exception("Complete failed")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        in_flight -= 1


@app.post("/v1/embed")
async def v1_embed(request: Request):
    global in_flight, request_count

    body_bytes = await request.body()
    if not verify_hmac(request, body_bytes):
        raise HTTPException(status_code=401, detail="HMAC verification failed")

    try:
        req = EmbedRequest(**json.loads(body_bytes))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Bad request: {e}")

    if not model_matches(req.model):
        raise HTTPException(status_code=400,
            detail=f"Model '{req.model}' not loaded in this runner.")
    if not vllm_ready:
        raise HTTPException(status_code=503, detail="vLLM is still loading")
    if not CAP_EMBED:
        raise HTTPException(status_code=400,
            detail="Embed capability disabled on this runner")

    request_id = request.headers.get("X-Safebox-Request-Id") or str(uuid.uuid4())
    openai_req = {
        "model": VLLM_MODEL_ARG or req.model,
        "input": req.input,
        "encoding_format": req.encodingFormat or "float",
    }

    in_flight += 1
    t0 = time.time()
    try:
        client = await get_http_client()
        r = await client.post(f"{VLLM_BASE_URL}/v1/embeddings",
                               json=openai_req)
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=r.text)
        d = r.json()
        out: Dict[str, Any] = {
            "model": MODEL_NAME or req.model,
            "embeddings": [item.get("embedding", []) for item in (d.get("data") or [])],
            "usage": {
                "promptTokens": (d.get("usage") or {}).get("prompt_tokens", 0),
                "totalTokens":  (d.get("usage") or {}).get("total_tokens", 0),
            },
        }
        out["sourceSha256"] = hashlib.sha256(body_bytes).hexdigest()
        # outputSha256 over the concatenated embeddings (deterministic for audit)
        out["outputSha256"] = hashlib.sha256(
            json.dumps(out["embeddings"], separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        request_count += 1
        compute_ms = int((time.time() - t0) * 1000)
        return JSONResponse(content=out,
                            headers=safebox_headers(request_id,
                                                    MODEL_NAME or req.model,
                                                    compute_ms))
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"vLLM upstream error: {e}")
    except Exception as e:
        logger.exception("Embed failed")
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
        "version":    "1.2",
        "runnerType": "llm",
        "runnerId":   RUNNER_ID,
        "serviceId":  SERVICE_ID,
        "transport":  transport,
        "models": {
            "loaded":   [MODEL_NAME] if (vllm_ready and MODEL_NAME) else [],
            "loading":  [MODEL_NAME] if (not vllm_ready and MODEL_NAME) else [],
            "vllmArg":  VLLM_MODEL_ARG,
        },
        "capabilities": {
            "chat":       CAP_CHAT,
            "complete":   CAP_COMPLETE,
            "embed":      CAP_EMBED,
            "toolUse":    CAP_TOOL_USE,
            "vision":     CAP_VISION,
            "streaming":  CAP_STREAMING,
        },
        "health": "healthy" if vllm_ready else "loading",
    }


@app.get("/v1/capacity")
async def capacity():
    return {
        "canAccept":             vllm_ready and in_flight < MAX_QUEUE_DEPTH,
        "inFlight":              in_flight,
        "maxQueueDepth":         MAX_QUEUE_DEPTH,
        "capacityHint":          get_capacity_hint(),
        "requestCount":          request_count,
        "totalPromptTokens":     total_prompt_tokens,
        "totalCompletionTokens": total_completion_tokens,
    }


@app.get("/v1/models")
async def models():
    """OpenAI-style list of loaded models. Useful for clients that just want
    to discover what's there."""
    return {
        "object": "list",
        "data": [
            {
                "id":       MODEL_NAME or VLLM_MODEL_ARG,
                "object":   "model",
                "owned_by": "safebox",
                "created":  int(time.time()),
                "permission": [],
            }
        ] if (MODEL_NAME or VLLM_MODEL_ARG) else [],
    }


@app.get("/health")
async def health():
    return Response(
        content=json.dumps({
            "status":               "healthy" if vllm_ready else "loading",
            "vllmReady":            vllm_ready,
            "requestCount":         request_count,
            "inFlight":             in_flight,
            "totalPromptTokens":    total_prompt_tokens,
            "totalCompletionTokens": total_completion_tokens,
        }),
        status_code=200 if vllm_ready else 503,
        media_type="application/json",
    )


# ─── vLLM warmup probe ─────────────────────────────────────────────────
async def _wait_for_vllm():
    global vllm_ready
    deadline = time.time() + VLLM_WARMUP_TIMEOUT_S
    while time.time() < deadline:
        try:
            client = await get_http_client()
            r = await client.get(f"{VLLM_BASE_URL}/health", timeout=5.0)
            if r.status_code == 200:
                vllm_ready = True
                logger.info("vLLM is ready")
                return
        except Exception:
            pass
        await asyncio.sleep(2)
    logger.error(f"vLLM did not become ready within {VLLM_WARMUP_TIMEOUT_S}s")


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
    logger.info(f"vLLM runner starting — model={MODEL_NAME!r} vllm-arg={VLLM_MODEL_ARG!r}")
    setup_unix_socket()
    # Probe vLLM in background; endpoints return 503 until it's ready
    asyncio.create_task(_wait_for_vllm())


@app.on_event("shutdown")
async def on_shutdown():
    global _http_client
    if _http_client is not None:
        await _http_client.aclose()
        _http_client = None


# ─── Main ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if ENABLE_UNIX_SOCKET:
        # Set socket permissions after uvicorn binds it
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
        # Schedule perm-fix on app startup
        @app.on_event("startup")
        async def _perms_on_startup():
            asyncio.create_task(_adjust_perms())

        logger.info(f"Listening on Unix socket: {SAFEBOX_SOCKET_PATH}")
        uvicorn.run(app, uds=SAFEBOX_SOCKET_PATH, log_level="info")
    else:
        logger.info("Listening on 0.0.0.0:8080 (no Unix socket)")
        uvicorn.run(app, host="0.0.0.0", port=8080, log_level="info")
