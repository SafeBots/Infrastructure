# Qbix Hook — Streams_Message_Compression

PHP class that wires zstd-dictionary compression into the Qbix Streams_Message row lifecycle. The application sees the same JSON in and out; the database sees compressed binary.

## Files

- `Streams_Message_Compression.php` — the hook class. Wired via `Q::addEventListener()` against the row-save and row-fetch events.

## Wire-up

Add to your app's bootstrap (typically a `handlers/Q/init.php` or equivalent). After `lever-zstd-dict.sh apply` runs, the file is staged at `/opt/safebox/hooks/`:

```php
require_once '/opt/safebox/hooks/Streams_Message_Compression.php';
Streams_Message_Compression::$writeDictVersion = 1;
Streams_Message_Compression::install();
```

That's it. From this point on:

- New `Streams_Message` writes have `instructions` compressed with dictionary version 1.
- Reads of `Streams_Message` rows transparently decompress whatever's in `instructions`, including legacy plain-JSON rows from before the hook was installed.
- The hook is idempotent: if a row is already compressed (e.g. you re-save it), it won't double-compress.

## Training a dictionary

You said you'd handle this in userland PHP. Here's the recommended flow.

### 1. Sample real data

Pull a few thousand `instructions` blobs from production. The bigger and more representative the sample, the better the dictionary. 5,000-20,000 samples is a good range.

```php
<?php
// train_sample.php
require_once 'Q.inc.php'; // your Qbix bootstrap
$samples = Db_Mysql::getRows(
    "SELECT instructions FROM streams_message ORDER BY RAND() LIMIT 10000"
);
$dir = '/tmp/streams-train/';
mkdir($dir, 0700, true);
foreach ($samples as $i => $row) {
    file_put_contents(sprintf("%s/sample-%05d.json", $dir, $i), $row['instructions']);
}
echo "Wrote " . count($samples) . " samples to $dir\n";
```

### 2. Run `zstd --train`

```bash
cd /tmp/streams-train
zstd --train *.json -o /safebox/dicts/streams_instructions-v1.zdict
```

Dictionary sizes default to 110KB. You can override:

```bash
zstd --train --maxdict=65536 *.json -o /safebox/dicts/streams_instructions-v1.zdict
```

Smaller dicts compress slightly less but load faster; for the streams_message use case, 65KB-110KB is the sweet spot.

### 3. Verify compression ratio

```php
<?php
$dict = file_get_contents('/safebox/dicts/streams_instructions-v1.zdict');
$total_raw = 0;
$total_compressed = 0;
foreach (glob('/tmp/streams-train/*.json') as $f) {
    $raw = file_get_contents($f);
    $cmp = zstd_compress_dict($raw, $dict, 6);
    $total_raw += strlen($raw);
    $total_compressed += strlen($cmp) + 1;  // +1 for the version byte
}
printf("Raw:        %d bytes\n", $total_raw);
printf("Compressed: %d bytes\n", $total_compressed);
printf("Ratio:      %.2fx (%.1f%% smaller)\n",
    $total_raw / $total_compressed,
    100 * (1 - $total_compressed / $total_raw)
);
```

For Qbix `instructions` blobs, expect 6-8x. If you're seeing less than 4x, the sample is probably too small or too diverse — try a larger sample focused on a single publisher/stream type.

### 4. Place the dictionary

The lever already created `/safebox/dicts/` with appropriate ownership. Drop the `.zdict` there:

```bash
sudo cp streams_instructions-v1.zdict /safebox/dicts/
sudo chown mysql:mysql /safebox/dicts/streams_instructions-v1.zdict
```

Both the MariaDB UDF and the PHP hook read from this location.

### 5. Train v2 when conditions change

When the data shape evolves (new event types, schema changes), or every ~6-12 months, train v2 against a fresh sample. Drop it as `streams_instructions-v2.zdict`, then set:

```php
Streams_Message_Compression::$writeDictVersion = 2;
```

Old rows compressed with v1 still decompress correctly because the version byte tells the decoder which dictionary to use.

## Migrating existing rows (optional)

If you want to compress rows written before the hook was installed, run a background job in batches:

```php
<?php
$batch = 1000;
while (true) {
    $rows = Streams_Message::select()
        ->where(['LEFT(instructions, 1)' => ['{', '[']])  // legacy plain-JSON marker
        ->limit($batch)
        ->fetchDbRows();
    if (empty($rows)) break;
    foreach ($rows as $row) {
        $row->save();  // hook compresses on save
    }
    sleep(1);  // be polite
}
```

There's no rush. The hook handles mixed populations forever.

## Inspecting compressed rows

From SQL (assuming the UDF is installed):

```sql
SELECT streams_zuncompress(instructions) AS instructions
  FROM streams_message
 WHERE publisherId = 0x... AND streamName = 0x... AND ordinal = 1;
```

From PHP outside the hook:

```php
require_once '/opt/safebox/hooks/Streams_Message_Compression.php';
$json = Streams_Message_Compression::uncompress($row['instructions']);
```

## Troubleshooting

**"Dictionary not readable"**
Check `/safebox/dicts/streams_instructions-v1.zdict` exists and is world-readable (or owned by the user the PHP process runs as).

**"php-zstd extension not loaded"**
Run `php -m | grep zstd`. If missing, re-run `lever-zstd-dict.sh apply` and verify the `extension=zstd.so` line in your `php.ini`.

**Compressed rows show as garbage in admin UIs**
The admin tool is reading from MySQL directly without going through Qbix. Use the UDF in your SQL: `SELECT streams_zuncompress(instructions) FROM streams_message ...`.

**Performance regression after install**
Run `php -dextension=zstd.so -r 'var_dump(zstd_compress_dict("x", file_get_contents("/safebox/dicts/streams_instructions-v1.zdict"), 6));'` to confirm the extension actually loaded. If you see warnings, php-zstd may not have linked against the system libzstd correctly.
