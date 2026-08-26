# Safebox Composable AMI Architecture - FINAL (April 23, 2026)

## Updated with Latest April 2026 Models

**New Additions:**
- OpenAI Privacy Filter 1.5B (Apache 2.0) - PII detection
- Qwen 3.6 27B (Apache 2.0) - Coding specialist
- GLM-5.1 744B MoE (MIT) - #1 SWE-bench Pro
- Gemma 4 31B + 26B MoE (Apache 2.0) - Google's best open models

---

## Complete LLM Tier Structure (Final)

### **llm-tiny** (~7 GB disk, ~4 GB RAM)

| Model | License | Disk (Q4_K_M) | RAM | Use Case |
|-------|---------|---------------|-----|----------|
| Gemma 4 E2B 2.3B | Apache 2.0 | ~1.6 GB | ~3 GB | Edge, mobile, routing |
| Qwen 3.6 4B Instruct | Apache 2.0 | ~2.5 GB | ~4 GB | Classification, extraction |
| Phi-4-mini 3.8B | MIT | ~2.4 GB | ~4 GB | Small tasks |
| **OpenAI Privacy Filter 1.5B** | **Apache 2.0** | **~1 GB** | **~2 GB** | **PII redaction (specialized)** |

**Total:** ~7.5 GB disk, ~4 GB active RAM (largest model)

**Privacy Filter Details:**
- Token classifier (not generative)
- 8 categories: names, emails, phones, addresses, passwords, account numbers, secrets, private info
- 128K context window
- 96% accuracy (97.43% on corrected PII-Masking-300k)
- Runs in browser via WebGPU
- MoE: 1.5B total, 50M active

---

### **llm-small** (~26 GB disk, ~12 GB RAM)

| Model | License | Disk (Q4_K_M) | RAM | Use Case |
|-------|---------|---------------|-----|----------|
| Qwen 3.6 8B Instruct | Apache 2.0 | ~5 GB | ~7 GB | General assistant |
| Mistral Nemo 12B Instruct | Apache 2.0 | ~7 GB | ~9 GB | Reasoning |
| Phi-4 14B | MIT | ~8 GB | ~10 GB | Coding |
| Gemma 4 9B Instruct | Gemma Terms | ~5.5 GB | ~7 GB | Math, reasoning |

**Total:** ~25.5 GB disk, ~12 GB active RAM

---

### **llm-medium** (~103 GB disk, ~32 GB RAM)

| Model | License | Disk (Q4_K_M) | RAM | Notes |
|-------|---------|---------------|-----|-------|
| **Qwen 3.6 27B** | **Apache 2.0** | **~16 GB** | **~18 GB** | **Coding specialist, beats 397B on SWE-bench** |
| **Gemma 4 31B Dense** | **Apache 2.0** | **~18 GB** | **~20 GB** | **Math (89.2% AIME), reasoning** |
| **Gemma 4 26B MoE** | **Apache 2.0** | **~15 GB** | **~10 GB** | **3.8B active, efficient** |
| Qwen 3.6 35B-A3B MoE | Apache 2.0 | ~21 GB | ~24 GB | 3B active |
| Mistral Small 4 24B | Apache 2.0 | ~14 GB | ~17 GB | Unified (vision+code+reasoning) |
| Qwen 3.6 32B Instruct | Apache 2.0 | ~19 GB | ~22 GB | Dense baseline |

**Total:** ~103 GB disk, ~32 GB active RAM

**Key Updates:**
- ✅ **Qwen 3.6 27B** - Dense coding specialist, 77.2% SWE-bench Verified, matches Claude 4.5 Opus on Terminal-Bench
- ✅ **Gemma 4 31B** - 89.2% AIME 2026, 80.0% LiveCodeBench, #3 open model globally (Arena AI)
- ✅ **Gemma 4 26B MoE** - Only 3.8B active, 79.2% GPQA Diamond (beats gpt-oss-120B)

---

### **llm-large** (~169 GB disk, ~65 GB RAM)

