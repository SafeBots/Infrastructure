# Levers

Operational toggles that change Safebox behavior at runtime without changing application code.

Each lever is a self-contained directory under this one. A lever is idempotent: running it twice has the same effect as running it once. A lever has a status check and, where the change is reversible, a revert path.

The convention is:

| Script | What it does |
|---|---|
| `lever-*.sh` | Apply the change. Pass `--dry-run` to preview, `--revert` to roll back. |
| `status.sh` | Report current state. Read-only. Safe to run any time. |

Levers do not depend on each other unless explicitly noted. They can be applied in any order and on any subset.

## Current levers

| Path | What it controls | Reversible? |
|---|---|---|
| `compression/` | ZFS dataset compression + zstd-dictionary compression of `streams_message.instructions` | Yes (both layers) |

## Why levers

Safebox AMIs bake to a deterministic baseline. Levers are the place to flip specific behaviors per deployment — compression ratios, performance tunings, optional features — without forking the AMI build or shipping a new image.

Each lever is also a place where operational state lives in version control. The shell script is the spec; the README next to it is the explanation; the status output is the truth.
