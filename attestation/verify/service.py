#!/usr/bin/env python3
"""service.py — the attested verification service.

Ties together the resolver, response governor, and verification record
into a single request→response path. This is what the auditor calls.

The service lives in the measured base (open source, attested). It is the
ONLY component that assembles the final prompt. The model cannot modify
templates, resolved values, or the seed derivation. The developer cannot
influence which files are read or how digests are checked, because the
resolver runs in the base — not in their app layer.

Spot-check verification model (Solana VDF/PoH analogy):
A verifier — running in its own Safebox or using one — can replay any
verification query at any time: same template, same model, same seed →
same output hash. It doesn't need to verify every query; it spot-checks
a random sample. If any spot-check produces a different output hash, the
Safebox that produced the original is provably dishonest. This is the same
economic argument as Solana's Proof of History: verification is cheaper
than production, so a small number of spot-checks makes dishonesty
unprofitable. The Safebox produces verification records continuously;
verifiers spot-check asynchronously; any mismatch is a provable violation.
"""
from __future__ import annotations
import hashlib, json, os, time
from pathlib import Path
from typing import Optional

from .resolver import (
    resolve_template, enumerate_app_layer, sha256_bytes,
    sha256_file, ResolutionError, ResolvedTemplate,
)
from .verification_record import (
    VerificationRecord, ResponseGovernor, RiskLevel,
)


# The default template for code property verification.
# The base ships this; it's in the measured closure.
DEFAULT_TEMPLATE = """You are a code auditor operating inside an attested Safebox.
The following files are installed in the app layer. Their paths and SHA-256
digests are listed below, and their full contents have been loaded for you.
Answer the auditor's question about properties of this code. Do NOT reproduce
substantial portions of the source code. State properties, not implementations.

{{file_manifest}}

AUDITOR'S QUESTION: {{query}}"""


def build_manifest_block(manifest: dict[str, str]) -> str:
    """Build the file-manifest block for the prompt, listing every file + digest."""
    lines = []
    for path in sorted(manifest.keys()):
        digest = manifest[path]
        lines.append(f"- {path}  sha256:{digest[:16]}…")
    return "\n".join(lines)


def build_file_template(manifest: dict[str, str]) -> str:
    """Build a template with {{file:...}} placeholders for every app-layer file."""
    parts = [DEFAULT_TEMPLATE.replace("{{file_manifest}}",
             build_manifest_block(manifest))]
    # Add file-content placeholders for each file
    for path in sorted(manifest.keys()):
        parts.append(f"\n{{{{file:{path}@sha256:{manifest[path]}}}}}")
    return "\n".join(parts)


class VerificationService:
    """The end-to-end verification service.

    verify() is the single entry point: query in, verification record out.
    """

    def __init__(
        self,
        app_root: str,
        image_manifest: dict[str, str],
        model_name: str = "",
        model_digest: str = "",
        runtime_digest: str = "",
        tokenizer_digest: str = "",
        attestation_quote: str = "",
        image_hash: str = "",
        governor_config: Optional[dict] = None,
    ):
        self.app_root = app_root
        self.image_manifest = image_manifest
        self.model_name = model_name
        self.model_digest = model_digest
        self.runtime_digest = runtime_digest
        self.tokenizer_digest = tokenizer_digest
        self.attestation_quote = attestation_quote
        self.image_hash = image_hash
        self.governor = ResponseGovernor(governor_config)
        # Cache source contents for verbatim detection
        self._source_cache: dict[str, str] = {}

    def _load_source(self, path: str) -> str:
        if path not in self._source_cache:
            full = os.path.join(self.app_root, path)
            try:
                self._source_cache[path] = Path(full).read_text(errors='replace')
            except OSError:
                self._source_cache[path] = ""
        return self._source_cache[path]

    def verify(
        self,
        query: str,
        querier_id: str = "anonymous",
        template: Optional[str] = None,
        model_output_fn=None,
    ) -> VerificationRecord:
        """Run a verification query end-to-end.

        Args:
            query: the auditor's natural-language question
            querier_id: identifier for rate-limiting
            template: custom template (or None for the default)
            model_output_fn: callable(prompt, seed) → str; the actual LLM call.
                In production this calls the co-located model via the Unix socket.
                In tests this is a mock.

        Returns:
            VerificationRecord with the full cryptographic receipt.
        """
        record = VerificationRecord()
        record.query = query
        record.timestamp = time.time()
        record.attestation_quote = self.attestation_quote
        record.image_hash = self.image_hash
        record.model_name = self.model_name
        record.model_weights_digest = self.model_digest
        record.tokenizer_digest = self.tokenizer_digest
        record.runtime_digest = self.runtime_digest
        record.governor_config_hash = self.governor.config_hash()

        # Build the template from the app-layer manifest if none provided
        if template is None:
            app_manifest = enumerate_app_layer(self.app_root)
            template = build_file_template(app_manifest)

        record.template_hash = sha256_bytes(template.encode())

        # Resolve the template — HALTS on any digest mismatch
        resolved = resolve_template(
            template, self.app_root, self.image_manifest,
            query, self.model_name, self.model_digest,
        )
        record.file_digests = resolved.file_digests
        record.seed = resolved.seed
        record.seed_derivation = "SHA256(query|template_hash|model_hash) mod 2^31"
        record.temperature = 0.0  # deterministic

        # Call the model
        if model_output_fn is None:
            record.output = "[model not connected — verification record only]"
        else:
            record.output = model_output_fn(resolved.prompt, resolved.seed)

        # Governor: classify risk
        risk = self.governor.classify_risk(query, record.output)
        record.risk_classification = risk.value

        # Governor: check budget
        allowed, reason = self.governor.check_budget(querier_id, risk)
        if not allowed:
            record.output = f"[blocked by response governor: {reason}]"
            record.output_hash = sha256_bytes(record.output.encode())
            return record

        # Governor: verbatim detection
        source_contents = {p: self._load_source(p) for p in record.file_digests}
        verbatim_match = self.governor.check_verbatim(record.output, source_contents)
        if verbatim_match:
            record.output = f"[suppressed by verbatim detector: {verbatim_match}]"
            record.output_hash = sha256_bytes(record.output.encode())
            return record

        # Governor: length cap
        record.output = self.governor.enforce_length(record.output)

        # Hash the final output — the commitment
        record.output_hash = sha256_bytes(record.output.encode())

        return record
