"""
Quick in-process tests for the vLLM runner wrapper.

Verifies the translation between Safebox protocol and vLLM/OpenAI shape,
the HMAC verification logic, and the model_matches function. Doesn't
require a real vLLM — just imports the module and exercises functions.

Run:
    cd model-runners/vllm
    MODEL_NAME=qwen-3-32b VLLM_MODEL_ARG=Qwen/Qwen3-32B \
        SAFEBOX_REQUIRE_HMAC=false ENABLE_UNIX_SOCKET=false \
        python3 test_runner.py
"""

import hashlib
import hmac
import json
import os
import sys
import time

# Force test config before import
os.environ.setdefault("MODEL_NAME", "qwen-3-32b")
os.environ.setdefault("VLLM_MODEL_ARG", "Qwen/Qwen3-32B")
os.environ.setdefault("SAFEBOX_REQUIRE_HMAC", "false")
os.environ.setdefault("ENABLE_UNIX_SOCKET", "false")

import runner


# ── Assertions ────────────────────────────────────────────────────────
fails = []
def expect(cond, label):
    if cond:
        print(f"  ✓ {label}")
    else:
        print(f"  ✗ {label}")
        fails.append(label)


# ── model_matches ──────────────────────────────────────────────────────
print("\n── model_matches() ──")
expect(runner.model_matches("qwen-3-32b"),         "canonical name accepted")
expect(runner.model_matches("Qwen/Qwen3-32B"),     "vllm arg accepted")
expect(runner.model_matches("Qwen3-32B"),          "basename of vllm arg accepted")
expect(not runner.model_matches("llama-3.3-70b"),  "wrong model rejected")
expect(not runner.model_matches(""),               "empty model rejected")


# ── Safebox → OpenAI chat translation ──────────────────────────────────
print("\n── _camel_to_openai_chat() ──")
req = runner.ChatRequest(
    model="qwen-3-32b",
    messages=[runner.ChatMessage(role="user", content="hi")],
    maxTokens=512,
    temperature=0.5,
    topP=0.95,
    topK=40,
    stop=["END"],
    stream=True,
    seed=42,
    presencePenalty=0.1,
    frequencyPenalty=0.2,
)
o = runner._camel_to_openai_chat(req)
expect(o["model"] == "Qwen/Qwen3-32B",         "model name swapped to vLLM arg")
expect(o["max_tokens"] == 512,                  "maxTokens → max_tokens")
expect(o["temperature"] == 0.5,                 "temperature passthrough")
expect(o["top_p"] == 0.95,                      "topP → top_p")
expect(o["top_k"] == 40,                        "topK → top_k")
expect(o["stop"] == ["END"],                    "stop passthrough")
expect(o["stream"] is True,                     "stream passthrough")
expect(o["seed"] == 42,                         "seed passthrough")
expect(o["presence_penalty"] == 0.1,            "presencePenalty → presence_penalty")
expect(o["frequency_penalty"] == 0.2,           "frequencyPenalty → frequency_penalty")
expect("top_p" in o and o["top_p"] == 0.95,     "optionals included when set")

# Omitting optionals — they should not appear in the dict
req2 = runner.ChatRequest(
    model="qwen-3-32b",
    messages=[runner.ChatMessage(role="user", content="hi")],
)
o2 = runner._camel_to_openai_chat(req2)
expect("top_p" not in o2,             "topP omitted when None")
expect("top_k" not in o2,             "topK omitted when None")
expect("stop" not in o2,              "stop omitted when None")
expect("seed" not in o2,              "seed omitted when None")
expect("tools" not in o2,             "tools omitted when None")


# ── OpenAI → Safebox chat translation ──────────────────────────────────
print("\n── _vllm_chat_to_safebox() ──")
vllm_resp = {
    "id": "abc",
    "choices": [{
        "message": {
            "role": "assistant",
            "content": "Hello! How can I help?",
            "tool_calls": [{"id": "call_1", "function": {"name": "search"}}]
        },
        "finish_reason": "stop"
    }],
    "usage": {
        "prompt_tokens": 15,
        "completion_tokens": 8,
        "total_tokens": 23,
        "prompt_tokens_details": {"cached_tokens": 10}
    }
}
sb = runner._vllm_chat_to_safebox(vllm_resp, "qwen-3-32b")
expect(sb["model"] == "qwen-3-32b",                 "model echoed back")
expect(sb["content"] == "Hello! How can I help?",   "content extracted")
expect(sb["role"] == "assistant",                   "role extracted")
expect(sb["finishReason"] == "stop",                "finish_reason → finishReason")
expect(sb["usage"]["promptTokens"] == 15,           "prompt_tokens → promptTokens")
expect(sb["usage"]["completionTokens"] == 8,        "completion_tokens → completionTokens")
expect(sb["usage"]["totalTokens"] == 23,            "total_tokens → totalTokens")
expect(sb["usage"]["cachedTokens"] == 10,           "cached_tokens extracted from details")
expect("toolCalls" in sb and len(sb["toolCalls"]) == 1,  "tool_calls → toolCalls when present")


