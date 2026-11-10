"""
U-Omni Model Runner — Safebox Wire Protocol v1.2

Thin FastAPI adapter over the U runtime binary.  Exposes the standard
Safebox canonical endpoints (/v1/chat, /v1/complete, /v1/capabilities,
/v1/healthz) plus a tree-structured KV cache management API (/v1/kv/*).

Architecture:
  - The U binary (u-omni) runs as a child process, listening on a Unix
    socket for inference requests in Safebox wire format.
  - This adapter handles HMAC auth, KV cache tree management, and the
    HTTP surface the system component proxies to.
  - Inference hot path: adapter receives request → fork() inside U
    binary → child gets CoW copy of KV cache → runs inference → responds
    → child exits.  KV state is ephemeral unless explicitly saved.
  - Cold path: adapter calls /v1/kv/save → U binary snapshots the KV
    cache to ZFS → survives reboots, enables branching/grafting.

KV Cache Tree:
  The two-tier CoW architecture naturally forms trees of checkpoints:
    - RAM tier (fork): ~0.1ms, pages shared via CoW, dies with process
    - ZFS tier (snapshot/clone): ~1ms, blocks shared via CoW, persistent
  Multiple forks from the same parent share all original pages/blocks.
  A tree of 100 branches from a shared system prompt costs roughly
  (system_prompt_KV + 100 * delta_KV), not 100 * full_KV.
"""

import asyncio
import json
import logging
import os
import socket
import stat
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field
import httpx
import uvicorn

# Shared HMAC auth (strong canonical form)
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from safebox_auth import verify_hmac

logger = logging.getLogger(__name__)


# ============================================================================
# CONFIGURATION
# ============================================================================

RUNNER_ID = os.getenv("RUNNER_ID", "safebox-u-omni-1")
SERVICE_ID = os.getenv("SERVICE_ID", "u-omni-1")
SAFEBOX_SOCKET_PATH = os.getenv(
    "SAFEBOX_SOCKET_PATH", f"/run/safebox/services/{SERVICE_ID}.sock"
)
ENABLE_UNIX_SOCKET = os.getenv("ENABLE_UNIX_SOCKET", "true").lower() == "true"

# U binary — communicates over its own Unix socket
U_BINARY_PATH = os.getenv("U_BINARY_PATH", "/usr/local/bin/u-omni")
U_SOCKET_PATH = os.getenv("U_SOCKET_PATH", "/run/safebox/u-omni.sock")
U_MODELS_ROOT = os.getenv("SAFEBOX_MODELS_ROOT", "/srv/safebox/models")

# KV cache configuration
KV_RAM_LIMIT_MB = int(os.getenv("KV_RAM_LIMIT_MB", "8192"))  # 8GB default
KV_ZFS_DATASET = os.getenv("KV_ZFS_DATASET", "safebox-pool/data/kv-cache")
KV_AUTO_PROMOTE_MB = int(os.getenv("KV_AUTO_PROMOTE_MB", "512"))  # auto-promote to ZFS above this

# Model info
MODEL_NAME = os.getenv("MODEL", "u-omni-multimodal")


# ============================================================================
# KV CACHE TREE
# ============================================================================

class KVCheckpoint(BaseModel):
    """A node in the KV cache tree."""
    id: str
    name: Optional[str] = None
    parentId: Optional[str] = None
    tier: str = Field(..., pattern=r"^(ram|zfs)$")
    tokenCount: int = 0
    sizeBytes: int = 0
    modelId: str = ""
    created: float = 0.0
    metadata: Dict[str, Any] = {}


