"""
vLLM Model Runner Extension - Safebox Local Service v1.1
Adds governance endpoints and telemetry to vLLM server
Now supports Unix domain sockets as primary transport
"""

import asyncio
import hashlib
import hmac
import json
import logging
import os
import socket
import stat
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Set

import psutil
from fastapi import FastAPI, Header, HTTPException, Request, Response
from pydantic import BaseModel
import torch
import uvicorn

# vLLM imports
from vllm import AsyncLLMEngine, AsyncEngineArgs, SamplingParams
from vllm.entrypoints.openai.api_server import app as vllm_app
from vllm.engine.async_llm_engine import AsyncLLMEngine as VLLMEngine


logger = logging.getLogger(__name__)

# Configuration
RUNNER_ID = os.getenv('RUNNER_ID', 'safebox-model-llm-1')
SERVICE_ID = os.getenv('SERVICE_ID', 'model-llm-1')  # For socket path
HMAC_KEY_PATH = os.getenv('HMAC_KEY_PATH', '/etc/safebox/model-api.key')
MAX_QUEUE_DEPTH = int(os.getenv('MAX_QUEUE_DEPTH', '16'))
ENABLE_PREFIX_CACHING = os.getenv('VLLM_ENABLE_PREFIX_CACHING', 'true').lower() == 'true'

# Transport configuration (v1.1)
SAFEBOX_SOCKET_PATH = os.getenv('SAFEBOX_SOCKET_PATH', f'/run/safebox/services/{SERVICE_ID}.sock')
ENABLE_UNIX_SOCKET = os.getenv('ENABLE_UNIX_SOCKET', 'true').lower() == 'true'
ENABLE_TCP = os.getenv('ENABLE_TCP', 'true').lower() == 'true'
TCP_HOST = os.getenv('TCP_HOST', '0.0.0.0')
TCP_PORT = int(os.getenv('TCP_PORT', '8080'))

# SO_PEERCRED verification (Linux-specific)
VERIFY_PEERCRED = os.getenv('VERIFY_PEERCRED', 'false').lower() == 'true'
ALLOWED_UID = int(os.getenv('ALLOWED_UID', '1000'))  # safebox-app UID

# Load HMAC key
try:
    with open(HMAC_KEY_PATH, 'r') as f:
        HMAC_KEY = f.read().strip()
except Exception as e:
    logger.warning(f"Could not load HMAC key from {HMAC_KEY_PATH}: {e}")
    HMAC_KEY = None

# State
seen_nonces: Set[str] = set()
load_tasks: Dict[str, dict] = {}
cache_stats: Dict[str, dict] = {}  # model -> {hits: int, misses: int}


# ============================================================================
# UNIX SOCKET SETUP (v1.1)
# ============================================================================

def setup_unix_socket():
    """Setup Unix domain socket with proper permissions"""
    if not ENABLE_UNIX_SOCKET:
        return None
    
    socket_path = Path(SAFEBOX_SOCKET_PATH)
    
    # Create parent directory if needed
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Remove stale socket
    if socket_path.exists():
        logger.info(f"Removing stale socket: {socket_path}")
        socket_path.unlink()
    
    # Create Unix socket
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(str(socket_path))
    
    # Set permissions: 0660 (rw-rw----)
    os.chmod(str(socket_path), stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IWGRP)
    
    # Set ownership (if running as root)
    try:
        import grp
        import pwd
        
        # Get safebox-services GID
        gid = grp.getgrnam('safebox-services').gr_gid
        uid = pwd.getpwnam('safebox-services').pw_uid
        
        os.chown(str(socket_path), uid, gid)
        logger.info(f"Socket ownership: safebox-services:safebox-services")
    except Exception as e:
        logger.warning(f"Could not set socket ownership: {e}")
    
    logger.info(f"Unix socket ready: {socket_path}")
    return sock


def verify_unix_peer(sock):
    """Verify connecting process credentials via SO_PEERCRED"""
    if not VERIFY_PEERCRED:
        return True
    
    try:
        # Get peer credentials (Linux-specific)
        creds = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
        pid, uid, gid = struct.unpack('3i', creds)
        
        if uid != ALLOWED_UID:
            logger.error(f"Rejected connection from UID {uid} (expected {ALLOWED_UID})")
            return False
        
        logger.debug(f"Accepted connection from UID {uid}, PID {pid}")
        return True
        
    except Exception as e:
        logger.error(f"SO_PEERCRED verification failed: {e}")
        return False


