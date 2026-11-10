# Dictionary directory

This is where trained zstd dictionaries live at runtime. Both the MariaDB UDF
(`streams_compress.so`) and the Qbix PHP hook read from `/safebox/dicts/` by
default. The lever installer creates that directory and sets ownership to
`mysql:mysql` so the UDF can read.

Files are named `streams_instructions-vN.zdict` where N is the dictionary
version (1..15). The version is stored as the first byte of each compressed
blob so old rows decode against the dictionary that produced them.

See `../qbix/README.md` for the training flow.