class KVTree:
    """Manages the tree of KV cache checkpoints across RAM and ZFS tiers.

    RAM tier:
      fork() gives CoW copies of the parent process's address space.
      The U binary manages this internally — we track the metadata here
      and issue commands to the binary over its socket.

    ZFS tier:
      zfs snapshot / zfs clone give CoW copies at the block level.
      We issue zfs commands and track the mapping from checkpoint IDs
      to ZFS snapshot names.

    Tree structure:
      Each checkpoint has an optional parentId.  The root checkpoint
      is typically the system prompt's KV state (pre-computed at boot).
      Branches represent conversations, document contexts, or response
      alternatives that share prefix tokens with their parent.
    """

    def __init__(self):
        self.checkpoints: Dict[str, KVCheckpoint] = {}
        self.ram_usage_bytes: int = 0
        self.zfs_dataset: str = KV_ZFS_DATASET

    def add(self, cp: KVCheckpoint) -> None:
        self.checkpoints[cp.id] = cp
        if cp.tier == "ram":
            self.ram_usage_bytes += cp.sizeBytes

    def remove(self, cp_id: str) -> Optional[KVCheckpoint]:
        cp = self.checkpoints.pop(cp_id, None)
        if cp and cp.tier == "ram":
            self.ram_usage_bytes -= cp.sizeBytes
        return cp

    def get(self, cp_id: str) -> Optional[KVCheckpoint]:
        return self.checkpoints.get(cp_id)

    def children(self, cp_id: str) -> List[KVCheckpoint]:
        return [c for c in self.checkpoints.values() if c.parentId == cp_id]

    def subtree_ids(self, cp_id: str) -> List[str]:
        """All IDs in the subtree rooted at cp_id (inclusive)."""
        result = [cp_id]
        for child in self.children(cp_id):
            result.extend(self.subtree_ids(child.id))
        return result

    def tree_json(self) -> List[Dict]:
        """Return the full tree as nested JSON."""
        roots = [c for c in self.checkpoints.values() if c.parentId is None]
        return [self._node_json(r.id) for r in roots]

    def _node_json(self, cp_id: str) -> Dict:
        cp = self.checkpoints[cp_id]
        node = cp.dict()
        kids = self.children(cp_id)
        if kids:
            node["children"] = [self._node_json(k.id) for k in kids]
        return node

    def stats(self) -> Dict:
        ram_cps = [c for c in self.checkpoints.values() if c.tier == "ram"]
        zfs_cps = [c for c in self.checkpoints.values() if c.tier == "zfs"]
        return {
            "ram": {
                "usedBytes": self.ram_usage_bytes,
                "limitBytes": KV_RAM_LIMIT_MB * 1024 * 1024,
                "checkpoints": len(ram_cps),
            },
            "zfs": {
                "dataset": self.zfs_dataset,
                "checkpoints": len(zfs_cps),
            },
            "totalCheckpoints": len(self.checkpoints),
        }


kv_tree = KVTree()


# ============================================================================
# U BINARY COMMUNICATION
# ============================================================================

class UBinaryClient:
    """Communicates with the U runtime over its Unix socket.

    The U binary speaks a simple JSON-line protocol:
      Request:  {"action": "...", ...}\n
      Response: {"ok": true, ...}\n  or  {"ok": false, "error": "..."}\n
    """

    def __init__(self, socket_path: str):
        self.socket_path = socket_path
        self._client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            transport = httpx.AsyncHTTPTransport(uds=self.socket_path)
            self._client = httpx.AsyncClient(
                transport=transport, base_url="http://u-omni"
            )
        return self._client

    async def chat(self, body: Dict, headers: Dict[str, str]) -> Dict:
        client = await self._get_client()
        resp = await client.post(
            "/v1/chat", json=body, headers=headers, timeout=120.0
        )
        resp.raise_for_status()
        return resp.json()

    async def complete(self, body: Dict, headers: Dict[str, str]) -> Dict:
        client = await self._get_client()
        resp = await client.post(
            "/v1/complete", json=body, headers=headers, timeout=120.0
        )
        resp.raise_for_status()
        return resp.json()

    async def kv_save(self, checkpoint_id: str, tier: str, name: str = "") -> Dict:
        """Tell the U binary to save its current KV state."""
        client = await self._get_client()
        resp = await client.post(
            "/v1/internal/kv/save",
            json={"checkpointId": checkpoint_id, "tier": tier, "name": name},
            timeout=30.0,
        )
        resp.raise_for_status()
        return resp.json()

    async def kv_load(self, checkpoint_id: str) -> Dict:
        """Tell the U binary to restore a KV state."""
        client = await self._get_client()
        resp = await client.post(
            "/v1/internal/kv/load",
            json={"checkpointId": checkpoint_id},
            timeout=30.0,
        )
        resp.raise_for_status()
        return resp.json()

    async def kv_fork(self, source_id: str, new_id: str) -> Dict:
        """Tell the U binary to fork a KV state (RAM CoW)."""
        client = await self._get_client()
        resp = await client.post(
            "/v1/internal/kv/fork",
            json={"sourceId": source_id, "newId": new_id},
            timeout=10.0,
        )
        resp.raise_for_status()
        return resp.json()

    async def kv_graft(self, source_id: str, target_id: str, new_id: str) -> Dict:
        """Graft source's extension onto target's prefix."""
        client = await self._get_client()
        resp = await client.post(
            "/v1/internal/kv/graft",
            json={"sourceId": source_id, "targetId": target_id, "newId": new_id},
            timeout=30.0,
        )
        resp.raise_for_status()
        return resp.json()

    async def kv_delete(self, checkpoint_id: str) -> Dict:
        """Delete a KV state from the U binary's memory."""
        client = await self._get_client()
        resp = await client.post(
            "/v1/internal/kv/delete",
            json={"checkpointId": checkpoint_id},
            timeout=10.0,
        )
        resp.raise_for_status()
        return resp.json()

    async def health(self) -> Dict:
        client = await self._get_client()
        resp = await client.get("/v1/healthz", timeout=5.0)
        return resp.json()

    async def close(self):
        if self._client:
            await self._client.aclose()
            self._client = None


