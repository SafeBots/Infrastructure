# Compression Levers

Two layers of compression for the Safebox database footprint, each independently togglable.

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 2 (optional) — zstd dictionary compression                │
│   streams_message.instructions blobs, compressed with a trained │
│   dictionary. ~6-8x on Qbix's JSON shape.                       │
│                                                                  │
│ Applies at: Qbix Db hook (write/read seam) + MariaDB UDF       │
│ Lever:      ./lever-zstd-dict.sh                                │
├─────────────────────────────────────────────────────────────────┤
│ Layer 1 (recommended baseline) — ZFS zstd-3 compression         │
│   Entire dataset is compressed at the block layer. ~3-4x on the │
│   mix of JSON, indexes, undo, redo, and binlogs.                │
│                                                                  │
│ Applies at: ZFS dataset property                                │
│ Lever:      ./lever-zfs-compression.sh                          │
└─────────────────────────────────────────────────────────────────┘
```

The two layers don't stack. ZFS sees already-compressed bytes as random noise and can't squeeze them further. Pick the right combination:

- **Layer 1 only** is the default. Truly transparent, ~3-4x compression, no app code involved, no migration. Recommended starting point.
- **Layer 2 only** makes sense if you can't run ZFS (cloud volumes, non-ZFS filesystems) and want the compression to travel with the data.
- **Layer 1 + Layer 2** is reasonable. Layer 2 compresses the `instructions` column at the application layer, then Layer 1 compresses everything else (other columns, indexes, redo log, binlogs, undo). You don't get multiplicative ratios on the `instructions` column itself, but the rest of the data still benefits from ZFS.

For the streams_message table specifically — which is the place this conversation started — Layer 2 is where the big win is. The `instructions` JSON has near-identical keys and value prefixes across millions of rows, which is exactly what trained zstd dictionaries are designed for.

## Quick start

```bash
# Layer 1 — ZFS zstd-3 on the data pool. One command.
sudo ./lever-zfs-compression.sh apply

# Layer 2 — installs libzstd, php-zstd, builds and registers the UDF,
# and stages the Qbix hook. Train your own dictionary afterward.
sudo ./lever-zstd-dict.sh apply

# Check what's running:
./status.sh
```

## Documents in this directory

- `README.md` — this file
- `lever-zfs-compression.sh` — Layer 1 lever
- `lever-zstd-dict.sh` — Layer 2 lever (installer)
- `status.sh` — read-only status of both layers
- `udf/` — the MariaDB UDF for SQL-level decompression
- `qbix/` — the Qbix Db hook (PHP) that wraps writes and reads
- `dict/` — where trained zstd dictionaries live at runtime

## What this doesn't do

- It does not train a dictionary for you. Training is a userland step you do once against a sample of real data. See `qbix/README.md` for the recommended training flow.
- It does not migrate existing uncompressed rows. The Qbix hook reads both formats — uncompressed legacy rows stay readable forever — but it only compresses new writes. If you want to rewrite existing rows, do it on your own schedule with a bounded background job.
- It does not change the wire protocol or how the application sees the column. The `instructions` column reads back as the same JSON string the application stored, regardless of which layer is on.
