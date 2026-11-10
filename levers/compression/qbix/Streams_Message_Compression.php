<?php
/**
 * Streams_Message_Compression
 *
 * Transparent zstd-dictionary compression for streams_message.instructions.
 *
 * Wire-up (in your app's bootstrap, e.g. Q/handlers/Q/init.php):
 *
 *     require_once '/opt/safebox/hooks/Streams_Message_Compression.php';
 *     Streams_Message_Compression::install();
 *
 * After install():
 *   - Writes to streams_message.instructions are compressed with the current dict version.
 *   - Reads from streams_message.instructions are transparently decompressed.
 *   - Legacy uncompressed rows (first char '{' or '[') are returned as-is.
 *
 * Blob format:
 *   [1 byte dict version][zstd raw frame]
 *
 *   Version 0x01..0x0F   — compressed with dictionary version N
 *   Version 0x7B ('{')   — legacy plain JSON, no compression (returned as-is)
 *   Version 0x5B ('[')   — legacy plain JSON array, no compression (returned as-is)
 *
 * The MariaDB UDF streams_zuncompress() understands the same format.
 *
 * Requires: php-zstd extension (>= 0.10.0 for dict support).
 */
class Streams_Message_Compression
{
    /** Active dictionary version used for new writes. Bump when you train a new dict. */
    public static $writeDictVersion = 1;

    /** Directory holding dictionaries. */
    public static $dictDir = '/safebox/dicts/';

    /** Compression level for zstd. 3 is a good default. 6 trades CPU for ~5% smaller. */
    public static $compressionLevel = 6;

    /** Dictionary cache: [version => binary string]. Loaded lazily, kept for the request. */
    private static $dictCache = [];

    /** Whether the hooks have been installed. */
    private static $installed = false;

    /**
     * Wire compress/decompress into Streams_Message lifecycle.
     */
    public static function install()
    {
        if (self::$installed) return;
        if (!extension_loaded('zstd')) {
            throw new Q_Exception(
                "php-zstd extension not loaded. Install with: pecl install zstd"
            );
        }

        // Compress on the way in. The Streams_Message row's `instructions`
        // field is JSON-encoded by Streams before save; we operate on the
        // serialized string.
        Q::addEventListener(
            'Db/Row/Streams_Message/saveExecute/before',
            ['Streams_Message_Compression', 'onBeforeSave']
        );

        // Decompress on the way out. Streams fetches rows and gives us the
        // raw column value; we replace it with the original JSON string.
        Q::addEventListener(
            'Db/Row/Streams_Message/retrieveExecute/after',
            ['Streams_Message_Compression', 'onAfterFetch']
        );

        self::$installed = true;
    }

    /**
     * Called before a Streams_Message row is INSERTed or UPDATEd.
     *
     * @param array $params  ['row' => Streams_Message]
     */
    public static function onBeforeSave($params)
    {
        $row = $params['row'];
        if (!isset($row->instructions) || $row->instructions === '') return;

        $raw = $row->instructions;
        if (!is_string($raw)) return;

        // Idempotent: if already compressed, leave it alone.
        if (self::isCompressedBlob($raw)) return;

        $row->instructions = self::compress($raw, self::$writeDictVersion);
    }

    /**
     * Called after a Streams_Message row is fetched from the DB.
     *
     * @param array $params  ['rows' => array of Streams_Message]
     */
    public static function onAfterFetch($params)
    {
        $rows = isset($params['rows']) ? $params['rows'] : [];
        if (!is_array($rows)) $rows = [$rows];
        foreach ($rows as $row) {
            if (!$row) continue;
            if (!isset($row->instructions) || $row->instructions === '') continue;
            $raw = $row->instructions;
            if (!is_string($raw)) continue;
            if (!self::isCompressedBlob($raw)) continue;
            $row->instructions = self::uncompress($raw);
        }
    }

    /**
     * Compress a JSON string using the given dictionary version.
     *
     * @param string $text          The raw JSON (or any UTF-8 text)
     * @param int    $dictVersion   1..15
     * @return string               [1 byte version][zstd frame]
     */
    public static function compress($text, $dictVersion)
    {
        if (!is_int($dictVersion) || $dictVersion < 1 || $dictVersion > 15) {
            throw new Q_Exception("Invalid dict version: $dictVersion (must be 1..15)");
        }
        $dict = self::loadDict($dictVersion);
        $compressed = zstd_compress_dict($text, $dict, self::$compressionLevel);
        if ($compressed === false) {
            throw new Q_Exception("zstd_compress_dict failed for version $dictVersion");
        }
        return chr($dictVersion) . $compressed;
    }

    /**
     * Decompress a blob produced by compress(), or return legacy JSON as-is.
     *
     * @param string $blob
     * @return string
     */
    public static function uncompress($blob)
    {
        if (!is_string($blob) || $blob === '') return $blob;

        $first = ord($blob[0]);

        // Legacy plain JSON (starts with '{' or '['), return as-is.
        if ($first === 0x7B /* { */ || $first === 0x5B /* [ */) {
            return $blob;
        }

        if ($first < 1 || $first > 15) {
            throw new Q_Exception(sprintf(
                "Unknown compression marker 0x%02X in instructions blob", $first
            ));
        }

        $dict = self::loadDict($first);
        $out  = zstd_uncompress_dict(substr($blob, 1), $dict);
        if ($out === false) {
            throw new Q_Exception("zstd_uncompress_dict failed for version $first");
        }
        return $out;
    }

    /**
     * Returns true if the given string looks like a compressed blob.
     */
    public static function isCompressedBlob($s)
    {
        if (!is_string($s) || strlen($s) < 2) return false;
        $first = ord($s[0]);
        // Legacy plain JSON
        if ($first === 0x7B || $first === 0x5B) return false;
        // Whitespace before JSON — also treat as plain text
        if ($first === 0x20 || $first === 0x09 || $first === 0x0A || $first === 0x0D) return false;
        // Compressed marker
        return ($first >= 1 && $first <= 15);
    }

    /**
     * Load a dictionary by version, cached for the request lifetime.
     *
     * @param int $version
     * @return string binary
     */
    private static function loadDict($version)
    {
        if (isset(self::$dictCache[$version])) {
            return self::$dictCache[$version];
        }
        $path = rtrim(self::$dictDir, '/') . '/streams_instructions-v' . $version . '.zdict';
        if (!is_readable($path)) {
            throw new Q_Exception("Dictionary not readable: $path");
        }
        $data = file_get_contents($path);
        if ($data === false || $data === '') {
            throw new Q_Exception("Failed to load dictionary: $path");
        }
        self::$dictCache[$version] = $data;
        return $data;
    }
}