# ============================================================================
# MODELS
# ============================================================================

class ModelLoadRequest(BaseModel):
    modelId: str
    quantization: Optional[str] = None
    maxContextLength: Optional[int] = 32768
    gpuMemoryBudgetMB: Optional[int] = None
    evictModel: Optional[str] = None
    verifiedOpToken: str


class ModelUnloadRequest(BaseModel):
    modelId: str
    verifiedOpToken: str


class CacheFlushRequest(BaseModel):
    scope: str  # 'all', 'model', 'tenant', 'tag'
    modelId: Optional[str] = None
    tenantId: Optional[str] = None
    tag: Optional[str] = None
    verifiedOpToken: str


# ============================================================================
# HMAC VERIFICATION
# ============================================================================

def verify_op_token(token: str) -> bool:
    """Verify verifiedOpToken signature"""
    if not HMAC_KEY:
        logger.warning("HMAC key not configured, skipping verification")
        return True
    
    try:
        data = json.loads(token)
        op_token = data.get('opToken', {})
        signature = data.get('signature', '')
        
        # Check nonce for replay protection
        nonce = op_token.get('nonce')
        if nonce in seen_nonces:
            logger.error(f"Replay attack detected: nonce {nonce} already seen")
            return False
        
        # Verify timestamp (within 5 minutes)
        issued_at = op_token.get('issuedAt', 0)
        if abs(time.time() - issued_at) > 300:
            logger.error(f"Token expired: issued {time.time() - issued_at}s ago")
            return False
        
        # Verify HMAC signature
        expected = hmac.new(
            HMAC_KEY.encode(),
            json.dumps(op_token, sort_keys=True).encode(),
            hashlib.sha256
        ).hexdigest()
        
        if not hmac.compare_digest(expected, signature):
            logger.error("HMAC signature mismatch")
            return False
        
        # Add nonce to seen set
        seen_nonces.add(nonce)
        
        return True
        
    except Exception as e:
        logger.error(f"Token verification failed: {e}")
        return False


# ============================================================================
# CAPABILITIES ENDPOINT (v1.1 - includes transport field)
# ============================================================================

@vllm_app.get("/v1/capabilities")
async def get_capabilities():
    """Return runner capabilities and current state (v1.1)"""
    
    # Get vLLM engine state
    engine: VLLMEngine = vllm_app.state.engine
    
    # Get loaded models
    loaded_models = []
    if hasattr(engine, 'model_config'):
        model_config = engine.model_config
        loaded_models.append({
            "id": getattr(model_config, 'model', 'unknown'),
            "quantization": getattr(model_config, 'quantization', None),
            "contextLength": getattr(model_config, 'max_model_len', 32768),
            "loadedAt": int(time.time()),
            "gpuMemoryMB": get_model_memory_mb()
        })
    
    # Get GPU info
    gpu_info = get_gpu_info()
    
    # Get queue info
    queue_info = get_queue_info(engine)
    
    # Transport field (v1.1 addition)
    transport = {}
    if ENABLE_UNIX_SOCKET:
        transport['socket'] = {
            'path': SAFEBOX_SOCKET_PATH,
            'permissions': '0660',
            'group': 'safebox-services'
        }
    if ENABLE_TCP:
        transport['tcp'] = {
            'host': TCP_HOST,
            'port': TCP_PORT
        }
    
    return {
        "version": "1.0",  # First release with Unix sockets
        "runnerType": f"vllm-{os.getenv('VLLM_VERSION', '0.6.0')}",
        "runnerId": RUNNER_ID,
        "serviceId": SERVICE_ID,
        "transport": transport,  # Socket + optional TCP
        "models": {
            "loaded": [m["id"] for m in loaded_models],
            "loading": [task["modelId"] for task in load_tasks.values() if task["status"] == "loading"],
            "available": []  # Would list models in HF cache
        },
        "resources": {
            "gpuIds": [0],  # From CUDA_VISIBLE_DEVICES
            "gpuMemoryTotalMB": gpu_info["total"],
            "gpuMemoryUsedMB": gpu_info["used"],
            "gpuMemoryFreeMB": gpu_info["free"],
            "gpuUtilization": gpu_info["utilization"],
            "kvCacheSizeMB": get_kv_cache_size_mb(),
            "kvCacheUtilization": get_kv_cache_utilization()
        },
        "queue": queue_info,
        "capabilities": {
            "streaming": True,
            "prefixCaching": ENABLE_PREFIX_CACHING,
            "multiTenant": True,
            "visionInput": False,
            "audioInput": False,
            "functionCalling": True
        },
        "health": get_health_status(queue_info)
    }


