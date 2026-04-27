"""
OpenAI Privacy Filter - Safebox Local Service v1.0
Runs privacy-filter model locally as a service
Detects and redacts PII (email, phone, address, SSN, etc.)
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
from pathlib import Path
from typing import Dict, List, Optional, Set

from fastapi import FastAPI, Header, HTTPException, Request, Response
from pydantic import BaseModel
import torch
from transformers import AutoTokenizer, AutoModelForTokenClassification
import uvicorn


logger = logging.getLogger(__name__)

# Configuration
RUNNER_ID = os.getenv('RUNNER_ID', 'safebox-privacy-filter-1')
SERVICE_ID = os.getenv('SERVICE_ID', 'privacy-filter-1')
HMAC_KEY_PATH = os.getenv('HMAC_KEY_PATH', '/etc/safebox/model-api.key')

# Transport configuration
SAFEBOX_SOCKET_PATH = os.getenv('SAFEBOX_SOCKET_PATH', f'/run/safebox/services/{SERVICE_ID}.sock')
ENABLE_UNIX_SOCKET = os.getenv('ENABLE_UNIX_SOCKET', 'true').lower() == 'true'

# Model configuration
MODEL_NAME = "openai/privacy-filter"
MODEL_PATH = os.getenv('MODEL_PATH', '/models/privacy-filter')

# Load HMAC key
try:
    with open(HMAC_KEY_PATH, 'r') as f:
        HMAC_KEY = f.read().strip()
except Exception as e:
    logger.warning(f"Could not load HMAC key from {HMAC_KEY_PATH}: {e}")
    HMAC_KEY = None

# State
seen_nonces: Set[str] = set()
request_count = 0
total_tokens_processed = 0


# ============================================================================
# MODELS
# ============================================================================

class RedactRequest(BaseModel):
    """Safebox-canonical redaction request"""
    model: str
    text: str
    entities: Optional[List[str]] = None  # Which PII types to redact
    mode: str = "redact"  # "redact", "detect", "mask"


class RedactResponse(BaseModel):
    """Safebox-canonical redaction response"""
    model: str
    redactedText: str
    detectedEntities: List[Dict]
    usage: Dict


# ============================================================================
# FASTAPI APP
# ============================================================================

app = FastAPI(title="Privacy Filter Service")


# ============================================================================
# UNIX SOCKET SETUP
# ============================================================================

def setup_unix_socket():
    """Setup Unix domain socket with proper permissions"""
    if not ENABLE_UNIX_SOCKET:
        return None
    
    socket_path = Path(SAFEBOX_SOCKET_PATH)
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Remove stale socket
    if socket_path.exists():
        logger.info(f"Removing stale socket: {socket_path}")
        socket_path.unlink()
    
    # Create Unix socket
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(str(socket_path))
    
    # Set permissions: 0660
    os.chmod(str(socket_path), stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IWGRP)
    
    # Set ownership
    try:
        import grp, pwd
        gid = grp.getgrnam('safebox-services').gr_gid
        uid = pwd.getpwnam('safebox-services').pw_uid
        os.chown(str(socket_path), uid, gid)
        logger.info(f"Socket ownership: safebox-services:safebox-services")
    except Exception as e:
        logger.warning(f"Could not set socket ownership: {e}")
    
    logger.info(f"Unix socket ready: {socket_path}")
    return sock


# ============================================================================
# MODEL LOADING
# ============================================================================

class PrivacyFilterModel:
    def __init__(self):
        self.tokenizer = None
        self.model = None
        self.loaded = False
        
    def load(self):
        """Load privacy filter model"""
        if self.loaded:
            return
        
        logger.info(f"Loading privacy filter model: {MODEL_NAME}")
        
        try:
            self.tokenizer = AutoTokenizer.from_pretrained(
                MODEL_PATH if os.path.exists(MODEL_PATH) else MODEL_NAME
            )
            self.model = AutoModelForTokenClassification.from_pretrained(
                MODEL_PATH if os.path.exists(MODEL_PATH) else MODEL_NAME
            )
            
            # Move to GPU if available
            if torch.cuda.is_available():
                self.model = self.model.cuda()
                logger.info("Model loaded on GPU")
            else:
                logger.info("Model loaded on CPU")
            
            self.loaded = True
            logger.info("Privacy filter ready")
            
        except Exception as e:
            logger.error(f"Failed to load model: {e}")
            raise
    
    def redact(self, text: str, entities: Optional[List[str]] = None, mode: str = "redact"):
        """Detect and redact PII in text"""
        if not self.loaded:
            raise RuntimeError("Model not loaded")
        
        # Tokenize
        inputs = self.tokenizer(text, return_tensors="pt", truncation=True, max_length=512)
        
        if torch.cuda.is_available():
            inputs = {k: v.cuda() for k, v in inputs.items()}
        
        # Inference
        with torch.no_grad():
            outputs = self.model(**inputs)
        
        # Get predictions
        predictions = torch.argmax(outputs.logits, dim=2)
        
        # Convert to entity labels
        tokens = self.tokenizer.convert_ids_to_tokens(inputs["input_ids"][0])
        labels = [self.model.config.id2label[p.item()] for p in predictions[0]]
        
        # Extract entities
        detected = self._extract_entities(tokens, labels, text)
        
        # Filter by requested entity types
        if entities:
            detected = [e for e in detected if e['type'] in entities]
        
        # Redact text
        if mode == "redact":
            redacted_text = self._redact_text(text, detected)
        elif mode == "mask":
            redacted_text = self._mask_text(text, detected)
        else:  # detect only
            redacted_text = text
        
        return {
            "redactedText": redacted_text,
            "detectedEntities": detected,
            "tokensProcessed": len(tokens)
        }
    
    def _extract_entities(self, tokens, labels, original_text):
        """Extract entity spans from token labels"""
        entities = []
        current_entity = None
        
        for i, (token, label) in enumerate(zip(tokens, labels)):
            if label.startswith('B-'):  # Beginning of entity
                if current_entity:
                    entities.append(current_entity)
                
                entity_type = label[2:]  # Remove 'B-' prefix
                current_entity = {
                    'type': entity_type,
                    'start': i,
                    'end': i,
                    'tokens': [token]
                }
                
            elif label.startswith('I-') and current_entity:  # Inside entity
                current_entity['end'] = i
                current_entity['tokens'].append(token)
                
            else:  # Outside entity
                if current_entity:
                    entities.append(current_entity)
                    current_entity = None
        
        if current_entity:
            entities.append(current_entity)
        
        # Convert token positions to character positions (approximate)
        for entity in entities:
            entity['text'] = self.tokenizer.convert_tokens_to_string(entity['tokens'])
        
        return entities
    
    def _redact_text(self, text, entities):
        """Replace entities with [REDACTED]"""
        if not entities:
            return text
        
        # Sort entities by start position (reverse to replace from end)
        sorted_entities = sorted(entities, key=lambda e: -len(e['text']))
        
        redacted = text
        for entity in sorted_entities:
            # Simple replacement (in production, would use character offsets)
            redacted = redacted.replace(entity['text'], f"[REDACTED:{entity['type'].upper()}]")
        
        return redacted
    
    def _mask_text(self, text, entities):
        """Replace entities with masked version (e.g., j***@example.com)"""
        if not entities:
            return text
        
        redacted = text
        for entity in entities:
            original = entity['text']
            
            if entity['type'] == 'email':
                # Mask: j***@example.com
                parts = original.split('@')
                if len(parts) == 2:
                    masked = f"{parts[0][0]}***@{parts[1]}"
                else:
                    masked = "***"
            elif entity['type'] == 'phone':
                # Mask: ***-***-1234
                masked = "***-***-" + original[-4:] if len(original) >= 4 else "***"
            else:
                # Generic mask: first char + ***
                masked = original[0] + "***" if len(original) > 0 else "***"
            
            redacted = redacted.replace(original, masked)
        
        return redacted


# Global model instance
privacy_model = PrivacyFilterModel()


# ============================================================================
# CAPABILITIES ENDPOINT
# ============================================================================

@app.get("/v1/capabilities")
async def get_capabilities():
    """Return runner capabilities (spec §4)"""
    
    transport = {}
    if ENABLE_UNIX_SOCKET:
        transport['socket'] = {
            'path': SAFEBOX_SOCKET_PATH,
            'permissions': '0660',
            'group': 'safebox-services'
        }
    
    return {
        "version": "1.0",
        "runnerType": "privacy-filter",
        "runnerId": RUNNER_ID,
        "serviceId": SERVICE_ID,
        "transport": transport,
        "models": {
            "loaded": [MODEL_NAME] if privacy_model.loaded else [],
            "loading": [],
            "available": [MODEL_NAME]
        },
        "capabilities": {
            "redaction": True,
            "detection": True,
            "masking": True,
            "entityTypes": [
                "name", "email", "phone", "address",
                "ssn", "credit_card", "date_of_birth",
                "ip_address", "url", "organization"
            ]
        },
        "health": "healthy" if privacy_model.loaded else "loading"
    }


@app.get("/v1/capacity")
async def get_capacity():
    """Return current capacity (spec §4)"""
    return {
        "canAccept": privacy_model.loaded,
        "requestCount": request_count,
        "tokensProcessed": total_tokens_processed
    }


# ============================================================================
# SAFEBOX-CANONICAL REDACTION ENDPOINT (spec §4)
# ============================================================================

@app.post("/v1/redact")
async def redact_canonical(request: Request):
    """Safebox-canonical redaction endpoint
    
    Request: { model, text, entities, mode } (camelCase)
    Response: { model, redactedText, detectedEntities, usage } (camelCase)
    """
    global request_count, total_tokens_processed
    
    body = await request.json()
    
    # Extract headers (spec §5)
    request_id = request.headers.get('X-Safebox-Request-Id', '')
    tenant = request.headers.get('X-Safebox-Tenant', 'default')
    
    # Validate model
    if not privacy_model.loaded:
        raise HTTPException(status_code=503, detail="Model not loaded")
    
    # Run redaction
    start_time = time.time()
    result = privacy_model.redact(
        text=body.get('text', ''),
        entities=body.get('entities'),
        mode=body.get('mode', 'redact')
    )
    compute_ms = int((time.time() - start_time) * 1000)
    
    # Update stats
    request_count += 1
    total_tokens_processed += result['tokensProcessed']
    
    # Build response (spec §6 - flat, camelCase)
    response_body = {
        "model": MODEL_NAME,
        "redactedText": result['redactedText'],
        "detectedEntities": result['detectedEntities'],
        "usage": {
            "tokensProcessed": result['tokensProcessed']
        }
    }
    
    # Build response with headers (spec §7)
    response = Response(
        content=json.dumps(response_body),
        media_type="application/json"
    )
    
    # Add Safebox headers
    response.headers['X-Safebox-Request-Id'] = request_id  # Echo back
    response.headers['X-Safebox-Runner-Id'] = RUNNER_ID
    response.headers['X-Safebox-Model-Id'] = MODEL_NAME
    response.headers['X-Safebox-Compute-Ms'] = str(compute_ms)
    response.headers['X-Safebox-Capacity-Hint'] = 'available'  # CPU-based, always available
    
    return response


# ============================================================================
# HEALTH CHECK
# ============================================================================

@app.get("/health")
async def health_check():
    """Health check"""
    status_code = 200 if privacy_model.loaded else 503
    
    return Response(
        content=json.dumps({
            "status": "healthy" if privacy_model.loaded else "loading",
            "modelLoaded": privacy_model.loaded,
            "requestCount": request_count
        }),
        status_code=status_code
    )


# ============================================================================
# STARTUP
# ============================================================================

@app.on_event("startup")
async def startup():
    """Load model on startup"""
    logger.info("Starting Privacy Filter service")
    privacy_model.load()
    logger.info("Service ready")


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    import struct
    
    # Setup transport
    config = uvicorn.Config(app, log_level="info")
    server = uvicorn.Server(config)
    
    if ENABLE_UNIX_SOCKET:
        # Unix socket transport
        unix_sock = setup_unix_socket()
        if unix_sock:
            logger.info(f"Starting server on Unix socket: {SAFEBOX_SOCKET_PATH}")
            server.run(uds=str(SAFEBOX_SOCKET_PATH))
    else:
        logger.error("No transport enabled")
        raise RuntimeError("ENABLE_UNIX_SOCKET must be true")