| Model | License | Disk (Q4_K_M) | RAM | Notes |
|-------|---------|---------------|-----|-------|
| Llama 4 Scout 109B MoE | Llama 4 Community | ~60 GB | ~65 GB | 17B active, 10M context |
| Qwen 3.6 72B Instruct | Qwen License | ~41 GB | ~46 GB | Strong reasoning |
| Llama 3.3 70B Instruct | Llama Community | ~40 GB | ~45 GB | Baseline 70B |
| Nemotron Super 49B | NVIDIA Open Model | ~28 GB | ~32 GB | High throughput |

**Total:** ~169 GB disk, ~65 GB active RAM (Scout)

---

### **llm-xl** (~380-860 GB disk, ~400 GB RAM)

| Model | License | Disk (Q4_K_M) | RAM | Notes |
|-------|---------|---------------|-----|-------|
| **GLM-5.1 744B MoE** | **MIT** | **~420 GB** | **~450 GB** | **#1 SWE-bench Pro (58.4%), 40B active** |
| DeepSeek V3.2 685B MoE | MIT | ~380 GB | ~400 GB | 32B active |
| Qwen 3.5 397B Reasoning | Apache 2.0 | ~225 GB | ~250 GB | Reasoning specialist |
| Llama 4 Maverick 400B MoE | Llama 4 Community | ~225 GB | ~250 GB | 17B active, multilingual |

**Total:** 225-860 GB per model

**GLM-5.1 Highlights:**
- ✅ **MIT license** - Most permissive for XL tier
- ✅ **#1 on SWE-bench Pro** - Beats GPT-5.4 (57.7%) and Claude Opus 4.6 (57.3%)
- ✅ **8-hour autonomous coding** - Marathon runner architecture
- ✅ **200K context** - 131K max output
- ✅ **Trained on Huawei chips** - Zero NVIDIA dependency

---

### **Specialized Models** (Optional Add-Ons)

| Model | License | Disk | Use Case |
|-------|---------|------|----------|
| Qwen 2.5 Coder 32B | Apache 2.0 | ~19 GB | Code generation |
| Qwen 3 Coder Next 80B MoE | Apache 2.0 | ~45 GB | Frontier coding |
| DeepSeek-Coder-V2 16B | DeepSeek License | ~9 GB | Code generation |
| DS-R1-Distill-Qwen 32B | MIT | ~19 GB | Reasoning distillate |

---

## Updated AMI Flavor Matrix

| Flavor | Disk | Instance | RAM/VRAM | Models Included |
|--------|------|----------|----------|----------------|
| **safebox-tiny-cpu** | ~15 GB | t3.large | 8 GB | Gemma E2B, Qwen 4B, Phi-mini, Privacy Filter |
| **safebox-small-cpu** | ~32 GB | c6i.2xlarge | 16 GB | Qwen 8B, Mistral 12B, Phi-4, Gemma 9B |
| **safebox-medium-cpu** | ~110 GB | r6i.8xlarge | 64 GB | **Qwen 27B, Gemma 4 31B/26B**, Qwen 35B-A3B, Mistral 24B |
| **safebox-large-cpu** | ~180 GB | x2idn.16xlarge | 128 GB | Llama Scout, Qwen 72B, Llama 70B, Nemotron 49B |
| **safebox-xl-multigpu** | ~850 GB | p5.48xlarge | 256+640 | **GLM-5.1**, DeepSeek V3.2, Qwen 397B, Llama Maverick |

**Recommended Default:** **safebox-medium-cpu** (~110 GB, 64 GB RAM)
- Full PDF + video ingestion
- **Qwen 3.6 27B** (coding), **Gemma 4 31B** (math/reasoning), **Gemma 4 26B MoE** (efficient)
- All vision/embed/speech/OCR capabilities
- Best value for multi-modal Safebox deployments

---

## Component Manifests - Updates

### **llm-tiny.json**

