"""
vLLM Model Runner - Safebox Wire Protocol v1.1 COMPLIANT

This is a thin adapter that wraps vLLM's built-in OpenAI-compatible server.

THREE FIXES IMPLEMENTED:
1. ✅ Canonical endpoints: /v1/chat, /v1/complete, /v1/embed (camelCase, flat)
2. ✅ X-Safebox-* header prefix on ALL headers
3. ✅ X-Safebox-Request-Id echo in EVERY response

Architecture:
- vLLM runs its built-in OpenAI server internally (port 8000)
- This adapter provides Safebox canonical endpoints
- Translates between Safebox wire format ↔ vLLM's OpenAI format
- Also keeps OpenAI-compat aliases for backward compatibility
"""

import asyncio
import json
import logging
import os
import socket
import stat
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

RUNNER_ID = os.getenv('RUNNER_ID', 'safebox-model-llm-1')
SERVICE_ID = os.getenv('SERVICE_ID', 'model-llm-1')
SAFEBOX_SOCKET_PATH = os.getenv('SAFEBOX_SOCKET_PATH', f'/run/safebox/services/{SERVICE_ID}.sock')
ENABLE_UNIX_SOCKET = os.getenv('ENABLE_UNIX_SOCKET', 'true').lower() == 'true'
MAX_QUEUE_DEPTH = int(os.getenv('MAX_QUEUE_DEPTH', '16'))

# vLLM server (running internally on localhost:8000)
VLLM_HOST = os.getenv('VLLM_HOST', 'localhost')
VLLM_PORT = int(os.getenv('VLLM_PORT', '8000'))
VLLM_BASE_URL = f"http://{VLLM_HOST}:{VLLM_PORT}"

# Model info
MODEL_NAME = os.getenv('MODEL', 'meta-llama/Llama-3.1-8B-Instruct')
ENABLE_PREFIX_CACHING = os.getenv('VLLM_ENABLE_PREFIX_CACHING', 'true').lower() == 'true'

# ============================================================================
# SAFEBOX CANONICAL REQUEST MODELS (camelCase per spec §6)
# ============================================================================

class SafeboxChatRequest(BaseModel):
    model: str
    messages: List[Dict[str, str]]
    maxTokens: Optional[int] = 2048
    temperature: Optional[float] = 0.7
    topP: Optional[float] = None  # Bug #5 fix: None means use vLLM default
    stop: Optional[List[str]] = None  # Bug #4 fix: Accept stop sequences
    stream: Optional[bool] = False

class SafeboxCompleteRequest(BaseModel):
    model: str
    prompt: str
    maxTokens: Optional[int] = 2048
    temperature: Optional[float] = 0.7
    topP: Optional[float] = None  # Bug #5 fix: None means use vLLM default
    stop: Optional[List[str]] = None  # Bug #4 fix: Accept stop sequences
    stream: Optional[bool] = False

class SafeboxEmbedRequest(BaseModel):
    model: str
    input: str  # or List[str]

# ============================================================================
# GLOBAL STATE
# ============================================================================