u_binary = UBinaryClient(U_SOCKET_PATH)


# ============================================================================
# ZFS OPERATIONS
# ============================================================================

async def zfs_snapshot(checkpoint_id: str) -> bool:
    """Create a ZFS snapshot for a KV checkpoint."""
    snap_name = f"{KV_ZFS_DATASET}@kv-{checkpoint_id}"
    proc = await asyncio.create_subprocess_exec(
        "zfs", "snapshot", snap_name,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        logger.error("zfs snapshot failed: %s", stderr.decode())
        return False
    return True


async def zfs_clone(source_id: str, new_id: str) -> bool:
    """Clone a ZFS snapshot to create a new branch."""
    snap_name = f"{KV_ZFS_DATASET}@kv-{source_id}"
    clone_name = f"{KV_ZFS_DATASET}/kv-{new_id}"
    proc = await asyncio.create_subprocess_exec(
        "zfs", "clone", snap_name, clone_name,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        logger.error("zfs clone failed: %s", stderr.decode())
        return False
    return True


async def zfs_destroy(checkpoint_id: str, is_clone: bool = False) -> bool:
    """Destroy a ZFS snapshot or clone."""
    if is_clone:
        name = f"{KV_ZFS_DATASET}/kv-{checkpoint_id}"
    else:
        name = f"{KV_ZFS_DATASET}@kv-{checkpoint_id}"
    proc = await asyncio.create_subprocess_exec(
        "zfs", "destroy", name,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        logger.error("zfs destroy failed: %s", stderr.decode())
        return False
    return True


# ============================================================================
# REQUEST MODELS
# ============================================================================

class ChatRequest(BaseModel):
    model: str
    messages: List[Dict[str, str]]
    maxTokens: Optional[int] = 2048
    temperature: Optional[float] = 0.7
    topP: Optional[float] = None
    stop: Optional[List[str]] = None
    stream: Optional[bool] = False
    # Multimodal inputs (u-omni native)
    images: Optional[List[Dict[str, str]]] = None  # [{"url": "..."} or {"base64": "..."}]
    audio: Optional[Dict[str, str]] = None  # {"url": "..."} or {"base64": "..."}


class CompleteRequest(BaseModel):
    model: str
    prompt: str
    maxTokens: Optional[int] = 2048
    temperature: Optional[float] = 0.7
    topP: Optional[float] = None
    stop: Optional[List[str]] = None
    stream: Optional[bool] = False


class KVSaveRequest(BaseModel):
    name: Optional[str] = None
    tier: str = Field("auto", pattern=r"^(ram|zfs|auto)$")
    metadata: Dict[str, Any] = {}


class KVLoadRequest(BaseModel):
    checkpointId: str


class KVForkRequest(BaseModel):
    checkpointId: str
    name: Optional[str] = None


class KVGraftRequest(BaseModel):
    sourceId: str
    targetId: str
    name: Optional[str] = None


# ============================================================================
# FASTAPI APP
# ============================================================================

app = FastAPI(title="U-Omni Runner", version="1.0.0")


# ============================================================================
# MIDDLEWARE: HMAC VERIFICATION
# ============================================================================

@app.middleware("http")
async def hmac_middleware(request: Request, call_next):
    """Verify HMAC on all POST requests."""
    if request.method == "POST":
        body = await request.body()
        if not verify_hmac(request, body):
            return Response(
                content=json.dumps({"error": "HMAC verification failed"}),
                status_code=401,
                media_type="application/json",
            )
    return await call_next(request)


# ============================================================================
# STANDARD SAFEBOX ENDPOINTS
# ============================================================================

@app.post("/v1/chat")
async def safebox_chat(
    request: Request,
    x_safebox_request_id: str = Header(..., alias="X-Safebox-Request-Id"),
    x_safebox_tenant: Optional[str] = Header("default", alias="X-Safebox-Tenant"),
    x_safebox_cache_mode: Optional[str] = Header(None, alias="X-Safebox-Cache-Mode"),
    x_safebox_kv_checkpoint: Optional[str] = Header(None, alias="X-Safebox-KV-Checkpoint"),
    x_safebox_kv_save: Optional[str] = Header(None, alias="X-Safebox-KV-Save"),
    x_safebox_kv_tier: Optional[str] = Header("auto", alias="X-Safebox-KV-Tier"),
    response: Response = None,
):
    """Safebox canonical chat endpoint.

    Hot path: request arrives → U binary fork()s → child gets CoW copy
    of KV cache → runs inference → responds → child exits.

    Optional KV integration via headers:
      X-Safebox-KV-Checkpoint: <id>  — start from this cached KV state
      X-Safebox-KV-Save: <name>      — save resulting KV after inference
      X-Safebox-KV-Tier: ram|zfs|auto — which tier to save to
    """
    start_time = time.time()
    body = await request.json()

    # Build headers for U binary
    u_headers = {"X-Safebox-Request-Id": x_safebox_request_id}
    if x_safebox_kv_checkpoint:
        u_headers["X-Safebox-KV-Checkpoint"] = x_safebox_kv_checkpoint
    if x_safebox_kv_save:
        u_headers["X-Safebox-KV-Save"] = x_safebox_kv_save
        u_headers["X-Safebox-KV-Tier"] = x_safebox_kv_tier or "auto"

    try:
        result = await u_binary.chat(body, u_headers)

        compute_ms = int((time.time() - start_time) * 1000)

        # Track KV checkpoint if saved
        if x_safebox_kv_save and result.get("kvCheckpointId"):
            cp_id = result["kvCheckpointId"]
            tier = result.get("kvTier", "ram")
            cp = KVCheckpoint(
                id=cp_id,
                name=x_safebox_kv_save,
                parentId=x_safebox_kv_checkpoint,
                tier=tier,
                tokenCount=result.get("kvTokenCount", 0),
                sizeBytes=result.get("kvSizeBytes", 0),
                modelId=body.get("model", MODEL_NAME),
                created=time.time(),
            )
            kv_tree.add(cp)

        # Safebox response headers
        response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
        response.headers["X-Safebox-Runner-Id"] = RUNNER_ID
        response.headers["X-Safebox-Model-Id"] = body.get("model", MODEL_NAME)
        response.headers["X-Safebox-Compute-Ms"] = str(compute_ms)
        response.headers["X-Safebox-Capacity-Hint"] = "available"

        if result.get("kvCheckpointId"):
            response.headers["X-Safebox-KV-Checkpoint-Id"] = result["kvCheckpointId"]
            response.headers["X-Safebox-KV-Tier"] = result.get("kvTier", "ram")

        # Cache info
        cache_hit = x_safebox_kv_checkpoint is not None
        response.headers["X-Safebox-Cache-Hit"] = "true" if cache_hit else "false"
        response.headers["X-Safebox-Cache-Tokens-Reused"] = str(
            result.get("kvTokenCount", 0) if cache_hit else 0
        )

        return result

    except httpx.HTTPStatusError as e:
        response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
        raise HTTPException(status_code=e.response.status_code, detail=str(e))
    except Exception as e:
        logger.error("Chat error: %s", e)
        response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/v1/complete")
async def safebox_complete(
    request: Request,
    x_safebox_request_id: str = Header(..., alias="X-Safebox-Request-Id"),
    x_safebox_tenant: Optional[str] = Header("default", alias="X-Safebox-Tenant"),
    response: Response = None,
):
    """Safebox canonical completion endpoint."""
    start_time = time.time()
    body = await request.json()

    try:
        result = await u_binary.complete(
            body, {"X-Safebox-Request-Id": x_safebox_request_id}
        )
        compute_ms = int((time.time() - start_time) * 1000)

        response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
        response.headers["X-Safebox-Runner-Id"] = RUNNER_ID
        response.headers["X-Safebox-Model-Id"] = body.get("model", MODEL_NAME)
        response.headers["X-Safebox-Compute-Ms"] = str(compute_ms)
        response.headers["X-Safebox-Capacity-Hint"] = "available"
        response.headers["X-Safebox-Cache-Hit"] = "false"
        response.headers["X-Safebox-Cache-Tokens-Reused"] = "0"

        return result

    except Exception as e:
        logger.error("Complete error: %s", e)
        response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# KV CACHE TREE API
# ============================================================================

@app.post("/v1/kv/save")
async def kv_save(
    req: KVSaveRequest,
    x_safebox_request_id: str = Header(..., alias="X-Safebox-Request-Id"),
    response: Response = None,
):
    """Save the current KV cache state as a named checkpoint.

    tier:
      "ram"  — keep in memory only (fast, ephemeral, CoW via fork)
      "zfs"  — persist to ZFS dataset (slower, durable, CoW via snapshot)
      "auto" — RAM if under threshold, promote to ZFS if large
    """
    cp_id = f"kv-{uuid.uuid4().hex[:12]}"
    tier = req.tier

    # Auto-tier decision
    result = await u_binary.kv_save(cp_id, tier, req.name or "")

    actual_size = result.get("sizeBytes", 0)
    if tier == "auto":
        if actual_size > KV_AUTO_PROMOTE_MB * 1024 * 1024:
            tier = "zfs"
        else:
            tier = "ram"

    # If ZFS tier, create snapshot
    if tier == "zfs":
        if not await zfs_snapshot(cp_id):
            raise HTTPException(status_code=500, detail="ZFS snapshot failed")

    cp = KVCheckpoint(
        id=cp_id,
        name=req.name,
        tier=tier,
        tokenCount=result.get("tokenCount", 0),
        sizeBytes=actual_size,
        modelId=MODEL_NAME,
        created=time.time(),
        metadata=req.metadata,
    )
    kv_tree.add(cp)

    response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
    return cp.dict()


@app.post("/v1/kv/load")
async def kv_load(
    req: KVLoadRequest,
    x_safebox_request_id: str = Header(..., alias="X-Safebox-Request-Id"),
    response: Response = None,
):
    """Restore a checkpoint — load its KV state for the next inference call."""
    cp = kv_tree.get(req.checkpointId)
    if not cp:
        raise HTTPException(status_code=404, detail="Checkpoint not found")

    result = await u_binary.kv_load(req.checkpointId)

    response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
    return {
        "restored": True,
        "checkpointId": req.checkpointId,
        "tier": cp.tier,
        "tokenCount": cp.tokenCount,
    }


@app.post("/v1/kv/fork")
async def kv_fork(
    req: KVForkRequest,
    x_safebox_request_id: str = Header(..., alias="X-Safebox-Request-Id"),
    response: Response = None,
):
    """Fork from a checkpoint, creating a new branch in the tree.

    RAM fork: ~0.1ms via CoW pages.  The new checkpoint shares all
    memory with its parent until either is modified.
    ZFS fork: ~1ms via zfs clone.  The new checkpoint shares all
    blocks with its parent snapshot.
    """
    parent = kv_tree.get(req.checkpointId)
    if not parent:
        raise HTTPException(status_code=404, detail="Source checkpoint not found")

    new_id = f"kv-{uuid.uuid4().hex[:12]}"

    if parent.tier == "ram":
        result = await u_binary.kv_fork(req.checkpointId, new_id)
    else:
        # ZFS clone
        if not await zfs_clone(req.checkpointId, new_id):
            raise HTTPException(status_code=500, detail="ZFS clone failed")
        result = {"sizeBytes": parent.sizeBytes, "tokenCount": parent.tokenCount}

    cp = KVCheckpoint(
        id=new_id,
        name=req.name,
        parentId=req.checkpointId,
        tier=parent.tier,
        tokenCount=result.get("tokenCount", parent.tokenCount),
        sizeBytes=result.get("sizeBytes", parent.sizeBytes),
        modelId=parent.modelId,
        created=time.time(),
    )
    kv_tree.add(cp)

    response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
    return cp.dict()


@app.post("/v1/kv/graft")
async def kv_graft(
    req: KVGraftRequest,
    x_safebox_request_id: str = Header(..., alias="X-Safebox-Request-Id"),
    response: Response = None,
):
    """Graft: take the token extension from source and apply it onto
    target's prefix, producing a new checkpoint.

    Use case: you have a long system prompt cached (target) and a
    conversation that was built on a different prefix (source).  Grafting
    re-roots the conversation's unique tokens onto the cached prefix,
    avoiding redundant KV computation.
    """
    source = kv_tree.get(req.sourceId)
    target = kv_tree.get(req.targetId)
    if not source:
        raise HTTPException(status_code=404, detail="Source checkpoint not found")
    if not target:
        raise HTTPException(status_code=404, detail="Target checkpoint not found")

    new_id = f"kv-{uuid.uuid4().hex[:12]}"
    result = await u_binary.kv_graft(req.sourceId, req.targetId, new_id)

    cp = KVCheckpoint(
        id=new_id,
        name=req.name,
        parentId=req.targetId,
        tier=result.get("tier", "ram"),
        tokenCount=result.get("tokenCount", 0),
        sizeBytes=result.get("sizeBytes", 0),
        modelId=target.modelId,
        created=time.time(),
    )
    kv_tree.add(cp)

    response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
    return cp.dict()


@app.post("/v1/kv/promote")
async def kv_promote(
    req: KVLoadRequest,  # reuse — just needs checkpointId
    x_safebox_request_id: str = Header(..., alias="X-Safebox-Request-Id"),
    response: Response = None,
):
    """Promote a RAM checkpoint to ZFS (persist it to disk).

    The RAM copy remains active.  The ZFS snapshot becomes the durable
    backing store.  On next boot, this checkpoint loads from ZFS instead
    of being recomputed.
    """
    cp = kv_tree.get(req.checkpointId)
    if not cp:
        raise HTTPException(status_code=404, detail="Checkpoint not found")
    if cp.tier == "zfs":
        return {"promoted": False, "reason": "Already on ZFS", "checkpointId": cp.id}

    if not await zfs_snapshot(req.checkpointId):
        raise HTTPException(status_code=500, detail="ZFS snapshot failed")

    cp.tier = "zfs"
    response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
    return {"promoted": True, "checkpointId": cp.id, "tier": "zfs"}


@app.post("/v1/kv/evict")
async def kv_evict(
    req: KVLoadRequest,
    x_safebox_request_id: str = Header(..., alias="X-Safebox-Request-Id"),
    response: Response = None,
):
    """Evict a checkpoint from RAM, keeping only the ZFS copy.

    Used when RAM is under pressure.  The checkpoint remains in the
    tree (tier changes to "zfs") and can be loaded back with /v1/kv/load.
    """
    cp = kv_tree.get(req.checkpointId)
    if not cp:
        raise HTTPException(status_code=404, detail="Checkpoint not found")
    if cp.tier != "ram":
        return {"evicted": False, "reason": "Not in RAM"}

    # Ensure ZFS backing exists
    if not await zfs_snapshot(req.checkpointId):
        raise HTTPException(
            status_code=500, detail="Cannot evict — ZFS snapshot failed"
        )

    # Tell U binary to free RAM
    await u_binary.kv_delete(req.checkpointId)
    kv_tree.ram_usage_bytes -= cp.sizeBytes
    cp.tier = "zfs"

    response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
    return {"evicted": True, "checkpointId": cp.id, "tier": "zfs"}


@app.delete("/v1/kv/checkpoint/{checkpoint_id}")
async def kv_delete(
    checkpoint_id: str,
    cascade: bool = False,
    x_safebox_request_id: str = Header(..., alias="X-Safebox-Request-Id"),
    response: Response = None,
):
    """Delete a checkpoint (and optionally its entire subtree).

    cascade=false: fails if the checkpoint has children.
    cascade=true:  deletes the checkpoint and all descendants.
    """
    cp = kv_tree.get(checkpoint_id)
    if not cp:
        raise HTTPException(status_code=404, detail="Checkpoint not found")

    children = kv_tree.children(checkpoint_id)
    if children and not cascade:
        raise HTTPException(
            status_code=409,
            detail=f"Checkpoint has {len(children)} children. Use ?cascade=true to delete subtree.",
        )

    # Collect IDs to delete
    ids_to_delete = kv_tree.subtree_ids(checkpoint_id) if cascade else [checkpoint_id]

    deleted = []
    for cid in ids_to_delete:
        c = kv_tree.get(cid)
        if not c:
            continue
        # Delete from U binary (RAM) or ZFS
        if c.tier == "ram":
            await u_binary.kv_delete(cid)
        else:
            await zfs_destroy(cid)
        kv_tree.remove(cid)
        deleted.append(cid)

    response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
    return {"deleted": deleted, "count": len(deleted)}


@app.get("/v1/kv/checkpoints")
async def kv_list(
    parentId: Optional[str] = None,
    tier: Optional[str] = None,
    x_safebox_request_id: str = Header("", alias="X-Safebox-Request-Id"),
    response: Response = None,
):
    """List checkpoints, optionally filtered by parent or tier."""
    cps = list(kv_tree.checkpoints.values())
    if parentId is not None:
        cps = [c for c in cps if c.parentId == parentId]
    if tier:
        cps = [c for c in cps if c.tier == tier]
    response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
    return {"checkpoints": [c.dict() for c in cps]}


@app.get("/v1/kv/tree")
async def kv_get_tree(
    x_safebox_request_id: str = Header("", alias="X-Safebox-Request-Id"),
    response: Response = None,
):
    """Return the full KV cache tree as nested JSON."""
    response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
    return {"tree": kv_tree.tree_json()}


@app.get("/v1/kv/stats")
async def kv_get_stats(
    x_safebox_request_id: str = Header("", alias="X-Safebox-Request-Id"),
    response: Response = None,
):
    """Return memory/storage usage for both tiers."""
    response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
    return kv_tree.stats()


# ============================================================================
# CAPABILITIES & HEALTH
# ============================================================================

@app.get("/v1/capabilities")
async def get_capabilities():
    return {
        "runnerId": RUNNER_ID,
        "serviceId": SERVICE_ID,
        "runnerType": "u-omni",
        "protocols": {
            "llm": {"chat": True, "completion": True, "embedding": False},
        },
        "models": {"loaded": [MODEL_NAME]},
        "transport": {
            "socket": {
                "enabled": ENABLE_UNIX_SOCKET,
                "path": SAFEBOX_SOCKET_PATH if ENABLE_UNIX_SOCKET else None,
            }
        },
        "features": {
            "multimodal": True,
            "modalities": ["text", "vision", "audio"],
            "kvCacheTree": True,
            "kvTiers": ["ram", "zfs"],
            "fork": True,
            "prefixCaching": True,
            "hmacSigning": True,
            "streaming": False,
        },
        "kvCache": kv_tree.stats(),
    }


@app.get("/v1/healthz")
async def healthz():
    try:
        u_health = await u_binary.health()
        return {
            "status": "ok",
            "runnerId": RUNNER_ID,
            "uBinary": u_health,
            "kvCheckpoints": len(kv_tree.checkpoints),
        }
    except Exception as e:
        return {"status": "unhealthy", "runnerId": RUNNER_ID, "error": str(e)}


@app.get("/v1/capacity")
async def get_capacity():
    return {
        "capacityHint": "available",
        "kvRamUsedMB": kv_tree.ram_usage_bytes // (1024 * 1024),
        "kvRamLimitMB": KV_RAM_LIMIT_MB,
        "kvCheckpoints": len(kv_tree.checkpoints),
    }


# ============================================================================
# UNIX SOCKET SETUP
# ============================================================================

def setup_unix_socket():
    if not ENABLE_UNIX_SOCKET:
        return None
    socket_path = Path(SAFEBOX_SOCKET_PATH)
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    if socket_path.exists():
        socket_path.unlink()
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(str(socket_path))
    os.chmod(str(socket_path), stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IWGRP)
    try:
        import grp
        gid = grp.getgrnam("safebox-services").gr_gid
        os.chown(str(socket_path), -1, gid)
    except Exception:
        pass
    logger.info("Socket ready: %s", socket_path)
    return sock


# ============================================================================
# STARTUP / SHUTDOWN
# ============================================================================

@app.on_event("startup")
async def startup():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logger.info("U-Omni runner starting — RUNNER_ID=%s", RUNNER_ID)
    if ENABLE_UNIX_SOCKET:
        setup_unix_socket()

    # Wait for U binary
    for i in range(30):
        try:
            await u_binary.health()
            logger.info("U binary ready")
            break
        except Exception:
            if i == 29:
                logger.error("U binary not responding after 30s")
            await asyncio.sleep(1)


@app.on_event("shutdown")
async def shutdown():
    await u_binary.close()


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    if ENABLE_UNIX_SOCKET:
        uvicorn.run(app, uds=SAFEBOX_SOCKET_PATH, log_level="info")
    else:
        uvicorn.run(app, host="127.0.0.1", port=7790, log_level="info")