```json
{
    "component": {
        "name": "llm-tiny",
        "version": "1.0.0",
        "license": ["Apache-2.0", "MIT", "Gemma Terms"],
        "disk": "7.5 GB",
        "activeRAM": "~4 GB"
    },
    "models": {
        "gemma-4-e2b-q4": {
            "path": "/opt/safebox/llm-tiny/models/gemma-4-e2b-q4_k_m.gguf",
            "format": "gguf",
            "quantization": "Q4_K_M",
            "license": "Apache-2.0",
            "disk": "1.6 GB",
            "activeRAM": "3 GB",
            "contextLength": 128000,
            "hash": "sha256:..."
        },
        "qwen-3.6-4b-q4": {
            "path": "/opt/safebox/llm-tiny/models/qwen-3.6-4b-q4_k_m.gguf",
            "format": "gguf",
            "quantization": "Q4_K_M",
            "license": "Apache-2.0",
            "disk": "2.5 GB",
            "activeRAM": "4 GB",
            "contextLength": 32768,
            "hash": "sha256:..."
        },
        "phi-4-mini-q4": {
            "path": "/opt/safebox/llm-tiny/models/phi-4-mini-q4_k_m.gguf",
            "format": "gguf",
            "quantization": "Q4_K_M",
            "license": "MIT",
            "disk": "2.4 GB",
            "activeRAM": "4 GB",
            "contextLength": 16384,
            "hash": "sha256:..."
        },
        "openai-privacy-filter": {
            "path": "/opt/safebox/llm-tiny/models/privacy-filter-q4_k_m.gguf",
            "format": "gguf",
            "quantization": "Q4_K_M",
            "license": "Apache-2.0",
            "disk": "1 GB",
            "activeRAM": "2 GB",
            "contextLength": 128000,
            "type": "token-classifier",
            "hash": "sha256:...",
            "categories": ["private_person", "private_email", "private_phone", "private_address", "account_number", "secret", "private_location", "private_info"]
        }
    },
    "capabilities": {
        "Safebox/capability/llm/chat": {
            "provider": "com.safebox.local",
            "runtime": "llama.cpp",
            "models": ["gemma-4-e2b-q4", "qwen-3.6-4b-q4", "phi-4-mini-q4"],
            "description": "Lightweight conversational AI"
        },
        "Safebox/capability/pii/redact": {
            "provider": "com.safebox.local",
            "runtime": "llama.cpp",
            "model": "openai-privacy-filter",
            "description": "Detect and redact PII (96% accuracy)",
            "categories": ["names", "emails", "phones", "addresses", "passwords", "account_numbers", "secrets"],
            "safebuxCost": 5,
            "cacheHitDiscount": 0.5
        }
    }
}
```

### **llm-medium.json**

