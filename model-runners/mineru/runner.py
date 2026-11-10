"""
MinerU Document Extraction — Safebox Local Service v1.0

Wraps opendatalab/MinerU as a Safebox protocol-compliant service.

Endpoints:
  POST /v1/extract          — extract one document
  POST /v1/extract/batch    — extract a folder of documents
  GET  /v1/capabilities     — runner capabilities (spec §4)
  GET  /v1/capacity         — current load
  GET  /health              — liveness

Transport: Unix domain socket at /run/safebox/services/{SERVICE_ID}.sock
Auth:      HMAC headers (X-Safebox-Signature, X-Safebox-Nonce, X-Safebox-Timestamp)
           checked when SAFEBOX_REQUIRE_HMAC=true. Off by default for local development.
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
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Set
from urllib.parse import urlparse

from fastapi import FastAPI, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field
import uvicorn


logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# ── Configuration ────────────────────────────────────────────────────────
RUNNER_ID   = os.getenv("RUNNER_ID",   "safebox-mineru-1")
SERVICE_ID  = os.getenv("SERVICE_ID",  "mineru-1")
HMAC_KEY_PATH = os.getenv("HMAC_KEY_PATH", "/etc/safebox/model-api.key")
REQUIRE_HMAC  = os.getenv("SAFEBOX_REQUIRE_HMAC", "false").lower() == "true"

SAFEBOX_SOCKET_PATH = os.getenv("SAFEBOX_SOCKET_PATH",
                                 f"/run/safebox/services/{SERVICE_ID}.sock")
ENABLE_UNIX_SOCKET  = os.getenv("ENABLE_UNIX_SOCKET", "true").lower() == "true"

# MinerU backend selector: "pipeline" (fast, modular) or "vlm" (highest fidelity)
MINERU_BACKEND = os.getenv("MINERU_BACKEND", "pipeline")
MODEL_NAME     = "opendatalab/mineru-2.5"

WORK_DIR = Path(os.getenv("MINERU_WORK_DIR", "/data"))
WORK_DIR.mkdir(parents=True, exist_ok=True)

# Optional HMAC key
try:
    with open(HMAC_KEY_PATH) as f:
        HMAC_KEY = f.read().strip()
except Exception as e:
    if REQUIRE_HMAC:
        logger.error(f"HMAC required but key unavailable: {e}")
        raise
    HMAC_KEY = None
    logger.info("HMAC verification disabled (no key, and SAFEBOX_REQUIRE_HMAC=false)")

# Mutable state
seen_nonces = collections.OrderedDict()  # nonce -> timestamp_sec (insertion-ordered)
request_count = 0
total_pages_processed = 0
in_flight: int = 0


# ── Pydantic models ──────────────────────────────────────────────────────

class ExtractRequest(BaseModel):
    model: str = MODEL_NAME
    source: str = Field(..., description="file:///path or absolute path to source document")
    output: Literal["markdown", "json", "html"] = "markdown"
    extractImages:   bool = True
    extractFormulas: bool = True
    extractTables:   bool = True
    languages: Optional[List[str]] = Field(None, description="ISO codes (e.g. ['en','zh']) — None = autodetect")
    pages:     Optional[str] = Field(None, description="Page range like '1-10,15,20-30'. None = all pages.")
    backend:   Optional[Literal["pipeline", "vlm"]] = None


class ExtractBatchRequest(BaseModel):
    model: str = MODEL_NAME
    sources: List[str]
    output: Literal["markdown", "json", "html"] = "markdown"
    extractImages:   bool = True
    extractFormulas: bool = True
    extractTables:   bool = True
    languages: Optional[List[str]] = None


# ── App ──────────────────────────────────────────────────────────────────
app = FastAPI(title="MinerU Runner", version="1.0")


# ── Unix socket setup ────────────────────────────────────────────────────
def setup_unix_socket():
    if not ENABLE_UNIX_SOCKET:
        return None
    sp = Path(SAFEBOX_SOCKET_PATH)
    sp.parent.mkdir(parents=True, exist_ok=True)
    if sp.exists():
        logger.info(f"Removing stale socket: {sp}")
        sp.unlink()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(str(sp))
    os.chmod(str(sp), stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IWGRP)
    try:
        import grp, pwd
        gid = grp.getgrnam("safebox-services").gr_gid
        uid = pwd.getpwnam("safebox-services").pw_uid
        os.chown(str(sp), uid, gid)
    except Exception as e:
        logger.warning(f"Could not set socket ownership: {e}")
    logger.info(f"Unix socket ready: {sp}")
    return s


# ── HMAC verification (optional) ─────────────────────────────────────────

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
class MinerURunner:
    """Lazily import MinerU at first use so the import cost is paid after the
    health check is responsive."""
    def __init__(self):
        self.ready = False
        self.backend = MINERU_BACKEND
        self._extract_fn = None

    def load(self):
        if self.ready:
            return
        logger.info(f"Loading MinerU backend={self.backend}")
        try:
            # MinerU 2.x exposes a high-level `do_parse` callable that takes
            # a list of PDF paths and produces results in an output dir.
            # Lower-level dataset readers handle DOCX/PPTX/XLSX/images.
            from mineru.cli.common import do_parse, read_fn  # type: ignore
            self._do_parse = do_parse
            self._read_fn  = read_fn
            self.ready = True
            logger.info("MinerU ready")
        except Exception as e:
            logger.error(f"Failed to import MinerU: {e}")
            raise

    def _resolve_source(self, source: str) -> Path:
        """Accept file:// URLs and bare paths. Reject anything else."""
        if source.startswith("file://"):
            p = Path(urlparse(source).path)
        elif source.startswith(("http://", "https://", "s3://")):
            raise ValueError("Network sources are not supported. "
                             "Stage the file into the Safebox first.")
        else:
            p = Path(source)
        if not p.is_absolute():
            raise ValueError(f"Source must be an absolute path: {source}")
        if not p.exists():
            raise FileNotFoundError(str(p))
        return p

    def extract(self, req: ExtractRequest) -> Dict[str, Any]:
        """Extract a single document. Returns the canonical response shape."""
        self.load()
        src = self._resolve_source(req.source)

        # Compute SHA-256 for audit trail
        h = hashlib.sha256()
        with open(src, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        source_sha256 = h.hexdigest()

        # Stage the parse into a per-request scratch dir
        out_dir = Path(tempfile.mkdtemp(prefix="mineru-", dir=str(WORK_DIR)))
        backend = req.backend or self.backend
        langs   = req.languages or ["en"]
        pdf_bytes = self._read_fn(src)

        t0 = time.time()
        self._do_parse(
            output_dir=str(out_dir),
            pdf_file_names=[src.stem],
            pdf_bytes_list=[pdf_bytes],
            p_lang_list=[langs[0] if langs else "en"],
            backend=backend,
            parse_method="auto",
            formula_enable=req.extractFormulas,
            table_enable=req.extractTables,
        )
        elapsed_ms = int((time.time() - t0) * 1000)

        # MinerU writes per-file outputs into out_dir/{stem}/{backend}/...
        # We collect markdown + the structured JSON (content_list).
        stem_dir = out_dir / src.stem / backend
        markdown_path = stem_dir / f"{src.stem}.md"
        content_list_path = stem_dir / f"{src.stem}_content_list.json"

        markdown = markdown_path.read_text() if markdown_path.exists() else ""
        try:
            blocks = json.loads(content_list_path.read_text()) if content_list_path.exists() else []
        except Exception:
            blocks = []

        # Compute output hash for audit
        out_h = hashlib.sha256(markdown.encode("utf-8")).hexdigest()

        # Page count: MinerU exposes this in the json; fall back to counting "page" entries
        page_count = 0
        for b in blocks:
            if isinstance(b, dict) and isinstance(b.get("page_idx"), int):
                page_count = max(page_count, b["page_idx"] + 1)

        response: Dict[str, Any] = {
            "model": req.model,
            "backend": backend,
            "pageCount": page_count,
            "sourceSha256": source_sha256,
            "outputSha256": out_h,
        }
        if req.output == "markdown":
            response["markdown"] = markdown
        elif req.output == "json":
            response["blocks"] = blocks
        elif req.output == "html":
            # MinerU doesn't ship HTML directly; convert markdown → very simple HTML.
            response["html"] = _markdown_to_html(markdown)

        # Always include block summary for downstream pipelines
        response["blocks"] = blocks if "blocks" not in response else response["blocks"]
        response["usage"] = {
            "pagesProcessed": page_count,
            "elapsedMs": elapsed_ms,
        }
        return response


def _markdown_to_html(md: str) -> str:
    """Tiny, dependency-free Markdown-to-HTML for the HTML output mode.
    For full fidelity, use the markdown output and run it through a library
    of your choice downstream."""
    lines = md.split("\n")
    out = []
    in_code = False
    for line in lines:
        if line.startswith("```"):
            in_code = not in_code
            out.append("<pre>" if in_code else "</pre>")
            continue
        if in_code:
            out.append(line); continue
        if line.startswith("# "):    out.append(f"<h1>{line[2:]}</h1>")
        elif line.startswith("## "): out.append(f"<h2>{line[3:]}</h2>")
        elif line.startswith("### "):out.append(f"<h3>{line[4:]}</h3>")
        elif line.strip() == "":     out.append("")
        else:                        out.append(f"<p>{line}</p>")
    return "\n".join(out)


mineru_runner = MinerURunner()


# ── Capabilities & capacity ──────────────────────────────────────────────
@app.get("/v1/capabilities")
async def capabilities():
    transport: Dict[str, Any] = {}
    if ENABLE_UNIX_SOCKET:
        transport["socket"] = {
            "path": SAFEBOX_SOCKET_PATH,
            "permissions": "0660",
            "group": "safebox-services",
        }
    return {
        "version": "1.0",
        "runnerType": "document-extraction",
        "runnerId": RUNNER_ID,
        "serviceId": SERVICE_ID,
        "transport": transport,
        "models": {
            "loaded": [MODEL_NAME] if mineru_runner.ready else [],
            "loading": [] if mineru_runner.ready else [MODEL_NAME],
            "available": [MODEL_NAME],
            "backend": mineru_runner.backend,
        },
        "capabilities": {
            "inputFormats":  ["pdf", "docx", "pptx", "xlsx", "png", "jpg", "tiff"],
            "outputFormats": ["markdown", "json", "html"],
            "languages":     109,
            "tables":        True,
            "formulas":      True,
            "ocr":           True,
            "multiColumn":   True,
            "readingOrder":  True,
            "batch":         True,
            "maxPages":      10000,
        },
        "health": "healthy" if mineru_runner.ready else "loading",
    }


@app.get("/v1/capacity")
async def capacity():
    return {
        "canAccept": mineru_runner.ready and in_flight < 8,
        "inFlight":  in_flight,
        "requestCount": request_count,
        "pagesProcessed": total_pages_processed,
    }


# ── Extraction endpoints ─────────────────────────────────────────────────
@app.post("/v1/extract")
async def extract(request: Request):
    """Safebox-canonical extraction endpoint.

    Request:  ExtractRequest (see above)
    Response: { model, markdown|json|html, blocks, pageCount, sourceSha256,
                outputSha256, usage }
    """
    global request_count, total_pages_processed, in_flight

    body_bytes = await request.body()
    if not verify_hmac(request, body_bytes):
        raise HTTPException(status_code=401, detail="HMAC verification failed")

    try:
        req = ExtractRequest(**json.loads(body_bytes))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Bad request: {e}")

    request_id = request.headers.get("X-Safebox-Request-Id", str(uuid.uuid4()))

    if not mineru_runner.ready:
        raise HTTPException(status_code=503, detail="Model loading; try again in a moment")

    in_flight += 1
    t0 = time.time()
    try:
        result = await asyncio.to_thread(mineru_runner.extract, req)
        request_count += 1
        total_pages_processed += result.get("pageCount", 0)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=f"Source not found: {e}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Extraction failed")
        raise HTTPException(status_code=500, detail=f"Extraction failed: {e}")
    finally:
        in_flight -= 1

    compute_ms = int((time.time() - t0) * 1000)
    headers = {
        "X-Safebox-Request-Id":   request_id,
        "X-Safebox-Runner-Id":    RUNNER_ID,
        "X-Safebox-Model-Id":     MODEL_NAME,
        "X-Safebox-Compute-Ms":   str(compute_ms),
        "X-Safebox-Capacity-Hint": "available" if in_flight < 4 else "busy",
    }
    return Response(content=json.dumps(result),
                    media_type="application/json",
                    headers=headers)


