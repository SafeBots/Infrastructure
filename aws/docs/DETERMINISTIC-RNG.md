# Deterministic RNG at OS Level - Safebox Architecture Analysis

## Question

**Can we inject a deterministic seed into the Linux kernel's entropy pool during AMI build, so that ALL programs (llama.cpp, ONNX Runtime, whisper.cpp, vLLM, etc.) read deterministic randomness from the OS without individual runtime patching?**

---

## TL;DR Answer

**YES, but with CRITICAL CAVEATS:**

✅ **Technically feasible** via `RNDADDENTROPY` ioctl during early boot  
⚠️ **DANGEROUS for production** - conflicts with TPM attestation and security  
✅ **Best for: Reproducible research, auditing, debugging**  
❌ **Bad for: Multi-tenant production, security-critical environments**

---

## Three Approaches Analyzed

### **Approach 1: RNDADDENTROPY ioctl (Most Viable)**

**How it works:**
```c
// During early boot (before any inference)
struct rand_pool_info {
    int entropy_count;  // Number of bits to credit
    int buf_size;       // Size of seed data
    __u32 buf[512];     // Seed data
};

int fd = open("/dev/urandom", O_WRONLY);
struct rand_pool_info *entropy = malloc(sizeof(*entropy) + seed_size);
entropy->entropy_count = seed_size * 8;  // bits
entropy->buf_size = seed_size;
memcpy(entropy->buf, seed_data, seed_size);
ioctl(fd, RNDADDENTROPY, entropy);  // Requires CAP_SYS_ADMIN
```

**Kernel behavior (Linux 5.17+, Blake2s-based pool):**
- Mixes seed into 256-bit entropy pool
- Sets entropy count to credited amount
- All subsequent reads from `/dev/urandom` and `getrandom()` are deterministic
- **Pool is NOT cleared** - same input = same output chain

**Reference implementation:**
- https://github.com/simias/rngseed (existing tool)
- systemd's `systemd-random-seed.service` uses this pattern

**Timing:** Must happen during AMI boot script, BEFORE:
- Any AI runtime starts
- Docker containers launch
- PHP-FPM workers spawn
- Node.js processes start

**Implementation:**
```bash
#!/bin/bash
# /opt/safebox/bin/seed-rng.sh
# Called from systemd early boot

SEED_SOURCE="${SAFEBOX_INFERENCE_SEED:-/opt/safebox/config/inference.seed}"

if [ -f "$SEED_SOURCE" ]; then
    # Use C utility (compile from simias/rngseed or write custom)
    /opt/safebox/bin/rngseed "$SEED_SOURCE"
    echo "Seeded kernel RNG from $SEED_SOURCE" >> /var/log/safebox-boot.log
else
    echo "No deterministic seed found, using hardware entropy" >> /var/log/safebox-boot.log
fi
```

**systemd unit:**
```ini
# /etc/systemd/system/safebox-seed-rng.service
[Unit]
Description=Seed kernel RNG for deterministic inference
DefaultDependencies=no
Before=sysinit.target
After=systemd-random-seed.service
ConditionPathExists=/opt/safebox/config/inference.seed

[Service]
Type=oneshot
ExecStart=/opt/safebox/bin/seed-rng.sh
RemainAfterExit=yes

[Install]
WantedBy=sysinit.target
```

**Pros:**
- ✅ Single point of control (OS-level)
- ✅ No per-runtime patching needed
- ✅ Works for ALL programs (C, Python, Rust, etc.)
- ✅ Existing kernel interface (stable since 1994)
- ✅ Can be toggled per-instance via config file

**Cons:**
- ⚠️ Requires `CAP_SYS_ADMIN` (root during boot)
- ⚠️ **Destroys security properties** - all "random" becomes predictable
- ⚠️ **Conflicts with TPM/Nitro attestation** - measured boot expects entropy
- ⚠️ Cannot change seed after boot without reboot
- ⚠️ Seed file must be protected (if leaked, all "randomness" is known)

---

### **Approach 2: LD_PRELOAD getrandom() Wrapper (Partial)**

