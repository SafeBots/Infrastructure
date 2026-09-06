#!/usr/bin/env python3
"""verification_record.py — the verification record and response governor.

Component 2: The record that accompanies every verification response, binding
the answer to the template, files, model, seed, and attestation.

Component 3: The response governor — rate limits and length caps classified
by exfiltration risk, with verbatim detection against the source.
"""
from __future__ import annotations
import hashlib, json, time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class RiskLevel(str, Enum):
    """Exfiltration risk classification for content-aware rate limiting."""
    GENERAL = "general"           # property assertions — unrestricted
    STATISTICAL = "statistical"   # aggregate summaries — generous cap
    SPECIFIC = "specific"         # implementation details — tight budget
    VERBATIM = "verbatim"         # source reproduction — refused outright


@dataclass
class VerificationRecord:
    """The cryptographic receipt proving what was asked, what was read,
    which model answered, and that the answer is deterministically reproducible."""
    # What was asked
    template_hash: str = ""          # hash of the template WITH placeholders unresolved
    query: str = ""                  # the auditor's question
    # What was read
    file_digests: dict = field(default_factory=dict)  # {path: verified sha256}
    manifest_chain: dict = field(default_factory=dict)  # {path: manifest_entry_hash}
    # Which model answered
    model_name: str = ""
    model_weights_digest: str = ""
    tokenizer_digest: str = ""
    runtime_digest: str = ""
    # Determinism
    seed: int = 0
    seed_derivation: str = ""        # "SHA256(query|template_hash|model_hash) mod 2^31"
    temperature: float = 0.0
    # The answer
    output: str = ""
    output_hash: str = ""            # SHA256 of the raw output — the commitment
    # Attestation
    attestation_quote: str = ""      # the hardware attestation for the running image
    image_hash: str = ""             # measurement of the running Safebox base
    # Meta
    timestamp: float = 0.0
    governor_config_hash: str = ""   # proves the rate-limit policy was the attested one
    risk_classification: str = ""

    def to_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if v}

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)


@dataclass
class GovernorBudget:
    """Per-querying-party budget tracker for content-aware rate limiting."""
    general_remaining: int = 999999     # effectively unlimited
    statistical_remaining: int = 50     # per hour
    specific_remaining: int = 10        # per day
    verbatim_remaining: int = 0         # always zero — refused outright
    last_reset_hour: float = 0.0
    last_reset_day: float = 0.0
    query_history: list = field(default_factory=list)  # for drift detection


class ResponseGovernor:
    """Content-aware rate limiter + verbatim detector.

    Classifies responses by exfiltration risk and applies differentiated
    constraints. Detects drift from general → specific (incremental extraction).
    Verbatim detection compares proposed output against the actual source files.
    """

    def __init__(self, config: Optional[dict] = None):
        self.config = config or {
            "general_limit": 999999,
            "statistical_limit_per_hour": 50,
            "specific_limit_per_day": 10,
            "verbatim_threshold_chars": 80,
            "max_response_chars": 2000,
            "drift_window": 10,
            "drift_specific_threshold": 5,
        }
        self.budgets: dict[str, GovernorBudget] = {}

    def config_hash(self) -> str:
        return hashlib.sha256(json.dumps(self.config, sort_keys=True).encode()).hexdigest()

    def classify_risk(self, query: str, response: str) -> RiskLevel:
        """Classify the exfiltration risk of a query+response pair."""
        q_lower = query.lower()
        r_lower = response.lower()

        # Verbatim requests
        verbatim_signals = [
            "show me the code", "print the source", "what does line",
            "reproduce", "copy the file", "paste the contents",
            "show the implementation", "display the function",
        ]
        if any(s in q_lower for s in verbatim_signals):
            return RiskLevel.VERBATIM

        # Specific implementation
        specific_signals = [
            "what function", "which variable", "how is .* implemented",
            "what does .* do specifically", "the exact logic",
            "line by line", "step through",
        ]
        if any(s in q_lower for s in specific_signals):
            return RiskLevel.SPECIFIC

        # Statistical
        statistical_signals = [
            "how many", "count of", "percentage", "statistics",
            "distribution", "summary of", "aggregate",
        ]
        if any(s in q_lower for s in statistical_signals):
            return RiskLevel.STATISTICAL

        return RiskLevel.GENERAL

    def check_verbatim(self, response: str, source_contents: dict[str, str]) -> Optional[str]:
        """Check if the response contains verbatim source exceeding threshold.
        Returns the matched substring if found, None if clean."""
        threshold = self.config.get("verbatim_threshold_chars", 80)
        for path, content in source_contents.items():
            # Sliding window check
            for i in range(len(content) - threshold + 1):
                window = content[i:i + threshold]
                if window in response:
                    return f"verbatim match from {path} ({threshold}+ chars)"
        return None

    def check_budget(self, querier_id: str, risk: RiskLevel) -> tuple[bool, str]:
        """Check if the querier has budget for this risk level.
        Returns (allowed, reason)."""
        if querier_id not in self.budgets:
            self.budgets[querier_id] = GovernorBudget()
        budget = self.budgets[querier_id]

        now = time.time()
        # Reset hourly/daily budgets
        if now - budget.last_reset_hour > 3600:
            budget.statistical_remaining = self.config["statistical_limit_per_hour"]
            budget.last_reset_hour = now
        if now - budget.last_reset_day > 86400:
            budget.specific_remaining = self.config["specific_limit_per_day"]
            budget.last_reset_day = now

        if risk == RiskLevel.VERBATIM:
            return False, "verbatim source reproduction refused"
        elif risk == RiskLevel.SPECIFIC:
            if budget.specific_remaining <= 0:
                return False, "specific-detail daily budget exhausted"
            budget.specific_remaining -= 1
        elif risk == RiskLevel.STATISTICAL:
            if budget.statistical_remaining <= 0:
                return False, "statistical-summary hourly budget exhausted"
            budget.statistical_remaining -= 1

        # Drift detection: too many specific queries in recent window
        budget.query_history.append((now, risk.value))
        window = self.config.get("drift_window", 10)
        recent = [r for t, r in budget.query_history[-window:]]
        specific_count = sum(1 for r in recent if r in ("specific", "verbatim"))
        if specific_count >= self.config.get("drift_specific_threshold", 5):
            return False, "extraction pattern detected: too many specific queries in recent window"

        return True, "ok"

    def enforce_length(self, response: str) -> str:
        """Truncate response to the configured maximum."""
        max_chars = self.config.get("max_response_chars", 2000)
        if len(response) > max_chars:
            return response[:max_chars] + "\n[response truncated by governor]"
        return response