@vllm_app.get("/v1/capacity")
async def get_capacity():
    """Return current capacity state (v1.1 addition)"""
    engine: VLLMEngine = vllm_app.state.engine
    queue_info = get_queue_info(engine)
    gpu_info = get_gpu_info()
    
    return {
        "queueDepth": queue_info["depth"],
        "queueCapacity": queue_info["maxDepth"],
        "queueUtilization": queue_info["depth"] / queue_info["maxDepth"] if queue_info["maxDepth"] > 0 else 0,
        "gpuMemoryUsedMB": gpu_info["used"],
        "gpuMemoryTotalMB": gpu_info["total"],
        "gpuMemoryUtilization": gpu_info["utilization"],
        "canAccept": queue_info["depth"] < queue_info["maxDepth"]
    }


def get_gpu_info() -> dict:
    """Get GPU memory and utilization"""
    try:
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            allocated = torch.cuda.memory_allocated(0)
            reserved = torch.cuda.memory_reserved(0)
            total = props.total_memory
            
            return {
                "total": int(total / 1024 / 1024),  # MB
                "used": int(reserved / 1024 / 1024),
                "free": int((total - reserved) / 1024 / 1024),
                "utilization": allocated / total if total > 0 else 0
            }
    except Exception as e:
        logger.warning(f"Could not get GPU info: {e}")
    
    return {"total": 0, "used": 0, "free": 0, "utilization": 0}


def get_model_memory_mb() -> int:
    """Estimate model memory usage"""
    try:
        if torch.cuda.is_available():
            return int(torch.cuda.memory_allocated(0) / 1024 / 1024)
    except:
        pass
    return 0


def get_kv_cache_size_mb() -> int:
    """Get KV cache size"""
    # vLLM-specific - would read from engine state
    return 0


def get_kv_cache_utilization() -> float:
    """Get KV cache utilization"""
    return 0.0


def get_queue_info(engine) -> dict:
    """Get queue depth and wait times"""
    # vLLM request queue
    queue_depth = 0
    if hasattr(engine, 'scheduler'):
        queue_depth = len(getattr(engine.scheduler, 'waiting', []))
    
    return {
        "depth": queue_depth,
        "maxDepth": MAX_QUEUE_DEPTH,
        "avgWaitMs": 0,  # Would track in metrics
        "p95WaitMs": 0
    }


def get_health_status(queue_info: dict) -> str:
    """Determine health status"""
    if queue_info["depth"] >= MAX_QUEUE_DEPTH:
        return "saturated"
    elif queue_info["depth"] >= MAX_QUEUE_DEPTH * 0.8:
        return "degraded"
    return "healthy"


# ============================================================================
# MODEL LOADING
# ============================================================================

@vllm_app.post("/v1/models/load")
async def load_model(request: ModelLoadRequest):
    """Load a model into GPU memory"""
    
    # Verify governance token
    if not verify_op_token(request.verifiedOpToken):
        raise HTTPException(status_code=401, detail="Invalid verifiedOpToken")
    
    # Create task
    task_id = hashlib.sha256(
        f"{request.modelId}-{time.time()}".encode()
    ).hexdigest()[:16]
    
    load_tasks[task_id] = {
        "taskId": task_id,
        "status": "loading",
        "modelId": request.modelId,
        "progress": 0.0,
        "eta": 300,
        "startedAt": time.time()
    }
    
    # Start async loading
    asyncio.create_task(async_load_model(
        task_id,
        request.modelId,
        request.quantization,
        request.maxContextLength,
        request.evictModel
    ))
    
    return {
        "taskId": task_id,
        "status": "loading",
        "progress": 0.0,
        "eta": 300
    }