**How it works:**
```c
// libfake_getrandom.so
#define _GNU_SOURCE
#include <sys/random.h>
#include <stdint.h>
#include <string.h>

static uint64_t rng_state = 0x123456789ABCDEF0ULL;

// Simple LCG (Linear Congruential Generator)
static uint64_t next_random() {
    rng_state = rng_state * 6364136223846793005ULL + 1442695040888963407ULL;
    return rng_state;
}

ssize_t getrandom(void *buf, size_t buflen, unsigned int flags) {
    uint8_t *bytes = buf;
    for (size_t i = 0; i < buflen; i++) {
        uint64_t r = next_random();
        bytes[i] = r & 0xFF;
    }
    return buflen;
}

// Also override read() for /dev/urandom
ssize_t read(int fd, void *buf, size_t count) {
    // Check if fd is /dev/urandom...
    // Implementation left as exercise
}
```

**Usage:**
```bash
SAFEBOX_INFERENCE_SEED=12345 LD_PRELOAD=/opt/safebox/lib/libfake_getrandom.so llama-server ...
```

**Pros:**
- ✅ No kernel modification
- ✅ Per-process control
- ✅ Can change seed per invocation
- ✅ Doesn't affect system security

**Cons:**
- ❌ **Doesn't intercept syscalls** - only libc wrappers
- ❌ Programs calling `syscall(SYS_getrandom)` bypass it
- ❌ vDSO getrandom (kernel 6.11+) bypasses userspace entirely
- ❌ Must apply to EVERY process individually
- ❌ Complex to get right (read(), getrandom(), /dev/urandom, /dev/random all need wrappers)
- ❌ Fails for statically-linked binaries

**Verdict:** **NOT RECOMMENDED** - too brittle, bypasses are common

---

### **Approach 3: Kernel Boot Parameter (Theoretical)**

**Concept:**
```bash
# Boot with kernel parameter
GRUB_CMDLINE_LINUX="random.trust_cpu=0 random.seed=0x123456789ABCDEF0"
```

**Reality:**
- ❌ **No such parameter exists** in mainline Linux
- ❌ Would require custom kernel patch
- ❌ Not viable for production AMI

**Verdict:** **NOT FEASIBLE** without kernel fork

---

## Recommended Architecture

### **Dual-Mode Design**

**Mode 1: Production (Default)**
- Use hardware entropy (RDRAND, virtio-rng, TPM)
- Full security properties
- TPM attestation works
- Normal `/dev/urandom` behavior

**Mode 2: Deterministic (Opt-In)**
- Activated via `/opt/safebox/config/inference.seed` file
- Early-boot `RNDADDENTROPY` injection
- All inference becomes reproducible
- **TPM attestation DISABLED** (incompatible)
- Stream metadata includes `Safebox/deterministicMode: true`

### **Implementation**

**1. Seed File Location:**
```
/opt/safebox/config/inference.seed  (256 bytes, hex-encoded SHA-256 hash)
```

**2. Early Boot Service:**
```bash
#!/bin/bash
# /opt/safebox/bin/seed-rng.sh

SEED_FILE="/opt/safebox/config/inference.seed"

if [ ! -f "$SEED_FILE" ]; then
    # No seed file = production mode (hardware entropy)
    echo "Production mode: Using hardware entropy" | systemd-cat -t safebox-rng -p info
    exit 0
fi

# Deterministic mode
SEED_HEX=$(cat "$SEED_FILE")
SEED_BIN=$(echo "$SEED_HEX" | xxd -r -p)

# Inject into kernel pool
echo "$SEED_BIN" | /opt/safebox/bin/rngseed

# Set system flag
mkdir -p /run/safebox
echo "true" > /run/safebox/deterministic-mode

echo "Deterministic mode: RNG seeded with $SEED_FILE" | systemd-cat -t safebox-rng -p warning
```