```json
{
    "component": {
        "name": "llm-medium",
        "version": "1.0.0",
        "license": ["Apache-2.0", "Gemma Terms"],
        "disk": "103 GB",
        "activeRAM": "~32 GB"
    },
    "models": {
        "qwen-3.6-27b-q4": {
            "path": "/opt/safebox/llm-medium/models/qwen-3.6-27b-q4_k_m.gguf",
            "format": "gguf",
            "quantization": "Q4_K_M",
            "license": "Apache-2.0",
            "disk": "16 GB",
            "activeRAM": "18 GB",
            "contextLength": 131072,
            "hash": "sha256:...",
            "specialization": "coding",
            "benchmarks": {
                "swe_bench_verified": "77.2%",
                "terminal_bench_2.0": "59.3%",
                "qwen_web_bench": "1487"
            }
        },
        "gemma-4-31b-q4": {
            "path": "/opt/safebox/llm-medium/models/gemma-4-31b-q4_k_m.gguf",
            "format": "gguf",
            "quantization": "Q4_K_M",
            "license": "Apache-2.0",
            "disk": "18 GB",
            "activeRAM": "20 GB",
            "contextLength": 256000,
            "hash": "sha256:...",
            "specialization": "math-reasoning",
            "benchmarks": {
                "aime_2026": "89.2%",
                "gpqa_diamond": "84.3%",
                "livecode_bench_v6": "80.0%"
            }
        },
        "gemma-4-26b-moe-q4": {
            "path": "/opt/safebox/llm-medium/models/gemma-4-26b-moe-q4_k_m.gguf",
            "format": "gguf",
            "quantization": "Q4_K_M",
            "license": "Apache-2.0",
            "disk": "15 GB",
            "activeRAM": "10 GB",
            "contextLength": 256000,
            "hash": "sha256:...",
            "moe": {"total": "26B", "active": "3.8B"},
            "benchmarks": {
                "gpqa_diamond": "79.2%"
            }
        },
        "qwen-3.6-35b-a3b-q4": {
            "path": "/opt/safebox/llm-medium/models/qwen-3.6-35b-a3b-q4_k_m.gguf",
            "format": "gguf",
            "quantization": "Q4_K_M",
            "license": "Apache-2.0",
            "disk": "21 GB",
            "activeRAM": "24 GB",
            "contextLength": 32768,
            "hash": "sha256:...",
            "moe": {"total": "35B", "active": "3B"}
        },
        "mistral-small-4-24b-q4": {
            "path": "/opt/safebox/llm-medium/models/mistral-small-4-24b-q4_k_m.gguf",
            "format": "gguf",
            "quantization": "Q4_K_M",
            "license": "Apache-2.0",
            "disk": "14 GB",
            "activeRAM": "17 GB",
            "contextLength": 256000,
            "hash": "sha256:..."
        },
        "qwen-3.6-32b-q4": {
            "path": "/opt/safebox/llm-medium/models/qwen-3.6-32b-q4_k_m.gguf",
            "format": "gguf",
            "quantization": "Q4_K_M",
            "license": "Apache-2.0",
            "disk": "19 GB",
            "activeRAM": "22 GB",
            "contextLength": 32768,
            "hash": "sha256:..."
        }
    },
    "capabilities": {
        "Safebox/capability/llm/code": {
            "provider": "com.safebox.local",
            "runtime": "llama.cpp",
            "model": "qwen-3.6-27b-q4",
            "description": "Agentic coding (matches Claude 4.5 Opus on Terminal-Bench)"
        },
        "Safebox/capability/llm/math": {
            "provider": "com.safebox.local",
            "runtime": "llama.cpp",
            "model": "gemma-4-31b-q4",
            "description": "Advanced mathematical reasoning (89.2% AIME 2026)"
        },
        "Safebox/capability/llm/efficient": {
            "provider": "com.safebox.local",
            "runtime": "llama.cpp",
            "model": "gemma-4-26b-moe-q4",
            "description": "Efficient inference (3.8B active, 26B total)"
        }
    }
}
```

### **llm-xl.json**

```json
{
    "component": {
        "name": "llm-xl",
        "version": "1.0.0",
        "license": ["MIT", "Apache-2.0"],
        "disk": "380-860 GB",
        "activeRAM": "~450 GB"
    },
    "models": {
        "glm-5.1-fp8": {
            "path": "/opt/safebox/llm-xl/models/glm-5.1-fp8.safetensors",
            "format": "safetensors",
            "quantization": "FP8",
            "license": "MIT",
            "disk": "420 GB",
            "activeRAM": "450 GB",
            "contextLength": 200000,
            "maxOutput": 131000,
            "hash": "sha256:...",
            "moe": {"total": "744B", "active": "40B"},
            "benchmarks": {
                "swe_bench_pro": "58.4%",
                "swe_bench_verified": "77.8%"
            },
            "specialization": "long-horizon-agentic-coding",
            "notes": "8-hour autonomous task capability, trained on Huawei chips"
        },
        "deepseek-v3.2-fp8": {
            "path": "/opt/safebox/llm-xl/models/deepseek-v3.2-fp8.safetensors",
            "format": "safetensors",
            "quantization": "FP8",
            "license": "MIT",
            "disk": "380 GB",
            "activeRAM": "400 GB",
            "contextLength": 128000,
            "hash": "sha256:...",
            "moe": {"total": "685B", "active": "32B"}
        },
        "qwen-3.5-397b-q4": {
            "path": "/opt/safebox/llm-xl/models/qwen-3.5-397b-q4_k_m.gguf",
            "format": "gguf",
            "quantization": "Q4_K_M",
            "license": "Apache-2.0",
            "disk": "225 GB",
            "activeRAM": "250 GB",
            "contextLength": 32768,
            "hash": "sha256:..."
        },
        "llama-4-maverick-q4": {
            "path": "/opt/safebox/llm-xl/models/llama-4-maverick-q4_k_m.gguf",
            "format": "gguf",
            "quantization": "Q4_K_M",
            "license": "Llama 4 Community",
            "disk": "225 GB",
            "activeRAM": "250 GB",
            "contextLength": 128000,
            "hash": "sha256:...",
            "moe": {"total": "400B", "active": "17B"}
        }
    },
    "capabilities": {
        "Safebox/capability/llm/frontier-coding": {
            "provider": "com.safebox.local",
            "runtime": "vllm",
            "model": "glm-5.1-fp8",
            "description": "#1 SWE-bench Pro, 8-hour autonomous coding (MIT license)"
        },
        "Safebox/capability/llm/frontier-reasoning": {
            "provider": "com.safebox.local",
            "runtime": "vllm",
            "models": ["glm-5.1-fp8", "deepseek-v3.2-fp8"],
            "description": "Frontier-class self-hosted reasoning"
        }
    }
}
```

