"""
Quick in-process tests for the ComfyUI runner wrapper.

Exercises everything except actual ComfyUI inference (which needs models +
GPU). Covers: workflow template loading, SDXL/FLUX population, model matching,
HMAC verification, capability flags, header generation, image output extraction.

Run:
    cd model-runners/comfyui
    MODEL_NAME=flux-1-schnell WORKFLOW_FAMILY=flux \
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
os.environ.setdefault("MODEL_NAME",       "flux-1-schnell")
os.environ.setdefault("WORKFLOW_FAMILY",  "flux")
os.environ.setdefault("UNET_NAME",        "flux1-schnell.safetensors")
os.environ.setdefault("VAE_NAME",         "ae.safetensors")
os.environ.setdefault("CLIP_NAMES",       "t5xxl_fp8_e4m3fn.safetensors,clip_l.safetensors")
os.environ.setdefault("DEFAULT_STEPS",    "4")
os.environ.setdefault("DEFAULT_CFG",      "1.0")
os.environ.setdefault("SAFEBOX_REQUIRE_HMAC", "false")
os.environ.setdefault("ENABLE_UNIX_SOCKET",   "false")

# Make workflow templates resolvable from where we run the test
import sys as _sys
_sys.path.insert(0, ".")

import runner


fails = []
def expect(cond, label):
    if cond:
        print(f"  ✓ {label}")
    else:
        print(f"  ✗ {label}")
        fails.append(label)


# ── model_matches() ──────────────────────────────────────────────────────
print("\n── model_matches() ──")
expect(runner.model_matches("flux-1-schnell"),  "canonical name accepted")
expect(not runner.model_matches("flux-1-dev"),  "different model rejected")
expect(not runner.model_matches("sdxl"),        "wrong family rejected")
expect(not runner.model_matches(""),            "empty model rejected")


# ── Workflow template loading ────────────────────────────────────────────
print("\n── load_workflow_template() ──")
try:
    flux_tpl = runner.load_workflow_template("flux")
    expect(isinstance(flux_tpl, dict),                "FLUX template loads as dict")
    expect("3" in flux_tpl,                           "FLUX template has KSampler at node 3")
    expect(flux_tpl["3"]["class_type"] == "KSampler", "FLUX node 3 is KSampler")
    expect("10" in flux_tpl,                          "FLUX template has UNETLoader at node 10")
    expect(flux_tpl["10"]["class_type"] == "UNETLoader", "FLUX node 10 is UNETLoader")
    expect("13" in flux_tpl,                          "FLUX template has FluxGuidance at node 13")
    expect(flux_tpl["13"]["class_type"] == "FluxGuidance", "FLUX node 13 is FluxGuidance")
except Exception as e:
    expect(False, f"FLUX template load failed: {e}")

try:
    sdxl_tpl = runner.load_workflow_template("sdxl")
    expect(isinstance(sdxl_tpl, dict),                  "SDXL template loads as dict")
    expect(sdxl_tpl["4"]["class_type"] == "CheckpointLoaderSimple",
                                                        "SDXL node 4 is CheckpointLoaderSimple")
    expect(sdxl_tpl["9"]["class_type"] == "SaveImage",  "SDXL node 9 is SaveImage")
except Exception as e:
    expect(False, f"SDXL template load failed: {e}")

# Cache should keep returning a fresh copy
flux_tpl_2 = runner.load_workflow_template("flux")
expect(flux_tpl_2 is not flux_tpl,                      "template is deep-copied (cache returns fresh)")

# Unknown family
try:
    runner.load_workflow_template("wan")
    expect(False, "unknown family raises")
except FileNotFoundError:
    expect(True, "unknown family raises FileNotFoundError")


# ── populate_flux_workflow ───────────────────────────────────────────────
print("\n── populate_flux_workflow() ──")
req = runner.ImageGenerateRequest(
    model="flux-1-schnell",
    prompt="a cyberpunk skyline at dusk",
    negativePrompt="blurry",
    width=512, height=512,
    steps=8, guidance=3.5, seed=42,
    batchSize=2,
)
tpl = runner.load_workflow_template("flux")
populated = runner.populate_flux_workflow(tpl, req, "test-client")
expect(populated["3"]["inputs"]["seed"]         == 42,                "FLUX seed substituted")
expect(populated["3"]["inputs"]["steps"]        == 8,                 "FLUX steps substituted")
expect(populated["3"]["inputs"]["cfg"]          == 1.0,               "FLUX cfg is 1.0 (FluxGuidance handles real value)")
expect(populated["5"]["inputs"]["width"]        == 512,               "FLUX width substituted")
expect(populated["5"]["inputs"]["height"]       == 512,               "FLUX height substituted")
expect(populated["5"]["inputs"]["batch_size"]   == 2,                 "FLUX batch_size substituted")
expect(populated["6"]["inputs"]["text"]         == "a cyberpunk skyline at dusk", "FLUX positive prompt substituted")
expect(populated["7"]["inputs"]["text"]         == "blurry",          "FLUX negative prompt substituted")
expect(populated["10"]["inputs"]["unet_name"]   == "flux1-schnell.safetensors", "FLUX UNET name from env")
expect(populated["11"]["inputs"]["vae_name"]    == "ae.safetensors",  "FLUX VAE name from env")
expect(populated["12"]["inputs"]["clip_name1"]  == "t5xxl_fp8_e4m3fn.safetensors", "FLUX clip1 from env")
expect(populated["13"]["inputs"]["guidance"]    == 3.5,               "FLUX guidance substituted via FluxGuidance node")

# Defaults when omitted
req2 = runner.ImageGenerateRequest(model="flux-1-schnell", prompt="test")
tpl2 = runner.load_workflow_template("flux")
populated2 = runner.populate_flux_workflow(tpl2, req2, "test-client-2")
expect(populated2["3"]["inputs"]["steps"]  == 4,    "FLUX steps default to 4")
expect(populated2["5"]["inputs"]["width"]  == 1024, "FLUX width default to 1024")
expect(populated2["5"]["inputs"]["height"] == 1024, "FLUX height default to 1024")
expect(populated2["5"]["inputs"]["batch_size"] == 1, "FLUX batch_size default to 1")
expect(populated2["6"]["inputs"]["text"]   == "test", "FLUX prompt substituted (no negative)")
expect(populated2["7"]["inputs"]["text"]   == "",     "FLUX negative defaults to empty")
expect(isinstance(populated2["3"]["inputs"]["seed"], int), "FLUX random seed generated when None")


# ── populate_sdxl_workflow ───────────────────────────────────────────────
print("\n── populate_sdxl_workflow() ──")
runner.CHECKPOINT_NAME = "sd_xl_base_1.0.safetensors"
req_sdxl = runner.ImageGenerateRequest(
    model="sdxl-base-1.0",
    prompt="a watercolor painting of mountains",
    negativePrompt="ugly, deformed",
    width=1024, height=1024,
    steps=25, guidance=7.5, seed=99,
)
sdxl_tpl_fresh = runner.load_workflow_template("sdxl")
populated_sdxl = runner.populate_sdxl_workflow(sdxl_tpl_fresh, req_sdxl, "test-client")
expect(populated_sdxl["3"]["inputs"]["cfg"]      == 7.5,    "SDXL cfg substituted directly")
expect(populated_sdxl["3"]["inputs"]["steps"]    == 25,     "SDXL steps substituted")
expect(populated_sdxl["3"]["inputs"]["seed"]     == 99,     "SDXL seed substituted")
expect(populated_sdxl["4"]["inputs"]["ckpt_name"] == "sd_xl_base_1.0.safetensors",
                                                            "SDXL checkpoint name set")
expect(populated_sdxl["6"]["inputs"]["text"]     == "a watercolor painting of mountains",
                                                            "SDXL positive prompt substituted")
expect(populated_sdxl["7"]["inputs"]["text"]     == "ugly, deformed",
                                                            "SDXL negative prompt substituted")


# ── extract_output_images ──────────────────────────────────────────────
print("\n── extract_output_images() ──")
fake_history = {
    "outputs": {
        "9": {
            "images": [
                {"filename": "safebox_00001_.png", "subfolder": "", "type": "output"},
                {"filename": "safebox_00002_.png", "subfolder": "", "type": "output"},
            ]
        }
    },
    "status": {"completed": True}
}
imgs = runner.extract_output_images(fake_history)
expect(len(imgs) == 2,                              "extracts 2 images")
expect(imgs[0]["filename"] == "safebox_00001_.png", "first image filename correct")
expect(imgs[1]["filename"] == "safebox_00002_.png", "second image filename correct")
expect(imgs[0]["type"]     == "output",             "type defaulted/extracted")

# Empty case
empty_history = {"outputs": {}}
imgs_empty = runner.extract_output_images(empty_history)
expect(len(imgs_empty) == 0, "empty outputs returns empty list")


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
runner.in_flight = 0


# ── Safebox headers ───────────────────────────────────────────────────
print("\n── safebox_headers() ──")
h = runner.safebox_headers("req-img-9", "flux-1-schnell", 4200)
expect(h["X-Safebox-Request-Id"] == "req-img-9",       "request id echoed")
expect(h["X-Safebox-Model-Id"]   == "flux-1-schnell",  "model id present")
expect(h["X-Safebox-Compute-Ms"] == "4200",            "compute_ms stringified")
expect(h["X-Safebox-Runner-Id"]  == runner.RUNNER_ID,  "runner id present")
expect("X-Safebox-Capacity-Hint" in h,                 "capacity hint included")


# ── Pydantic request validation ────────────────────────────────────────
print("\n── ImageGenerateRequest defaults ──")
r = runner.ImageGenerateRequest(model="flux-1-schnell", prompt="hi")
expect(r.outputMode == "path",                 "default outputMode is 'path'")
expect(r.batchSize == 1,                       "default batchSize is 1")
expect(r.filenamePrefix == "safebox",          "default filenamePrefix is 'safebox'")
expect(r.negativePrompt == "",                 "default negativePrompt is empty")


# ── Summary ───────────────────────────────────────────────────────────
print()
if fails:
    print(f"✗ {len(fails)} test(s) failed: {fails}")
    sys.exit(1)
print("✓ All tests passed.")