@app.post("/v1/extract/batch")
async def extract_batch(request: Request):
    """Batch extraction. Runs sequentially within the worker; for parallel
    extraction, run multiple runner containers and round-robin from the
    caller."""
    body_bytes = await request.body()
    if not verify_hmac(request, body_bytes):
        raise HTTPException(status_code=401, detail="HMAC verification failed")
    try:
        batch = ExtractBatchRequest(**json.loads(body_bytes))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Bad request: {e}")

    results = []
    for src in batch.sources:
        try:
            one = ExtractRequest(
                model=batch.model, source=src, output=batch.output,
                extractImages=batch.extractImages,
                extractFormulas=batch.extractFormulas,
                extractTables=batch.extractTables,
                languages=batch.languages,
            )
            r = await asyncio.to_thread(mineru_runner.extract, one)
            results.append({"source": src, "ok": True, "result": r})
        except Exception as e:
            results.append({"source": src, "ok": False, "error": str(e)})
    return {"model": batch.model, "results": results, "count": len(results)}


# ── Health ───────────────────────────────────────────────────────────────
@app.get("/health")
async def health_check():
    return Response(
        content=json.dumps({
            "status": "healthy" if mineru_runner.ready else "loading",
            "modelLoaded": mineru_runner.ready,
            "requestCount": request_count,
            "pagesProcessed": total_pages_processed,
            "inFlight": in_flight,
            "backend": mineru_runner.backend,
        }),
        status_code=200 if mineru_runner.ready else 503,
        media_type="application/json",
    )


# ── Startup ──────────────────────────────────────────────────────────────
@app.on_event("startup")
async def on_startup():
    logger.info(f"Starting MinerU service (backend={MINERU_BACKEND})")
    # Defer the heavy import to a background task so liveness comes up fast
    asyncio.get_event_loop().run_in_executor(None, mineru_runner.load)


# ── Main ─────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    config = uvicorn.Config(app, log_level="info")
    server = uvicorn.Server(config)
    if ENABLE_UNIX_SOCKET:
        setup_unix_socket()
        logger.info(f"Listening on Unix socket: {SAFEBOX_SOCKET_PATH}")
        server.run(uds=str(SAFEBOX_SOCKET_PATH))
    else:
        logger.error("ENABLE_UNIX_SOCKET=false but no other transport configured")
        raise RuntimeError("Enable Unix socket transport")
