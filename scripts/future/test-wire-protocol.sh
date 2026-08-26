#!/bin/bash
set -euo pipefail

# Integration Test for Safebox Wire Protocol v1.1
# Verifies all three fixes from the requirements document

SOCKET_PATH="${1:-/run/safebox/services/model-llm-1.sock}"
TEST_REQUEST_ID="test-$(date +%s)"

log() {
    echo "[$(date +'%H:%M:%S')] $*"
}

error() {
    echo "[ERROR] $*" >&2
    exit 1
}

# Check if socket exists
if [ ! -S "$SOCKET_PATH" ]; then
    error "Unix socket not found: $SOCKET_PATH"
fi

log "=== Safebox Wire Protocol v1.1 Integration Test ==="
log "Socket: $SOCKET_PATH"
log "Request ID: $TEST_REQUEST_ID"
log ""

# ============================================================================
# TEST 1: Canonical /v1/chat endpoint with X-Safebox-* headers
# ============================================================================

log "TEST 1: POST /v1/chat with Safebox headers"

RESPONSE=$(curl --unix-socket "$SOCKET_PATH" \
    -X POST \
    http://localhost/v1/chat \
    -H "Content-Type: application/json" \
    -H "X-Safebox-Request-Id: $TEST_REQUEST_ID" \
    -H "X-Safebox-Tenant: test-tenant" \
    -H "X-Safebox-Cache-Mode: prefix" \
    -d '{
        "model": "meta-llama/Llama-3.1-8B-Instruct",
        "messages": [{"role": "user", "content": "Say hello"}],
        "maxTokens": 50,
        "temperature": 0.7
    }' \
    -w "\n%{http_code}\n%{header_json}" \
    -s)

HTTP_CODE=$(echo "$RESPONSE" | tail -2 | head -1)
HEADERS=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -2)

log "HTTP Status: $HTTP_CODE"

# Check HTTP 200
if [ "$HTTP_CODE" != "200" ]; then
    error "Expected HTTP 200, got $HTTP_CODE"
fi
log "✓ HTTP 200 OK"

# Check body shape (flat, camelCase)
if ! echo "$BODY" | jq -e '.model' > /dev/null; then
    error "Response missing 'model' field"
fi
log "✓ Response has 'model' field"

if ! echo "$BODY" | jq -e '.content' > /dev/null; then
    error "Response missing 'content' field"
fi
log "✓ Response has 'content' field"

if ! echo "$BODY" | jq -e '.role' > /dev/null; then
    error "Response missing 'role' field"
fi
log "✓ Response has 'role' field"

if ! echo "$BODY" | jq -e '.finishReason' > /dev/null; then
    error "Response missing 'finishReason' field (camelCase)"
fi
log "✓ Response has 'finishReason' field (camelCase)"

if ! echo "$BODY" | jq -e '.usage.promptTokens' > /dev/null; then
    error "Response missing 'usage.promptTokens' field (camelCase)"
fi
log "✓ Response has 'usage.promptTokens' field (camelCase)"

# Check for nested OpenAI format (should NOT have this)
if echo "$BODY" | jq -e '.choices' > /dev/null 2>&1; then
    error "Response has nested 'choices' array (OpenAI format, should be flat)"
fi
log "✓ Response is FLAT (not nested OpenAI format)"

# ============================================================================
# TEST 2: X-Safebox-Request-Id echo
# ============================================================================

log ""
log "TEST 2: X-Safebox-Request-Id echo"

ECHOED_REQUEST_ID=$(echo "$HEADERS" | jq -r '.["x-safebox-request-id"] // empty')

if [ -z "$ECHOED_REQUEST_ID" ]; then
    error "Response missing X-Safebox-Request-Id header"
fi
log "✓ Response has X-Safebox-Request-Id header"

if [ "$ECHOED_REQUEST_ID" != "$TEST_REQUEST_ID" ]; then
    error "Request ID not echoed correctly (sent: $TEST_REQUEST_ID, received: $ECHOED_REQUEST_ID)"
fi
log "✓ Request ID echoed correctly: $TEST_REQUEST_ID"

# ============================================================================
# TEST 3: X-Safebox-* header prefix on all telemetry headers
# ============================================================================

log ""
log "TEST 3: X-Safebox-* header prefix"