**3. Runtime Detection:**
```php
// PHP - Safebox plugin
function Safebox_isDeterministicMode() {
    return file_exists('/run/safebox/deterministic-mode');
}

// When creating streams, add attribute
if (Safebox_isDeterministicMode()) {
    $stream->setAttribute('Safebox/deterministicMode', true);
    $stream->setAttribute('Safebox/inferenceSeed', hash_file('sha256', '/opt/safebox/config/inference.seed'));
}
```

**4. Per-Runtime Behavior:**

All runtimes (llama.cpp, ONNX, whisper.cpp, vLLM) read from `/dev/urandom` or `getrandom()`, which are now deterministic after kernel seeding.

**No runtime-specific patches needed!** ✅

---

## Security Implications

### **⚠️ CRITICAL WARNINGS**

**1. Cryptographic Security DESTROYED**
- All "random" UUIDs become predictable
- Session tokens predictable
- CSRF tokens predictable
- JWT nonces predictable

**Mitigation:** Deterministic mode ONLY for AI inference, NOT for:
- Web session management
- Authentication tokens
- Cryptographic key generation
- Password resets

**2. TPM/Nitro Attestation INCOMPATIBLE**
- Measured boot expects hardware entropy
- Nitro Enclaves check RNG initialization
- Deterministic seed breaks attestation chain

**Mitigation:** Deterministic mode disables TPM attestation entirely. Flag in instance metadata.

**3. Multi-Tenant Risk**
- If two tenants share instance, both get same "random" stream
- Could leak information across tenants

**Mitigation:** Deterministic mode ONLY for single-tenant instances. Never enable in multi-tenant SafeBox.

---

## Use Cases

### **✅ GOOD USE CASES**

**1. Reproducible Research**
```bash
# Same input + same seed = identical output
echo "my_research_prompt" | SEED=paper_v1 safebox-infer > output.txt
# Bitwise identical on re-run
```

**2. Debugging**
```bash
# Bug only appears sometimes? Fix the seed, reproduce deterministically
SEED=bug_12345 safebox-run-workflow
```

**3. Compliance Auditing**
```bash
# Regulator: "Prove AI output was based on these exact inputs"
# Replay: Same inputs + stored seed hash = exact same output
```

**4. A/B Testing**
```bash
# Test model A vs model B on SAME randomness
# Eliminates variance from RNG, isolates model differences
```

### **❌ BAD USE CASES**

**1. Production Multi-Tenant SaaS**
- Security risk too high
- Tenant isolation broken

**2. Key Generation**
```bash
# NEVER use deterministic mode for:
ssh-keygen
openssl genrsa
gpg --gen-key
```

**3. Long-Running Services**
```bash
# Web servers, databases, auth services
# These NEED real entropy for security
```

---

## Comparison: OS-Level vs Per-Runtime

| Aspect | OS-Level (RNDADDENTROPY) | Per-Runtime (Patched) |
|--------|--------------------------|----------------------|
| **Implementation** | One early-boot script | Patch each runtime |
| **Coverage** | ALL programs | Only patched runtimes |
| **Maintenance** | Set-and-forget | Update on each runtime upgrade |
| **Security Impact** | System-wide | Isolated to AI inference |
| **TPM Compatibility** | ❌ Breaks attestation | ✅ TPM unaffected |
| **Multi-Tenant** | ❌ Dangerous | ✅ Safe (per-process) |
| **Overhead** | Zero | Minimal (per-inference) |
| **Recommended For** | Single-tenant research | Production multi-tenant |

---

## Final Recommendation

### **For Safebox Production:**

**Use HYBRID approach:**

1. **Default: Per-Runtime Seeding** (as currently designed)
   - llama.cpp: `get_safebox_seed()` patch
   - ONNX: Python wrapper with seed
   - whisper.cpp: Same patch as llama.cpp
   - vLLM: Sampling params with seed

2. **Optional: OS-Level Seeding** (research/debug mode)
   - Enabled via `/opt/safebox/config/inference.seed`
   - Early-boot `RNDADDENTROPY` injection
   - TPM attestation disabled
   - Single-tenant instances only
   - Clear warning in UI: "Deterministic mode reduces security"

