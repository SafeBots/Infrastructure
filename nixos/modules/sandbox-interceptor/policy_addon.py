"""mitmproxy addon: deny-default host allowlist + volume metering + audit.

Loaded by the interceptor (sandbox-host.nix). Reads the policy JSON named by the
safebox_policy option. This is the v0 control-plane; the hardened U-written
version replaces it in the fast-follow. Fail-closed: unknown host -> block.
"""
import json, hashlib
from mitmproxy import http, ctx

_policy = {"allowlist_hosts": [], "deny_default": True, "volume_metering": {}, "audit": {}}
_bytes_out = {}   # host -> bytes
_total_out = 0

def load(loader):
    loader.add_option("safebox_policy", str, "", "Path to the interceptor policy JSON")

def configure(updated):
    global _policy
    if "safebox_policy" in updated and ctx.options.safebox_policy:
        with open(ctx.options.safebox_policy) as f:
            _policy = json.load(f)

def _allowed(host: str) -> bool:
    for h in _policy.get("allowlist_hosts", []):
        if host == h or host.endswith("." + h):
            return True
    return not _policy.get("deny_default", True)

def request(flow: http.HTTPFlow):
    host = flow.request.pretty_host
    if not _allowed(host):
        flow.response = http.Response.make(403, b"blocked by safebox interceptor: host not on allowlist")
        ctx.log.warn(f"[safebox] DENY {host} (deny-default)")
        return
    # audit: metadata + body hash (accountability without hoarding plaintext)
    if _policy.get("audit", {}).get("log_plaintext_hashes", True):
        bh = hashlib.sha256(flow.request.raw_content or b"").hexdigest()[:16]
        ctx.log.info(f"[safebox] REQ {flow.request.method} {host}{flow.request.path} body={bh}")

def response(flow: http.HTTPFlow):
    global _total_out
    host = flow.request.pretty_host
    n = len(flow.request.raw_content or b"")
    _bytes_out[host] = _bytes_out.get(host, 0) + n
    _total_out += n
    vm = _policy.get("volume_metering", {})
    ph = vm.get("per_host_bytes_out_limit")
    tot = vm.get("total_bytes_out_limit")
    if (ph and _bytes_out[host] > ph) or (tot and _total_out > tot):
        # quarantine signal: the worker reads this from the audit log/egress record
        ctx.log.warn(f"[safebox] QUARANTINE volume trip host={host} out={_bytes_out[host]} total={_total_out}")
