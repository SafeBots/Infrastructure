# Security Hardening Guide

## Why Docker Group = Root-Equivalent

The `safebox-api` user must be in the `docker` group to talk to `/var/run/docker.sock`. This is effectively root-equivalent:

```bash
# Anyone in docker group can do this:
docker run --privileged --pid=host --net=host -v /:/host alpine chroot /host bash
# → instant root shell on host
```

**This is unavoidable.** Even with docker-socket-proxy, the API user still needs docker group membership to talk to the proxy.

## Defense Strategy: Contain the API Process

Since we can't prevent docker group = root, we **contain the API process** to make exploitation harder:

### 1. systemd Security Hardening (Maximum)

The systemd unit applies **23 security restrictions**:

```ini
# Filesystem isolation
PrivateTmp=true              # Private /tmp (can't see other processes)
ProtectSystem=strict         # Read-only /usr, /boot, /efi
ProtectHome=true             # No access to /home
ReadWritePaths=...           # Explicit write locations only

# Privilege restrictions
NoNewPrivileges=true         # Can't gain privileges via setuid
PrivateDevices=true          # No access to /dev

# Kernel protections
ProtectKernelTunables=true   # Can't modify /proc/sys
ProtectKernelModules=true    # Can't load kernel modules
ProtectKernelLogs=true       # Can't read kernel logs
ProtectControlGroups=true    # Can't modify cgroups
ProtectClock=true            # Can't set system clock

# System call restrictions
RestrictRealtime=true        # No real-time scheduling
RestrictSUIDSGID=true        # No setuid/setgid
LockPersonality=true         # Can't change execution domain
RestrictNamespaces=true      # Limits namespace creation
RestrictAddressFamilies=...  # Only AF_UNIX, AF_INET, AF_INET6

# Memory protections
MemoryDenyWriteExecute=true  # W^X - prevents code injection

# System call filtering
SystemCallFilter=@system-service       # Allowed syscalls
SystemCallFilter=~@privileged @resources @obsolete  # Blocked syscalls

# Capabilities
CapabilityBoundingSet=       # Remove ALL capabilities
```

### 2. What This Prevents

Even if an attacker achieves **code execution** in the API process:

❌ **Can't execute injected code** - `MemoryDenyWriteExecute`  
❌ **Can't load kernel modules** - `ProtectKernelModules`  
❌ **Can't modify cgroups** - `ProtectControlGroups`  
❌ **Can't setuid to root** - `RestrictSUIDSGID` + `NoNewPrivileges`  
❌ **Can't access other user files** - `ProtectHome` + `ProtectSystem`  
❌ **Limited syscalls** - `SystemCallFilter` blocks dangerous calls  

### 3. What This Doesn't Prevent

The attacker **can still**:
✅ Talk to Docker socket (docker group membership)  
✅ Start/stop containers in allowlist  
✅ Potentially escape via Docker  

**But:** The attack surface is significantly reduced. Many common exploitation techniques are blocked.

## Defense-in-Depth Layers

| Layer | What It Prevents |
|-------|------------------|
| **Safebox M-of-N governance** | Unauthorized operations |
| **Peer UID check** | Wrong process calling API |
| **HMAC verification** | Forged/tampered requests |
| **Container allowlist** | Operations on wrong containers |
| **Action allowlist** | Wrong operations (e.g. exec when not permitted) |
| **imagePattern** | Pull of arbitrary images |
| **Exponential backoff** | Rapid manipulation (churn wars) |
| **JTI replay** | Replayed operations |
| **systemd hardening** | Code execution exploitation |

**9 independent layers.** Compromise one, others still hold.

## Why We Skipped docker-socket-proxy

The proxy **doesn't prevent** a compromised API from bypassing it:

```javascript
// From inside compromised system-protocol-api:
const Docker = require('dockerode');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
// → Bypass proxy entirely, talk to Docker directly
```

The proxy only helps if:
- API code is **correct** but has **logic bug**
- Proxy catches accidental wrong endpoint call

But if API is **compromised** (RCE), attacker bypasses proxy anyway.

**Verdict:** Proxy adds complexity without meaningful security gain in this threat model.

## Additional Hardening (Optional)

### AppArmor Profile

Create `/etc/apparmor.d/safebox-system-api`:

```
#include <tunables/global>

/opt/safebox-system-api/system-protocol-api.js {
  #include <abstractions/base>
  #include <abstractions/nameservice>

  # Allow reading config
  /etc/safebox/** r,
  
  # Allow state files
  /var/lib/safebox-system-api/** rw,
  
  # Allow logging
  /var/log/safebox-system-api.log w,
  
  # Allow socket
  /run/safebox/system-api.sock rw,
  
  # Allow Docker socket (can't prevent this)
  /var/run/docker.sock rw,
  
  # Deny everything else
  /** ix,
  /bin/** ix,
  /usr/bin/** ix,
  /proc/** r,
}
```

Load:
```bash
sudo apparmor_parser -r /etc/apparmor.d/safebox-system-api
```

Update systemd unit:
```ini
[Service]
AppArmorProfile=safebox-system-api
```

### SELinux Policy (Alternative to AppArmor)

For RHEL/CentOS, create custom SELinux policy constraining the API process.

### File Integrity Monitoring

Monitor `/opt/safebox-system-api/system-protocol-api.js` for unauthorized changes:

```bash
# Using AIDE
echo "/opt/safebox-system-api/system-protocol-api.js R+b+sha256" >> /etc/aide/aide.conf
aide --update
```

### Audit Logging

Enable detailed audit of docker group operations:

```bash
# /etc/audit/rules.d/docker.rules
-a always,exit -F path=/var/run/docker.sock -F perm=rw -k docker_socket
```

## Threat Model Summary

### What We're Protecting Against

✅ **Unauthorized access** - Only Safebox can call API  
✅ **Forged requests** - HMAC prevents tampering  
✅ **Wrong operations** - Allowlist enforcement  
✅ **Churn attacks** - Exponential backoff  
✅ **Code injection** - W^X memory protection  
✅ **Privilege escalation** - systemd restrictions  

### What We Accept

⚠️ **Docker group = root** - Fundamental constraint  
⚠️ **Compromised API can abuse Docker** - Mitigated by systemd hardening  
⚠️ **Single-tenant deployment** - One Safebox per host  

### What Would Actually Compromise This

To fully compromise the host, attacker needs **both**:
1. **Code execution in API process** (RCE vulnerability)
2. **Bypass systemd restrictions** (kernel exploit, or systemd escape)

This is a **significantly higher bar** than just "compromise the API."

## Production Checklist

- [x] systemd unit with maximum hardening deployed
- [ ] AppArmor or SELinux policy configured (optional but recommended)
- [ ] File integrity monitoring on API binary
- [ ] Audit logging enabled for docker socket access
- [ ] Regular security updates to Node.js and dependencies
- [ ] Container images pinned to specific tags (not `latest`)
- [ ] imagePattern enforced in managed-containers.json
- [ ] Regular review of /var/log/safebox-system-api.log

🔒 **Defense-in-depth implemented**