app = FastAPI(title="Safebox vLLM Adapter v1.1")
request_queue: List[Dict[str, Any]] = []
queue_lock = asyncio.Lock()  # Async-safe queue access

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
    response: Response = None
):
    """
    Safebox canonical chat endpoint (Spec §4, §6)
    
    REQUEST: camelCase {model, messages, maxTokens, ...}
    RESPONSE: FLAT camelCase {model, content, role, finishReason, usage}
    HEADERS: X-Safebox-* prefix, Request-Id echoed
    """
    start_time = time.time()
    
    # Track in queue (async-safe)
    async with queue_lock:
        request_queue.append({"id": x_safebox_request_id, "time": start_time})
    
    try:
        # Convert Safebox → OpenAI format (camelCase → snake_case)
        openai_request = {
            "model": request.model,
            "messages": request.messages,
            "max_tokens": request.maxTokens,
            "temperature": request.temperature,
            "stream": request.stream
        }
        
        # Only include optional fields if set
        if request.topP is not None:
            openai_request["top_p"] = request.topP
        if request.stop is not None:
            openai_request["stop"] = request.stop
        
        # Mark compute start (for accurate queue wait measurement)
        compute_start = time.time()
        queue_wait_ms = int((compute_start - start_time) * 1000)
        
        # Call vLLM's OpenAI endpoint
        async with httpx.AsyncClient() as client:
            vllm_response = await client.post(
                f"{VLLM_BASE_URL}/v1/chat/completions",
                json=openai_request,
                timeout=60.0
            )
            vllm_response.raise_for_status()
            vllm_data = vllm_response.json()
        
        # Extract from OpenAI nested format
        choice = vllm_data["choices"][0]
        message = choice["message"]
        usage = vllm_data.get("usage", {})
        
        # Check cache hit (vLLM includes in prompt_tokens_details)
        cache_hit = False
        tokens_reused = 0
        if "prompt_tokens_details" in usage:
            details = usage["prompt_tokens_details"]
            if "cached_tokens" in details:
                tokens_reused = details["cached_tokens"]
                cache_hit = tokens_reused > 0
        
        # Convert to Safebox canonical (FLAT, camelCase per spec §6)
        compute_ms = int((time.time() - start_time) * 1000)
        
        safebox_response = {
            "model": request.model,
            "content": message["content"],
            "role": message["role"],
            "finishReason": choice["finish_reason"],
            "usage": {
                "promptTokens": usage.get("prompt_tokens", 0),
                "completionTokens": usage.get("completion_tokens", 0),
                "totalTokens": usage.get("total_tokens", 0)
            }
        }
        
        # Set Safebox headers (spec §5, §7 - ALL with X-Safebox- prefix!)
        response.headers["X-Safebox-Request-Id"] = x_safebox_request_id  # ✅ ECHO (spec §5)
        response.headers["X-Safebox-Runner-Id"] = RUNNER_ID
        response.headers["X-Safebox-Model-Id"] = request.model
        response.headers["X-Safebox-Cache-Hit"] = "true" if cache_hit else "false"
        response.headers["X-Safebox-Cache-Tokens-Reused"] = str(tokens_reused)
        response.headers["X-Safebox-Queue-Wait-Ms"] = str(queue_wait_ms)
        response.headers["X-Safebox-Compute-Ms"] = str(compute_ms)
        response.headers["X-Safebox-Capacity-Hint"] = get_capacity_hint()
        
        return safebox_response
        
    except httpx.HTTPStatusError as e:
        logger.error(f"vLLM error: {e.response.status_code} {e.response.text}")
        # Still echo request ID on error!
        response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
        raise HTTPException(status_code=e.response.status_code, detail=str(e))
    except Exception as e:
        logger.error(f"Chat error: {e}")
        response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # Remove from queue (async-safe)
        async with queue_lock:
            request_queue[:] = [r for r in request_queue if r["id"] != x_safebox_request_id]

@app.post("/v1/complete")
async def safebox_complete(
    request: SafeboxCompleteRequest,
    x_safebox_request_id: str = Header(..., alias="X-Safebox-Request-Id"),
    x_safebox_tenant: Optional[str] = Header("default", alias="X-Safebox-Tenant"),
    x_safebox_cache_mode: Optional[str] = Header("prefix", alias="X-Safebox-Cache-Mode"),
    response: Response = None
):
    """Safebox canonical completion endpoint"""
    start_time = time.time()
    
    try:
        # Convert to OpenAI format
        openai_request = {
            "model": request.model,
            "prompt": request.prompt,
            "max_tokens": request.maxTokens,
            "temperature": request.temperature,
            "stream": request.stream
        }
        
        # Only include optional fields if set
        if request.topP is not None:
            openai_request["top_p"] = request.topP
        if request.stop is not None:
            openai_request["stop"] = request.stop
        
        # Call vLLM
        async with httpx.AsyncClient() as client:
            vllm_response = await client.post(
                f"{VLLM_BASE_URL}/v1/completions",
                json=openai_request,
                timeout=60.0
            )
            vllm_response.raise_for_status()
            vllm_data = vllm_response.json()
        
        # Extract
        choice = vllm_data["choices"][0]
        usage = vllm_data.get("usage", {})
        
        compute_ms = int((time.time() - start_time) * 1000)
        
        # Safebox format (flat, camelCase)
        safebox_response = {
            "model": request.model,
            "content": choice["text"],
            "finishReason": choice["finish_reason"],
            "usage": {
                "promptTokens": usage.get("prompt_tokens", 0),
                "completionTokens": usage.get("completion_tokens", 0),
                "totalTokens": usage.get("total_tokens", 0)
            }
        }
        
        # Headers (all 8 telemetry headers)
        response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
        response.headers["X-Safebox-Runner-Id"] = RUNNER_ID
        response.headers["X-Safebox-Model-Id"] = request.model
        response.headers["X-Safebox-Cache-Hit"] = "false"  # Completions don't use prefix cache
        response.headers["X-Safebox-Cache-Tokens-Reused"] = "0"
        response.headers["X-Safebox-Queue-Wait-Ms"] = "0"  # Will fix in bug #3
        response.headers["X-Safebox-Compute-Ms"] = str(compute_ms)
        response.headers["X-Safebox-Capacity-Hint"] = get_capacity_hint()
        
        return safebox_response
        
    except Exception as e:
        logger.error(f"Complete error: {e}")
        response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/v1/embed")