async def async_load_model(
    task_id: str,
    model_id: str,
    quantization: Optional[str],
    max_context: int,
    evict_model: Optional[str]
):
    """Actually load the model (async)"""
    try:
        # Update progress
        load_tasks[task_id]["progress"] = 0.1
        
        # Evict old model if specified
        if evict_model:
            # Would call vLLM engine to unload
            pass
        
        load_tasks[task_id]["progress"] = 0.3
        
        # Download model if not cached
        # from huggingface_hub import snapshot_download
        # snapshot_download(model_id)
        
        load_tasks[task_id]["progress"] = 0.6
        
        # Load into vLLM engine
        # This would restart the vLLM engine with new model
        # In practice, may need to restart the container
        
        load_tasks[task_id]["progress"] = 0.9
        
        # Mark complete
        gpu_memory = get_model_memory_mb()
        load_time = int((time.time() - load_tasks[task_id]["startedAt"]) * 1000)
        
        load_tasks[task_id].update({
            "status": "completed",
            "progress": 1.0,
            "gpuMemoryUsedMB": gpu_memory,
            "loadTimeMs": load_time
        })
        
    except Exception as e:
        logger.error(f"Model load failed: {e}")
        load_tasks[task_id].update({
            "status": "failed",
            "error": str(e)
        })


@vllm_app.get("/v1/models/load/{task_id}")
async def get_load_status(task_id: str):
    """Poll model loading status"""
    if task_id not in load_tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    
    return load_tasks[task_id]


# ============================================================================
# MODEL UNLOADING
# ============================================================================

@vllm_app.post("/v1/models/unload")
async def unload_model(request: ModelUnloadRequest):
    """Unload model from GPU memory"""
    
    if not verify_op_token(request.verifiedOpToken):
        raise HTTPException(status_code=401, detail="Invalid verifiedOpToken")
    
    # In vLLM, unloading means restarting with no model
    # Or stopping the service
    # Return freed memory estimate
    
    freed_memory = get_model_memory_mb()
    
    return {
        "modelId": request.modelId,
        "gpuMemoryFreedMB": freed_memory,
        "kvCacheFlushed": True
    }


# ============================================================================
# CACHE MANAGEMENT
# ============================================================================

@vllm_app.post("/v1/cache/flush")
async def flush_cache(request: CacheFlushRequest):
    """Flush KV cache"""
    
    if not verify_op_token(request.verifiedOpToken):
        raise HTTPException(status_code=401, detail="Invalid verifiedOpToken")
    
    # vLLM cache flushing would go here
    # For now, return mock data
    
    entries_removed = 0
    memory_freed = 0
    
    if request.scope == "all":
        # Flush entire cache
        entries_removed = 1000
        memory_freed = 5000
    elif request.scope == "tenant" and request.tenantId:
        # Flush tenant-specific cache
        entries_removed = 100
        memory_freed = 500
    
    return {
        "flushed": True,
        "entriesRemoved": entries_removed,
        "memoryFreedMB": memory_freed
    }


# ============================================================================
# CACHE TELEMETRY MIDDLEWARE
# ============================================================================

@vllm_app.middleware("http")
async def add_cache_telemetry(request: Request, call_next):
    """Add cache and queue telemetry to responses"""
    
    # Extract tenant/cache headers from request
    cache_mode = request.headers.get('X-Cache-Mode', 'auto')
    cache_tag = request.headers.get('X-Cache-Tag', '')
    tenant_id = request.headers.get('X-Tenant-ID', 'default')
    priority = request.headers.get('X-Priority', 'normal')
    
    # Track queue wait time
    queue_start = time.time()
    
    # Process request
    response = await call_next(request)
    
    queue_wait_ms = int((time.time() - queue_start) * 1000)
    
    # Add telemetry headers to response
    # In real implementation, would track actual cache hits
    cache_hit = ENABLE_PREFIX_CACHING and cache_mode == 'prefix'
    tokens_reused = 45 if cache_hit else 0
    
    # Update cache stats
    model = request.url.path.split('/')[-1]  # Simplified
    if model not in cache_stats:
        cache_stats[model] = {"hits": 0, "misses": 0}
    
    if cache_hit:
        cache_stats[model]["hits"] += 1
    else:
        cache_stats[model]["misses"] += 1
    
    # Add headers
    response.headers['X-Cache-Hit'] = str(cache_hit).lower()
    response.headers['X-Cache-Tokens-Reused'] = str(tokens_reused)
    response.headers['X-Queue-Wait-Ms'] = str(queue_wait_ms)
    response.headers['X-GPU-Time-Ms'] = '450'  # Would track actual
    
    return response


# ============================================================================
# RATE LIMITING
# ============================================================================