### **Why Hybrid?**

- **Security:** Per-runtime keeps crypto operations secure
- **Flexibility:** OS-level for research/debug when needed
- **Compatibility:** TPM works in default mode
- **Isolation:** Multi-tenant safe by default

---

## Implementation Plan

### **Phase 1: Core Tooling**

```bash
# 1. Compile rngseed utility
cd /tmp
git clone https://github.com/simias/rngseed
cd rngseed
make
cp rngseed /opt/safebox/bin/

# 2. Create seed management script
cat > /opt/safebox/bin/seed-rng.sh << 'EOF'
#!/bin/bash
# ... (as shown above)
EOF
chmod +x /opt/safebox/bin/seed-rng.sh

# 3. Create systemd unit
cat > /etc/systemd/system/safebox-seed-rng.service << 'EOF'
# ... (as shown above)
EOF
systemctl enable safebox-seed-rng.service
```

### **Phase 2: Seed Generation**

```bash
# Generate a deterministic seed (256 bytes)
dd if=/dev/urandom bs=32 count=1 2>/dev/null | sha256sum | cut -d' ' -f1 > /opt/safebox/config/inference.seed

# OR use environment-specific seed
echo -n "safebox-instance-${INSTANCE_ID}-${DEPLOYMENT_ID}" | sha256sum | cut -d' ' -f1 > /opt/safebox/config/inference.seed
```

### **Phase 3: Runtime Integration**

```php
// Safebox/lib/Safebox.php
class Safebox {
    public static function isDeterministicMode(): bool {
        return file_exists('/run/safebox/deterministic-mode');
    }
    
    public static function getInferenceSeed(): ?string {
        if (!self::isDeterministicMode()) return null;
        return file_get_contents('/opt/safebox/config/inference.seed');
    }
}

// When creating execution streams
if (Safebox::isDeterministicMode()) {
    $stream->setAttribute('Safebox/deterministicMode', true);
    $stream->setAttribute('Safebox/inferenceSeed', Safebox::getInferenceSeed());
    // No per-runtime seeding needed - kernel handles it
}
```

---

## Testing Plan

### **Test 1: Verify Determinism**

```bash
# Boot with seed
echo "test_seed_12345" | sha256sum | cut -d' ' -f1 > /opt/safebox/config/inference.seed
reboot

# After boot
for i in {1..10}; do
    echo "Test prompt" | llama-cli --model gemma-4-e2b-q4.gguf --temp 1.0 --seed 0
done

# Expected: Identical output all 10 times
```

### **Test 2: Cross-Runtime Consistency**

```bash
# Same seed, different runtimes
PROMPT="Tell me a random number"

# llama.cpp
echo "$PROMPT" | llama-cli --model model.gguf > out_llama.txt

# ONNX (via Python)
python3 << EOF
import onnxruntime as ort
# ... inference ...
EOF > out_onnx.txt

# Expected: Different outputs, but REPRODUCIBLE on re-run with same seed
```

### **Test 3: Production Mode (No Seed)**

```bash
# Remove seed file
rm /opt/safebox/config/inference.seed
reboot

# After boot
for i in {1..10}; do
    echo "Test prompt" | llama-cli --model gemma-4-e2b-q4.gguf --temp 1.0 --seed 0
done

# Expected: DIFFERENT outputs (hardware entropy used)
```

---

## Conclusion

**YES, OS-level deterministic RNG is possible via `RNDADDENTROPY` ioctl.**

**Recommendation: HYBRID approach**
- Default: Per-runtime seeding (current design) ✅
- Optional: OS-level seeding for research/debug ✅
- Clear documentation of security trade-offs ✅
- Single-tenant restriction for deterministic mode ✅

**Next Steps:**
1. Implement `rngseed` utility in AMI build
2. Create `/opt/safebox/bin/seed-rng.sh` boot script
3. Add systemd unit for early-boot seeding
4. Update Safebox plugin to detect deterministic mode
5. Document security warnings prominently

**This gives us the best of both worlds: security by default, determinism when needed!** 🎯
