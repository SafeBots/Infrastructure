-- Register UDFs from streams_compress.so
--
-- Run after `make install` has copied the .so to MariaDB's plugin_dir.
--
-- The UDFs are:
--   streams_zcompress(text, dict_version_int) → blob
--   streams_zuncompress(blob) → text

DROP FUNCTION IF EXISTS streams_zcompress;
DROP FUNCTION IF EXISTS streams_zuncompress;

CREATE FUNCTION streams_zcompress   RETURNS STRING SONAME 'streams_compress.so';
CREATE FUNCTION streams_zuncompress RETURNS STRING SONAME 'streams_compress.so';

-- Sanity:
--   SELECT LENGTH(streams_zcompress('{"hello":"world"}', 1));
--   SELECT streams_zuncompress(streams_zcompress('{"hello":"world"}', 1));
