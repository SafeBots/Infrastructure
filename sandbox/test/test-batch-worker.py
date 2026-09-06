#!/usr/bin/env python3
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from batch_worker import run_job, Phase

fails = 0
def ok(m): print(f"  PASS {m}")
def no(m):
    global fails; fails += 1; print(f"  FAIL {m}")

class MockDriver:
    def __init__(self, fail_at=None, exit_code=0, timed_out=False, egress=None):
        self.fail_at, self.exit_code, self.timed_out = fail_at, exit_code, timed_out
        self.egress = egress or []
        self.torn_down = False
    def clone(self, job_id):
        if self.fail_at == "clone": raise RuntimeError("clone boom")
        return f"clone-{job_id}"
    def boot(self, clone_id, ca):
        if self.fail_at == "boot": raise RuntimeError("boot boom")
        return f"vm-{clone_id}"
    def run(self, vm_id, ep, t):
        if self.fail_at == "run": raise RuntimeError("run boom")
        return (self.exit_code, self.timed_out)
    def collect(self, vm_id): return self.egress
    def teardown(self, vm_id, clone_id): self.torn_down = True

# 1. happy path
d = MockDriver(exit_code=0)
r = run_job(d, "j1", ["/bin/true"], "ca.pem")
ok("happy path: ran, captured, torn down, done") if (r.exit_code == 0 and Phase.DONE in r.phases and Phase.TORN_DOWN in r.phases and d.torn_down) else no("happy path")

# 2. teardown happens even when run() throws
d = MockDriver(fail_at="run")
r = run_job(d, "j2", ["/x"], "ca.pem")
ok("run error -> still torn down (writes evaporate)") if (r.error and Phase.TORN_DOWN in r.phases and d.torn_down) else no("teardown on run error")

# 3. teardown happens even when boot throws
d = MockDriver(fail_at="boot")
r = run_job(d, "j3", ["/x"], "ca.pem")
ok("boot error -> still torn down") if (r.error and d.torn_down) else no("teardown on boot error")

# 4. timeout captured, still torn down
d = MockDriver(exit_code=None, timed_out=True)
r = run_job(d, "j4", ["/x"], "ca.pem", timeout_s=1)
ok("timeout captured + torn down") if (r.timed_out and Phase.TORN_DOWN in r.phases) else no("timeout handling")

# 5. quarantine signal from interceptor egress record
d = MockDriver(exit_code=0, egress=[{"host":"evil.com","quarantine":True,"reason":"volume_trip"}])
r = run_job(d, "j5", ["/x"], "ca.pem")
ok("interceptor quarantine signal surfaced") if (r.quarantined and Phase.DONE in r.phases) else no("quarantine signal")

print()
if fails == 0: print("✓ batch lifecycle proven: teardown ALWAYS happens; quarantine surfaced")
else: print(f"✗ {fails} failed"); sys.exit(1)
