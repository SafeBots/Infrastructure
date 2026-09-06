#!/usr/bin/env python3
"""batch_worker.py — the inspection-sandbox batch lifecycle (Variant 2).

Pulls untrusted jobs from a queue and runs each in an inner microVM behind the
interceptor, on one machine. This module owns the LIFECYCLE STATE MACHINE, which
is unit-testable with a mock driver; the real driver (Firecracker boot, ZFS
clone, interceptor wiring) is provided at deploy time on a Nix/VM host and is
gated on that hardware. The point of separating them: the lifecycle logic (clone
-> boot -> run-with-timeout -> capture -> ALWAYS teardown) is the part that must
be correct and can be proven here; the driver is the part that needs real infra.

A job NEVER leaves state without teardown: even on error/timeout the ZFS clone
and microVM are destroyed. Massive batteries = many workers, each running this
loop; inner microVMs are cheap and parallel (Firecracker density).
"""
from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
from typing import Protocol, Optional


class Phase(str, Enum):
    PENDING = "pending"
    CLONED = "cloned"          # ZFS clone created
    BOOTED = "booted"          # inner microVM up, single tap to interceptor
    RAN = "ran"                # job executed (exit captured) or timed out
    CAPTURED = "captured"      # results + egress record collected
    TORN_DOWN = "torn_down"    # microVM + clone destroyed
    DONE = "done"
    FAILED = "failed"


@dataclass
class JobResult:
    job_id: str
    exit_code: Optional[int] = None
    timed_out: bool = False
    egress_record: list = field(default_factory=list)   # what the interceptor saw/allowed/denied
    quarantined: bool = False                            # tripped a volume limit or pinned-and-failed
    phases: list = field(default_factory=list)
    error: Optional[str] = None


class SandboxDriver(Protocol):
    """Real impl on a Nix/VM host; mock in tests. Every method is idempotent-safe
    for teardown."""
    def clone(self, job_id: str) -> str: ...          # -> clone id
    def boot(self, clone_id: str, ca_cert: str) -> str: ...  # -> vm id (single tap)
    def run(self, vm_id: str, entrypoint: list, timeout_s: int) -> tuple[Optional[int], bool]: ...  # (exit, timed_out)
    def collect(self, vm_id: str) -> list: ...        # -> interceptor egress record
    def teardown(self, vm_id: Optional[str], clone_id: Optional[str]) -> None: ...


def run_job(driver: SandboxDriver, job_id: str, entrypoint: list,
            ca_cert: str, timeout_s: int = 900) -> JobResult:
    """Run one untrusted job through the full lifecycle. Teardown ALWAYS happens."""
    res = JobResult(job_id=job_id)
    vm_id: Optional[str] = None
    clone_id: Optional[str] = None
    try:
        res.phases.append(Phase.PENDING)
        clone_id = driver.clone(job_id)
        res.phases.append(Phase.CLONED)
        vm_id = driver.boot(clone_id, ca_cert)
        res.phases.append(Phase.BOOTED)
        exit_code, timed_out = driver.run(vm_id, entrypoint, timeout_s)
        res.exit_code, res.timed_out = exit_code, timed_out
        res.phases.append(Phase.RAN)
        res.egress_record = driver.collect(vm_id)
        # quarantine signal: interceptor flagged a volume trip or a pinned-and-failed connection
        res.quarantined = any(e.get("quarantine") for e in res.egress_record)
        res.phases.append(Phase.CAPTURED)
    except Exception as e:                       # noqa: BLE001 — capture, still tear down
        res.error = f"{type(e).__name__}: {e}"
        res.phases.append(Phase.FAILED)
    finally:
        # ALWAYS destroy the microVM and the clone — writes evaporate, hostile or not.
        try:
            driver.teardown(vm_id, clone_id)
            res.phases.append(Phase.TORN_DOWN)
        except Exception as e:                   # noqa: BLE001
            res.error = (res.error or "") + f" | teardown: {e}"
    if res.error is None:
        res.phases.append(Phase.DONE)
    return res
