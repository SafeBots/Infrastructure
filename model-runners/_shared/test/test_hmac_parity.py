#!/usr/bin/env python3
"""Cross-repo HMAC parity test — the runner side of the contract.

Signs a request the auth.js / Safebox LocalRunner way (strong canonical form)
and asserts the shared verifier accepts it, and that weak-form, endpoint-swap,
nonce-replay, and expired-timestamp requests are all rejected. This is the
runner-side twin of Safebox's cross-repo parity test; both check against the
one canonical string in safebox_auth.py.

Run: SAFEBOX_REQUIRE_HMAC=true python3 test_hmac_parity.py
"""
import hashlib, hmac, os, sys, time, tempfile

os.environ["SAFEBOX_REQUIRE_HMAC"] = "true"
_keyfile = tempfile.NamedTemporaryFile(delete=False, mode="w")
_keyfile.write("parity-secret"); _keyfile.close()
os.environ["HMAC_KEY_PATH"] = _keyfile.name

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import safebox_auth  # noqa: E402

SECRET = "parity-secret"

class _Req:
    def __init__(self, method, path, headers):
        self.method = method; self.headers = headers
        self.url = type("U", (), {"path": path})()

def _strong_sig(ts, nonce, method, path, body):
    bh = hashlib.sha256(body).hexdigest()
    canon = f"{ts}\n{nonce}\n{method}\n{path}\n{bh}"
    return hmac.new(SECRET.encode(), canon.encode(), hashlib.sha256).hexdigest()

def run():
    body = b'{"model":"m","input":"hi"}'
    ts = str(int(time.time())); nonce = "n1"
    ok = 0; fail = 0
    def check(name, cond):
        nonlocal ok, fail
        print(("  PASS " if cond else "  FAIL ") + name)
        ok += cond; fail += (not cond)

    sig = _strong_sig(ts, nonce, "POST", "/v1/embed", body)
    check("strong-form accepted",
          safebox_auth.verify_hmac(_Req("POST","/v1/embed",
              {"X-Safebox-Signature":sig,"X-Safebox-Timestamp":ts,"X-Safebox-Nonce":nonce}), body))
    check("endpoint-swap rejected",
          not safebox_auth.verify_hmac(_Req("POST","/v1/chat",
              {"X-Safebox-Signature":sig,"X-Safebox-Timestamp":ts,"X-Safebox-Nonce":"n2"}), body))
    check("nonce-replay rejected",
          not safebox_auth.verify_hmac(_Req("POST","/v1/embed",
              {"X-Safebox-Signature":sig,"X-Safebox-Timestamp":ts,"X-Safebox-Nonce":nonce}), body))
    weak = hmac.new(SECRET.encode(), ts.encode()+b"."+nonce.encode()+b"."+body, hashlib.sha256).hexdigest()
    check("weak-form rejected",
          not safebox_auth.verify_hmac(_Req("POST","/v1/embed",
              {"X-Safebox-Signature":weak,"X-Safebox-Timestamp":ts,"X-Safebox-Nonce":"n3"}), body))
    ots = str(int(time.time())-400)
    osig = _strong_sig(ots, "n4", "POST", "/v1/embed", body)
    check("expired-timestamp rejected",
          not safebox_auth.verify_hmac(_Req("POST","/v1/embed",
              {"X-Safebox-Signature":osig,"X-Safebox-Timestamp":ots,"X-Safebox-Nonce":"n4"}), body))
    print(f"\n{ok} passed, {fail} failed")
    return fail == 0

if __name__ == "__main__":
    sys.exit(0 if run() else 1)
