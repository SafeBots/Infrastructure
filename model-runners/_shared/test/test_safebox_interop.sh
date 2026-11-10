#!/usr/bin/env bash
# End-to-end Safebox<->runner HMAC interop: sign a request the auth.js /
# LocalRunner way in Node, verify it with the Python shared module that every
# runner delegates to. Proves the cross-repo, cross-language seam holds.
set -euo pipefail
cd "$(dirname "$0")"
KEY=$(mktemp); echo "interop-secret" > "$KEY"
trap "rm -f $KEY /tmp/_sb_signed.json" EXIT

node - <<'JS' > /tmp/_sb_signed.json
const c=require("crypto"), secret="interop-secret";
const method="POST", path="/v1/chat/completions";
const body=Buffer.from(JSON.stringify({model:"m",messages:[{role:"user",content:"ping"}]}));
const ts=String(Math.floor(Date.now()/1000)), nonce=c.randomBytes(12).toString("hex");
const bh=c.createHash("sha256").update(body).digest("hex");
const canon=[ts,nonce,method,path,bh].join("\n");
const sig=c.createHmac("sha256",secret).update(canon).digest("hex");
console.log(JSON.stringify({ts,nonce,method,path,sig,body:body.toString("base64")}));
JS

SAFEBOX_REQUIRE_HMAC=true HMAC_KEY_PATH="$KEY" python3 - <<'PY'
import json,base64,sys,os
sys.path.insert(0,os.path.join(os.path.dirname(__file__) if "__file__" in dir() else ".",".."))
sys.path.insert(0,"..")
import safebox_auth
s=json.load(open("/tmp/_sb_signed.json")); body=base64.b64decode(s["body"])
R=lambda m,p,h: type("R",(),{"method":m,"headers":h,"url":type("U",(),{"path":p})()})()
ok=safebox_auth.verify_hmac(R(s["method"],s["path"],{
  "X-Safebox-Signature":s["sig"],"X-Safebox-Timestamp":s["ts"],"X-Safebox-Nonce":s["nonce"]}),body)
print("  PASS  Node/auth.js-signed request verified by Python runner module" if ok
      else "  FAIL  interop broken"); sys.exit(0 if ok else 1)
PY
