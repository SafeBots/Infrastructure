#!/usr/bin/env python3
"""resolver.py — Component 1: template resolver with digest checking.

Lives in the measured base. Enumerates app-layer files, hashes each,
resolves {{file:path@sha256:digest}} placeholders, and HALTS on mismatch.
The resolver is the ONLY component that assembles the final prompt —
the model has no path to modify a template or a resolved value.

This is the load-bearing piece: if the resolver is honest (it's in the
measured, open-source base), the model reads the real code regardless
of what the developer intended.
"""
from __future__ import annotations
import hashlib, json, os, re, time
from pathlib import Path
from typing import Optional

PLACEHOLDER_RE = re.compile(
    r'\{\{file:(?P<path>[^@]+)@sha256:(?P<digest>[a-f0-9]{64})\}\}'
)
MODEL_PIN_RE = re.compile(
    r'\{\{model:(?P<name>[^@]+)@sha256:(?P<digest>[a-f0-9]{64})\}\}'
)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def enumerate_app_layer(app_root: str) -> dict[str, str]:
    """Walk the app layer, hash every file, return {relative_path: sha256}."""
    manifest = {}
    root = Path(app_root)
    for f in sorted(root.rglob('*')):
        if f.is_file():
            rel = str(f.relative_to(root))
            manifest[rel] = sha256_file(str(f))
    return manifest


def derive_seed(query: str, template_hash: str, model_hash: str) -> int:
    """Deterministic seed from the query + template + model.
    Non-interactive: any party asking the same question about the same
    code with the same model gets the same seed → same answer."""
    combined = f"{query}|{template_hash}|{model_hash}".encode()
    h = hashlib.sha256(combined).digest()
    return int.from_bytes(h[:4], 'big') % (2**31)


class ResolutionError(Exception):
    """Hard error — digest mismatch or missing file. Never falls back."""
    pass


class ResolvedTemplate:
    """The fully-resolved prompt + metadata for the verification record."""
    def __init__(self):
        self.prompt: str = ""
        self.template_hash: str = ""
        self.file_digests: dict[str, str] = {}  # path → verified sha256
        self.model_digest: str = ""
        self.model_name: str = ""
        self.seed: int = 0
        self.timestamp: float = 0.0
        self.query: str = ""


def resolve_template(
    template: str,
    app_root: str,
    image_manifest: dict[str, str],
    query: str,
    model_name: str = "",
    model_digest: str = "",
) -> ResolvedTemplate:
    """Resolve all placeholders in a template. HALTS on any digest mismatch.

    Args:
        template: the prompt template with {{file:...}} and {{model:...}} placeholders
        app_root: root directory of the app layer
        image_manifest: {relative_path: sha256} from the attested image manifest
        query: the auditor's question (interpolated and used for seed derivation)
        model_name: the model identifier
        model_digest: expected sha256 of the model weights
    """
    result = ResolvedTemplate()
    result.template_hash = sha256_bytes(template.encode())
    result.query = query
    result.timestamp = time.time()
    result.model_name = model_name
    result.model_digest = model_digest

    resolved = template

    # Resolve model pins
    for m in MODEL_PIN_RE.finditer(template):
        name, expected = m.group('name'), m.group('digest')
        if model_digest and model_digest != expected:
            raise ResolutionError(
                f"Model digest mismatch: template expects {expected}, "
                f"running model has {model_digest}"
            )
        resolved = resolved.replace(m.group(0), f"[model:{name} verified:{expected[:12]}…]")
        result.model_digest = expected

    # Resolve file placeholders
    for fm in PLACEHOLDER_RE.finditer(template):
        rel_path, expected_digest = fm.group('path'), fm.group('digest')
        full_path = os.path.join(app_root, rel_path)

        # File must exist
        if not os.path.isfile(full_path):
            raise ResolutionError(f"File not found: {rel_path}")

        # Hash must match the declared digest
        actual_digest = sha256_file(full_path)
        if actual_digest != expected_digest:
            raise ResolutionError(
                f"Digest mismatch for {rel_path}: "
                f"template declares {expected_digest[:16]}…, "
                f"file on disk is {actual_digest[:16]}…"
            )

        # Digest must chain to the image manifest
        if rel_path in image_manifest:
            if image_manifest[rel_path] != actual_digest:
                raise ResolutionError(
                    f"Manifest mismatch for {rel_path}: "
                    f"file is {actual_digest[:16]}…, "
                    f"manifest says {image_manifest[rel_path][:16]}…"
                )

        # Read the file content and substitute
        content = Path(full_path).read_text(errors='replace')
        resolved = resolved.replace(
            fm.group(0),
            f"--- BEGIN {rel_path} (sha256:{actual_digest[:16]}…) ---\n"
            f"{content}\n"
            f"--- END {rel_path} ---"
        )
        result.file_digests[rel_path] = actual_digest

    # Interpolate the query
    resolved = resolved.replace("{{query}}", query)

    # Derive the seed
    result.seed = derive_seed(query, result.template_hash, result.model_digest or "")
    result.prompt = resolved

    return result