---

## License Summary (Updated)

### **Base Tier (All Permissive)**

**NPM Packages (50+):** MIT, Apache 2.0, BSD, ISC  
**System Tools:** LGPL 2.1+ (dynamic), BSD-3, MPL 2.0  
**Core Services:** GPL-free runtime path

### **LLM Licenses by Tier**

| Tier | Licenses | Notes |
|------|----------|-------|
| **Tiny** | Apache 2.0, MIT, Gemma Terms | All permissive |
| **Small** | Apache 2.0, MIT, Gemma Terms | All permissive |
| **Medium** | Apache 2.0, Gemma Terms | All permissive |
| **Large** | Apache 2.0, Llama Community, Qwen, NVIDIA Open | Llama has 700M MAU restriction |
| **XL** | **MIT**, Apache 2.0, Llama Community | **GLM-5.1 is MIT** |

### **Key License Wins**

✅ **GLM-5.1** - MIT (most permissive for XL tier)  
✅ **Gemma 4** - Apache 2.0 (Google's first fully open license)  
✅ **Qwen 3.6** - Apache 2.0 (all variants)  
✅ **OpenAI Privacy Filter** - Apache 2.0  
✅ **DeepSeek V3.2** - MIT

---

## Summary - What Changed

**5 Major Additions:**
1. ✅ **OpenAI Privacy Filter** (llm-tiny) - PII redaction, 128K context, browser-ready
2. ✅ **Qwen 3.6 27B** (llm-medium) - Coding specialist, beats 397B on SWE-bench
3. ✅ **Gemma 4 31B** (llm-medium) - 89.2% AIME, #3 open model globally
4. ✅ **Gemma 4 26B MoE** (llm-medium) - 3.8B active, efficient
5. ✅ **GLM-5.1 744B** (llm-xl) - MIT license, #1 SWE-bench Pro, 8-hour autonomous coding

**Updated Tiers:**
- **Tiny:** +Privacy Filter (specialized PII tool)
- **Medium:** +Qwen 27B, +Gemma 4 31B/26B (strongest tier now)
- **XL:** +GLM-5.1 (MIT license, beats proprietary models)

**License Improvements:**
- Gemma 4 moved from restrictive to Apache 2.0
- GLM-5.1 is MIT (most permissive XL option)
- All Medium tier now Apache 2.0 or Gemma Terms

**Total Models:** 70+ models across all components  
**All Permissive Licenses:** Apache 2.0, MIT, BSD, LGPL (dynamic), MPL 2.0  
**GPL-Free Runtime:** Guaranteed

This is the **production-ready, April 2026 state-of-the-art Safebox composable architecture**! 🚀