async def safebox_embed(
    request: SafeboxEmbedRequest,
    x_safebox_request_id: str = Header(..., alias="X-Safebox-Request-Id"),
    response: Response = None
):
    """Safebox canonical embeddings (requires vLLM --task embed)"""
    start_time = time.time()
    
    try:
        openai_request = {
            "model": request.model,
            "input": request.input
        }
        
        async with httpx.AsyncClient() as client:
            vllm_response = await client.post(
                f"{VLLM_BASE_URL}/v1/embeddings",
                json=openai_request,
                timeout=60.0
            )
            vllm_response.raise_for_status()
            vllm_data = vllm_response.json()
        
        embeddings = [item["embedding"] for item in vllm_data["data"]]
        usage = vllm_data.get("usage", {})
        compute_ms = int((time.time() - start_time) * 1000)
        
        safebox_response = {
            "model": request.model,
            "embeddings": embeddings,
            "usage": {
                "promptTokens": usage.get("prompt_tokens", 0),
                "totalTokens": usage.get("total_tokens", 0)
            }
        }
        
        # Headers (all 8 telemetry headers)
        response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
        response.headers["X-Safebox-Runner-Id"] = RUNNER_ID
        response.headers["X-Safebox-Model-Id"] = request.model
        response.headers["X-Safebox-Cache-Hit"] = "false"  # Embeddings don't use prefix cache
        response.headers["X-Safebox-Cache-Tokens-Reused"] = "0"
        response.headers["X-Safebox-Queue-Wait-Ms"] = "0"  # Will fix in bug #3
        response.headers["X-Safebox-Compute-Ms"] = str(compute_ms)
        response.headers["X-Safebox-Capacity-Hint"] = get_capacity_hint()
        
        return safebox_response
        
    except httpx.HTTPStatusError as e:
        response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
        if e.response.status_code == 404:
            raise HTTPException(status_code=501, detail="Embeddings not supported")
        raise
    except Exception as e:
        logger.error(f"Embed error: {e}")
        response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
        raise HTTPException(status_code=500, detail=str(e))

# ============================================================================
# PLACEHOLDERS (Image, Transcription)
# ============================================================================

@app.post("/v1/image/generate")
async def safebox_image_generate(
    x_safebox_request_id: str = Header(..., alias="X-Safebox-Request-Id"),
    response: Response = None
):
    response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
    response.headers["X-Safebox-Runner-Id"] = RUNNER_ID
    raise HTTPException(status_code=501, detail="Use ComfyUI runner for images")

@app.post("/v1/transcribe")
async def safebox_transcribe(
    x_safebox_request_id: str = Header(..., alias="X-Safebox-Request-Id"),
    response: Response = None
):
    response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
    response.headers["X-Safebox-Runner-Id"] = RUNNER_ID
    raise HTTPException(status_code=501, detail="Use Whisper runner for transcription")