# ── OpenAI → Safebox complete translation ──────────────────────────────
print("\n── _vllm_complete_to_safebox() ──")
vllm_complete = {
    "choices": [{"text": "The answer is", "finish_reason": "length"}],
    "usage": {"prompt_tokens": 5, "completion_tokens": 4, "total_tokens": 9}
}
sc = runner._vllm_complete_to_safebox(vllm_complete, "qwen-3-32b")
expect(sc["text"] == "The answer is",         "text extracted")
expect(sc["finishReason"] == "length",        "finishReason extracted")
expect(sc["usage"]["totalTokens"] == 9,       "usage translated")


# ── HMAC verification (delegates to shared safebox_auth) ──────────────
print("\n── verify_hmac() ──")
import safebox_auth as _sba

class FakeRequest:
    def __init__(self, headers, method="POST", path="/v1/test"):
        self.headers = headers
        self.method = method
        self.url = type("U", (), {"path": path})()

# REQUIRE_HMAC=false → anything passes
_sba.REQUIRE_HMAC = False
expect(runner.verify_hmac(FakeRequest({}), b"body"),
       "passes when REQUIRE_HMAC=false")

# REQUIRE_HMAC=true → strong canonical form enforced (matches auth.js / LocalRunner)
_sba.REQUIRE_HMAC = True
_sba._cached_key = "test-key-12345"
_sba._seen_nonces.clear()
_ts = str(int(time.time()))
_nonce = "test-nonce-1"
_body = b'{"hello":"world"}'
_method, _path = "POST", "/v1/test"
def _strong(ts, nonce, method, path, body, key="test-key-12345"):
    bh = hashlib.sha256(body).hexdigest()
    canon = f"{ts}\n{nonce}\n{method}\n{path}\n{bh}"
    return hmac.new(key.encode(), canon.encode(), hashlib.sha256).hexdigest()
_sig = _strong(_ts, _nonce, _method, _path, _body)

expect(runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": _ts, "X-Safebox-Nonce": _nonce, "X-Safebox-Signature": _sig},
    _method, _path), _body), "valid strong-form signature passes")

_sba._seen_nonces.clear()
expect(not runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": _ts, "X-Safebox-Nonce": "n-bad", "X-Safebox-Signature": "bogus"},
    _method, _path), _body), "bad signature rejected")

_sba._seen_nonces.clear()
expect(not runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": "1000000000", "X-Safebox-Nonce": "n-stale", "X-Safebox-Signature": _sig},
    _method, _path), _body), "stale timestamp rejected")

# endpoint binding: same sig replayed on a different path is rejected
_sba._seen_nonces.clear()
expect(not runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": _ts, "X-Safebox-Nonce": "n-ep", "X-Safebox-Signature": _sig},
    _method, "/v1/other"), _body), "endpoint-swap rejected")

# nonce replay protection
_sba._seen_nonces.clear()
runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": _ts, "X-Safebox-Nonce": _nonce, "X-Safebox-Signature": _sig},
    _method, _path), _body)
expect(not runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": _ts, "X-Safebox-Nonce": _nonce, "X-Safebox-Signature": _sig},
    _method, _path), _body), "nonce replay rejected")

# bad sig must NOT burn the nonce (verify-before-record)
_sba._seen_nonces.clear()
_bad = runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": _ts, "X-Safebox-Nonce": "n-keep", "X-Safebox-Signature": "b"*64},
    _method, _path), _body)
expect(_bad is False, "bad-sig request rejected")
expect("n-keep" not in _sba._seen_nonces, "bad-sig request did NOT burn the nonce")
_sig2 = _strong(_ts, "n-keep", _method, _path, _body)
expect(runner.verify_hmac(FakeRequest(
    {"X-Safebox-Timestamp": _ts, "X-Safebox-Nonce": "n-keep", "X-Safebox-Signature": _sig2},
    _method, _path), _body) is True, "nonce still usable after bad-sig attempt")
_sba.REQUIRE_HMAC = False
_sba._seen_nonces.clear()

# ── Capacity hint ─────────────────────────────────────────────────────
print("\n── get_capacity_hint() ──")
runner.in_flight = 0
expect(runner.get_capacity_hint() == "available", "idle → available")
runner.in_flight = int(runner.MAX_QUEUE_DEPTH * 0.8)
expect(runner.get_capacity_hint() == "near-saturated", "high load → near-saturated")
runner.in_flight = runner.MAX_QUEUE_DEPTH
expect(runner.get_capacity_hint() == "saturated", "at capacity → saturated")
runner.in_flight = 0  # reset


# ── Safebox headers ───────────────────────────────────────────────────
print("\n── safebox_headers() ──")
h = runner.safebox_headers("req-123", "qwen-3-32b", 250)
expect(h["X-Safebox-Request-Id"] == "req-123",   "request id echoed")
expect(h["X-Safebox-Model-Id"] == "qwen-3-32b",  "model id present")
expect(h["X-Safebox-Compute-Ms"] == "250",       "compute_ms stringified")
expect(h["X-Safebox-Runner-Id"] == runner.RUNNER_ID,  "runner id present")
expect("X-Safebox-Capacity-Hint" in h,           "capacity hint included")


# ── Summary ───────────────────────────────────────────────────────────
print()
if fails:
    print(f"✗ {len(fails)} test(s) failed: {fails}")
    sys.exit(1)
print("✓ All tests passed.")
