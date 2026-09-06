#!/usr/bin/env python3
"""End-to-end test of the attested verification service.

Tests: resolver digest checking, seed determinism, governor risk classification,
verbatim detection, budget enforcement, drift detection, and the full
verify() path with a mock model.
"""
import os, sys, json, tempfile, shutil
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from attestation.verify.resolver import (
    resolve_template, enumerate_app_layer, derive_seed,
    sha256_file, sha256_bytes, ResolutionError,
)
from attestation.verify.verification_record import (
    VerificationRecord, ResponseGovernor, RiskLevel,
)
from attestation.verify.service import VerificationService

fails = 0
def ok(m): print(f"  PASS {m}")
def no(m):
    global fails; fails += 1; print(f"  FAIL {m}")

# --- Setup: create a fake app layer ---
tmp = tempfile.mkdtemp(prefix="safebox-verify-test-")
os.makedirs(os.path.join(tmp, "auth"), exist_ok=True)
login_code = 'function login(user, pass) {\n  const hash = bcrypt(pass);\n  return db.check(user, hash);\n}\n'
with open(os.path.join(tmp, "auth", "login.js"), 'w') as f:
    f.write(login_code)
config_json = '{"db": "postgres://localhost/app", "debug": false}\n'
with open(os.path.join(tmp, "config.json"), 'w') as f:
    f.write(config_json)

# Build manifest
manifest = enumerate_app_layer(tmp)
login_hash = manifest["auth/login.js"]
config_hash = manifest["config.json"]

# === 1. Resolver: correct digest → resolves ===
template = f"Check this: {{{{file:auth/login.js@sha256:{login_hash}}}}}\n\nQuestion: {{{{query}}}}"
try:
    resolved = resolve_template(template, tmp, manifest, "is bcrypt used?")
    ok("resolver: correct digest resolves") if "bcrypt" in resolved.prompt else no("resolver: content not in prompt")
except Exception as e:
    no(f"resolver: {e}")

# === 2. Resolver: wrong digest → HALTS ===
bad_template = f"Check: {{{{file:auth/login.js@sha256:{'0'*64}}}}}\n{{{{query}}}}"
try:
    resolve_template(bad_template, tmp, manifest, "test")
    no("resolver: should have halted on wrong digest")
except ResolutionError:
    ok("resolver: wrong digest → hard halt (never falls back)")

# === 3. Resolver: missing file → HALTS ===
missing_template = f"Check: {{{{file:nonexistent.js@sha256:{'a'*64}}}}}\n{{{{query}}}}"
try:
    resolve_template(missing_template, tmp, manifest, "test")
    no("resolver: should have halted on missing file")
except ResolutionError:
    ok("resolver: missing file → hard halt")

# === 4. Seed determinism: same query → same seed ===
s1 = derive_seed("is bcrypt used?", "tmpl123", "model456")
s2 = derive_seed("is bcrypt used?", "tmpl123", "model456")
s3 = derive_seed("different question", "tmpl123", "model456")
ok("seed determinism: same inputs → same seed") if s1 == s2 else no("seed not deterministic")
ok("seed determinism: different query → different seed") if s1 != s3 else no("seed collision")

# === 5. Governor: risk classification ===
gov = ResponseGovernor()
ok("governor: general") if gov.classify_risk("does this use bcrypt?", "yes") == RiskLevel.GENERAL else no("classify general")
ok("governor: verbatim detection") if gov.classify_risk("show me the code of login.js", "") == RiskLevel.VERBATIM else no("classify verbatim")
ok("governor: statistical") if gov.classify_risk("how many files use bcrypt?", "") == RiskLevel.STATISTICAL else no("classify statistical")

# === 6. Governor: verbatim suppression ===
sources = {"auth/login.js": login_code}
response_with_verbatim = f"The login function is: {login_code}"
match = gov.check_verbatim(response_with_verbatim, sources)
ok("governor: verbatim substring detected and flagged") if match else no("verbatim not caught")

clean_response = "The login function uses bcrypt to hash passwords before database lookup."
match2 = gov.check_verbatim(clean_response, sources)
ok("governor: clean paraphrase passes verbatim check") if match2 is None else no("false positive on paraphrase")

# === 7. Governor: budget enforcement ===
allowed, _ = gov.check_budget("auditor-1", RiskLevel.VERBATIM)
ok("governor: verbatim always refused") if not allowed else no("verbatim allowed")

# === 8. Governor: drift detection ===
gov2 = ResponseGovernor({"drift_window": 5, "drift_specific_threshold": 3,
                          "specific_limit_per_day": 100, "statistical_limit_per_hour": 100,
                          "verbatim_threshold_chars": 80, "max_response_chars": 2000,
                          "general_limit": 999999})
for _ in range(3):
    gov2.check_budget("drifter", RiskLevel.SPECIFIC)
allowed, reason = gov2.check_budget("drifter", RiskLevel.SPECIFIC)
ok("governor: drift detection blocks extraction pattern") if not allowed and "pattern" in reason else no(f"drift not caught: {reason}")

# === 9. Full verify() path with mock model ===
def mock_model(prompt, seed):
    return f"Based on the code, bcrypt is used for password hashing. [seed={seed}]"

svc = VerificationService(
    app_root=tmp,
    image_manifest=manifest,
    model_name="test-model",
    model_digest="a" * 64,
    attestation_quote="test-quote",
    image_hash="img-hash",
)
record = svc.verify("does this use bcrypt for passwords?", "auditor-1", model_output_fn=mock_model)
ok("verify: returns a record") if record.output_hash else no("no output hash")
ok("verify: record has file digests") if record.file_digests else no("no file digests")
ok("verify: record has seed") if record.seed > 0 else no("no seed")
ok("verify: record has attestation") if record.attestation_quote else no("no attestation")
ok("verify: output contains model response") if "bcrypt" in record.output else no("model response missing")
ok("verify: record serializes to JSON") if json.loads(record.to_json()) else no("JSON broken")

# === 10. Spot-check verifier: same query → same seed → same output hash ===
import json
record2 = svc.verify("does this use bcrypt for passwords?", "auditor-2", model_output_fn=mock_model)
ok("spot-check: same query → same seed") if record.seed == record2.seed else no(f"seeds differ: {record.seed} vs {record2.seed}")
ok("spot-check: same query+model → same output hash") if record.output_hash == record2.output_hash else no("output hashes differ (determinism broken)")

# Cleanup
shutil.rmtree(tmp)

print()
if fails == 0:
    print("✓ verification service proven: resolver halts on mismatch, seeds deterministic,")
    print("  governor classifies+limits+detects drift+suppresses verbatim,")
    print("  full path produces verifiable records, spot-checks reproduce")
else:
    print(f"✗ {fails} failed"); sys.exit(1)