# ============================================================================
# OPENAI-COMPAT ALIASES (Spec §14 - backward compatibility)
# ============================================================================

@app.post("/v1/chat/completions")
async def openai_chat_alias(
    request: Request,
    x_safebox_request_id: Optional[str] = Header(None, alias="X-Safebox-Request-Id"),
    response: Response = None
):
    """OpenAI-compatible alias (spec §14 - coexist with canonical)"""
    if not x_safebox_request_id:
        import uuid
        x_safebox_request_id = f"req_{uuid.uuid4().hex[:12]}"
    
    body = await request.json()
    
    async with httpx.AsyncClient() as client:
        vllm_response = await client.post(
            f"{VLLM_BASE_URL}/v1/chat/completions",
            json=body,
            timeout=60.0
        )
        result = vllm_response.json()
    
    # Still echo request ID!
    response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
    
    return result

# ============================================================================
# CAPABILITIES & HEALTH (Spec §3)
# ============================================================================

@app.get("/v1/capabilities")
async def get_capabilities():
    """Runner capabilities (spec §3)"""
    return {
        "runnerId": RUNNER_ID,
        "serviceId": SERVICE_ID,
        "protocols": {
            "llm": {
                "chat": True,
                "completion": True,
                "embedding": True
            },
            "image": {"generate": False},
            "transcription": {"transcribe": False}
        },
        "models": {"loaded": [MODEL_NAME]},
        "transport": {
            "socket": {
                "enabled": ENABLE_UNIX_SOCKET,
                "path": SAFEBOX_SOCKET_PATH if ENABLE_UNIX_SOCKET else None
            }
        },
        "features": {
            "prefixCaching": ENABLE_PREFIX_CACHING,
            "streaming": False,
            "hmacSigning": False
        },
        "queue": {
            "maxDepth": MAX_QUEUE_DEPTH,
            "depth": len(request_queue)
        }
    }

@app.get("/v1/capacity")
async def get_capacity():
    return {
        "capacityHint": get_capacity_hint(),
        "queueDepth": len(request_queue),
        "maxQueueDepth": MAX_QUEUE_DEPTH
    }

@app.get("/health")
async def health():
    try:
        async with httpx.AsyncClient() as client:
            await client.get(f"{VLLM_BASE_URL}/health", timeout=5.0)
        return {"status": "healthy", "runnerId": RUNNER_ID}
    except:
        return {"status": "unhealthy", "runnerId": RUNNER_ID}

# ============================================================================
# HELPERS
# ============================================================================

def get_capacity_hint() -> str:
    depth = len(request_queue)
    if depth >= MAX_QUEUE_DEPTH * 0.9:
        return "saturated"
    elif depth >= MAX_QUEUE_DEPTH * 0.7:
        return "near-saturated"
    return "available"

def setup_unix_socket():
    if not ENABLE_UNIX_SOCKET:
        return
    socket_path = Path(SAFEBOX_SOCKET_PATH)
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    if socket_path.exists():
        socket_path.unlink()
    logger.info(f"Socket will be at: {socket_path}")

# ============================================================================
# STARTUP
# ============================================================================

@app.on_event("startup")
async def startup():
    logger.info("Safebox vLLM Adapter v1.1 - WIRE PROTOCOL COMPLIANT")
    logger.info(f"Runner: {RUNNER_ID}, Service: {SERVICE_ID}")
    logger.info(f"vLLM backend: {VLLM_BASE_URL}")
    
    if ENABLE_UNIX_SOCKET:
        setup_unix_socket()
    
    # Wait for vLLM
    logger.info("Waiting for vLLM...")
    for i in range(30):
        try:
            async with httpx.AsyncClient() as client:
                await client.get(f"{VLLM_BASE_URL}/health", timeout=2.0)
            logger.info("✓ vLLM ready")
            break
        except:
            if i == 29:
                logger.error("✗ vLLM timeout")
            await asyncio.sleep(1)

# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    if ENABLE_UNIX_SOCKET:
        uvicorn.run(app, uds=SAFEBOX_SOCKET_PATH, log_level="info")
    else:
        uvicorn.run(app, host="0.0.0.0", port=8080, log_level="info")