# Check each required header
REQUIRED_HEADERS=(
    "x-safebox-request-id"
    "x-safebox-runner-id"
    "x-safebox-model-id"
    "x-safebox-cache-hit"
    "x-safebox-cache-tokens-reused"
    "x-safebox-queue-wait-ms"
    "x-safebox-compute-ms"
    "x-safebox-capacity-hint"
)

for HEADER in "${REQUIRED_HEADERS[@]}"; do
    VALUE=$(echo "$HEADERS" | jq -r ".\"$HEADER\" // empty")
    
    if [ -z "$VALUE" ]; then
        error "Missing header: $HEADER"
    fi
    
    log "✓ $HEADER: $VALUE"
done

# Check for WRONG headers (without X-Safebox- prefix)
WRONG_HEADERS=(
    "x-cache-hit"
    "x-cache-mode"
    "x-tenant-id"
    "x-gpu-time-ms"
    "cache-hit"
    "runner-id"
)

for HEADER in "${WRONG_HEADERS[@]}"; do
    VALUE=$(echo "$HEADERS" | jq -r ".\"$HEADER\" // empty")
    
    if [ -n "$VALUE" ]; then
        error "Found header without X-Safebox- prefix: $HEADER (should be x-safebox-*)"
    fi
done

log "✓ All headers use X-Safebox-* prefix"

# ============================================================================
# TEST 4: /v1/capabilities endpoint
# ============================================================================

log ""
log "TEST 4: GET /v1/capabilities"

CAPS_RESPONSE=$(curl --unix-socket "$SOCKET_PATH" \
    -X GET \
    http://localhost/v1/capabilities \
    -s)

if ! echo "$CAPS_RESPONSE" | jq -e '.protocols.llm.chat' > /dev/null; then
    error "Capabilities missing protocols.llm.chat"
fi
log "✓ Capabilities include protocols.llm.chat"

if ! echo "$CAPS_RESPONSE" | jq -e '.transport.socket.path' > /dev/null; then
    error "Capabilities missing transport.socket.path"
fi
log "✓ Capabilities include transport.socket.path"

SOCKET_PATH_FROM_CAPS=$(echo "$CAPS_RESPONSE" | jq -r '.transport.socket.path')
log "  Socket path from capabilities: $SOCKET_PATH_FROM_CAPS"

# ============================================================================
# TEST 5: OpenAI-compat alias still works
# ============================================================================

log ""
log "TEST 5: OpenAI-compat alias /v1/chat/completions"

OPENAI_RESPONSE=$(curl --unix-socket "$SOCKET_PATH" \
    -X POST \
    http://localhost/v1/chat/completions \
    -H "Content-Type: application/json" \
    -H "X-Safebox-Request-Id: openai-test-$TEST_REQUEST_ID" \
    -d '{
        "model": "meta-llama/Llama-3.1-8B-Instruct",
        "messages": [{"role": "user", "content": "Hi"}],
        "max_tokens": 10
    }' \
    -w "\n%{http_code}" \
    -s)

OPENAI_HTTP_CODE=$(echo "$OPENAI_RESPONSE" | tail -1)
OPENAI_BODY=$(echo "$OPENAI_RESPONSE" | head -n -1)

if [ "$OPENAI_HTTP_CODE" != "200" ]; then
    error "OpenAI-compat endpoint failed: HTTP $OPENAI_HTTP_CODE"
fi
log "✓ OpenAI-compat endpoint works: HTTP 200"

# Check for nested format (OpenAI)
if ! echo "$OPENAI_BODY" | jq -e '.choices[0].message.content' > /dev/null; then
    error "OpenAI-compat endpoint missing nested format"
fi
log "✓ OpenAI-compat endpoint returns nested format"

# ============================================================================
# SUMMARY
# ============================================================================

log ""
log "=== ALL TESTS PASSED ==="
log ""
log "✅ FIX 1: Canonical /v1/chat endpoint works"
log "✅ FIX 2: X-Safebox-* header prefix on all headers"
log "✅ FIX 3: X-Safebox-Request-Id echo in every response"
log "✅ BONUS: OpenAI-compat /v1/chat/completions alias works"
log "✅ BONUS: /v1/capabilities returns correct shape"
log ""
log "Wire protocol v1.1 COMPLIANT ✓"