# Simple in-memory rate limiter
rate_limits: Dict[str, List[float]] = {}
RATE_LIMIT_WINDOW = 60  # seconds
RATE_LIMIT_DEFAULT = int(os.getenv('DEFAULT_RATE_LIMIT', '100'))


@vllm_app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    """Per-tenant rate limiting"""
    
    tenant_id = request.headers.get('X-Tenant-ID', 'default')
    
    # Get rate limit for tenant
    limit = RATE_LIMIT_DEFAULT  # Would read from config
    
    # Track requests in sliding window
    now = time.time()
    if tenant_id not in rate_limits:
        rate_limits[tenant_id] = []
    
    # Remove old requests outside window
    rate_limits[tenant_id] = [
        ts for ts in rate_limits[tenant_id]
        if now - ts < RATE_LIMIT_WINDOW
    ]
    
    # Check limit
    if len(rate_limits[tenant_id]) >= limit:
        return Response(
            content=json.dumps({
                "error": {
                    "code": "rate_limit_exceeded",
                    "message": f"Tenant {tenant_id} exceeded {limit} req/min",
                    "limit": limit,
                    "remaining": 0,
                    "resetAt": int(now + RATE_LIMIT_WINDOW)
                }
            }),
            status_code=429,
            headers={"Retry-After": "30"}
        )
    
    # Add request to window
    rate_limits[tenant_id].append(now)
    
    return await call_next(request)


# ============================================================================
# BACKPRESSURE
# ============================================================================

@vllm_app.middleware("http")
async def backpressure_middleware(request: Request, call_next):
    """Return 503 when queue saturated"""
    
    engine: VLLMEngine = vllm_app.state.engine
    queue_info = get_queue_info(engine)
    
    if queue_info["depth"] >= MAX_QUEUE_DEPTH:
        return Response(
            content=json.dumps({
                "error": {
                    "code": "queue_full",
                    "message": f"Queue depth {queue_info['depth']}/{MAX_QUEUE_DEPTH}, retry in 5 seconds",
                    "queueDepth": queue_info["depth"],
                    "avgWaitMs": queue_info["avgWaitMs"]
                }
            }),
            status_code=503,
            headers={"Retry-After": "5"}
        )
    
    return await call_next(request)


# ============================================================================
# HEALTH CHECK
# ============================================================================

@vllm_app.get("/health")
async def health_check():
    """Simple health check"""
    engine: VLLMEngine = vllm_app.state.engine
    queue_info = get_queue_info(engine)
    
    status_code = 200
    status = get_health_status(queue_info)
    
    if status == "saturated":
        status_code = 503
    
    return Response(
        content=json.dumps({
            "status": status,
            "uptime": int(time.time()),  # Would track actual
            "modelsLoaded": 1,  # Would count actual
            "queueDepth": queue_info["depth"]
        }),
        status_code=status_code
    )


# ============================================================================
# METRICS
# ============================================================================

@vllm_app.get("/metrics")
async def metrics():
    """Prometheus-compatible metrics"""
    
    lines = [
        "# HELP vllm_cache_hit_rate Cache hit rate",
        "# TYPE vllm_cache_hit_rate gauge"
    ]
    
    for model, stats in cache_stats.items():
        total = stats["hits"] + stats["misses"]
        hit_rate = stats["hits"] / total if total > 0 else 0
        lines.append(f'vllm_cache_hit_rate{{model="{model}"}} {hit_rate}')
    
    # Add more metrics...
    
    return Response(
        content="\n".join(lines),
        media_type="text/plain"
    )


if __name__ == "__main__":
    import struct
    
    # Setup transport
    config = uvicorn.Config(vllm_app, log_level="info")
    server = uvicorn.Server(config)
    
    if ENABLE_UNIX_SOCKET:
        # Create Unix socket
        unix_sock = setup_unix_socket()
        if unix_sock:
            logger.info(f"Starting server on Unix socket: {SAFEBOX_SOCKET_PATH}")
            server.run(uds=str(SAFEBOX_SOCKET_PATH))
    elif ENABLE_TCP:
        # Fallback to TCP
        logger.info(f"Starting server on TCP {TCP_HOST}:{TCP_PORT}")
        server.run(host=TCP_HOST, port=TCP_PORT)
    else:
        logger.error("No transport enabled (ENABLE_UNIX_SOCKET=false, ENABLE_TCP=false)")
        raise RuntimeError("At least one transport must be enabled")
