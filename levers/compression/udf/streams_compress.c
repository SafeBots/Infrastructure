/*
 * streams_compress.c
 *
 * MariaDB UDF for compressing/decompressing streams_message.instructions
 * using a trained zstd dictionary.
 *
 * Compressed format: [1 byte dict version][zstd raw frame]
 *   - First byte 0x01..0x0F  →  compressed with dictionary version N
 *   - First byte 0x7B ('{') or 0x5B ('[')  →  legacy uncompressed JSON, returned as-is
 *   - Anything else  →  error (caller is expected to handle it)
 *
 * Functions:
 *   streams_zcompress(text, dict_version)
 *       Compress text with the dictionary at /safebox/dicts/streams_instructions-vN.zdict
 *       Returns the [1-byte-version][zstd-frame] blob.
 *
 *   streams_zuncompress(blob)
 *       Decompress the blob using the dictionary version encoded in the first byte.
 *       If the first byte looks like the start of JSON, returns blob as-is.
 *
 * Dictionaries live in DICT_DIR (default /safebox/dicts/). Override at build
 * time with -DDICT_DIR='"/your/path/"'.
 *
 * Thread safety: dictionaries are loaded once on first use and cached as
 * read-only ZSTD_CDict / ZSTD_DDict objects. ZSTD compress/decompress
 * contexts are created per-call (small overhead, fully thread-safe).
 *
 * Build:
 *   make
 *
 * Install:
 *   sudo install -m 755 streams_compress.so $(mariadb -e 'select @@plugin_dir' -BN)/
 *   sudo mariadb < register.sql
 */

#define MYSQL_DYNAMIC_PLUGIN 1

#include <mysql.h>
#include <zstd.h>
#include <zdict.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <unistd.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <pthread.h>

#ifndef DICT_DIR
#define DICT_DIR "/safebox/dicts/"
#endif

#define DICT_FILE_FMT  DICT_DIR "streams_instructions-v%d.zdict"
#define MAX_DICT_VER   15

/* ──────────────────────────────────────────────────────────────────
 * Dictionary cache (loaded lazily, read-only after init).
 * ──────────────────────────────────────────────────────────────── */
typedef struct {
    void          *data;
    size_t         size;
    ZSTD_CDict    *cdict;
    ZSTD_DDict    *ddict;
    int            loaded;     /* 1 if successfully loaded, -1 if load failed */
} dict_entry_t;

static dict_entry_t   dicts[MAX_DICT_VER + 1] = {{0}};
static pthread_mutex_t dict_load_lock = PTHREAD_MUTEX_INITIALIZER;

static dict_entry_t *load_dict(int version) {
    if (version <= 0 || version > MAX_DICT_VER) return NULL;
    dict_entry_t *d = &dicts[version];
    if (d->loaded == 1)  return d;
    if (d->loaded == -1) return NULL;

    pthread_mutex_lock(&dict_load_lock);
    /* Re-check inside the lock */
    if (d->loaded == 1)  { pthread_mutex_unlock(&dict_load_lock); return d; }
    if (d->loaded == -1) { pthread_mutex_unlock(&dict_load_lock); return NULL; }

    char path[512];
    snprintf(path, sizeof(path), DICT_FILE_FMT, version);
    int fd = open(path, O_RDONLY);
    if (fd < 0) goto fail;

    struct stat st;
    if (fstat(fd, &st) < 0)               { close(fd); goto fail; }
    if (st.st_size <= 0 || st.st_size > (1 << 24)) { close(fd); goto fail; }

    void *buf = malloc(st.st_size);
    if (!buf)                             { close(fd); goto fail; }

    ssize_t got = 0;
    while (got < st.st_size) {
        ssize_t r = read(fd, (char*)buf + got, st.st_size - got);
        if (r <= 0) break;
        got += r;
    }
    close(fd);
    if (got != st.st_size) { free(buf); goto fail; }

    ZSTD_CDict *cd = ZSTD_createCDict(buf, st.st_size, 6);
    ZSTD_DDict *dd = ZSTD_createDDict(buf, st.st_size);
    if (!cd || !dd) {
        if (cd) ZSTD_freeCDict(cd);
        if (dd) ZSTD_freeDDict(dd);
        free(buf);
        goto fail;
    }

    d->data   = buf;
    d->size   = st.st_size;
    d->cdict  = cd;
    d->ddict  = dd;
    d->loaded = 1;
    pthread_mutex_unlock(&dict_load_lock);
    return d;

fail:
    d->loaded = -1;
    pthread_mutex_unlock(&dict_load_lock);
    return NULL;
}

/* ──────────────────────────────────────────────────────────────────
 * Per-call result buffer attached to UDF_INIT->ptr.
 * MariaDB UDFs may return up to 255 bytes inline; for larger results
 * we own the buffer for the lifetime of the call.
 * ──────────────────────────────────────────────────────────────── */
typedef struct {
    char  *buf;
    size_t cap;
} call_buf_t;

static char *ensure_buf(UDF_INIT *initid, size_t need) {
    call_buf_t *cb = (call_buf_t*)initid->ptr;
    if (!cb) {
        cb = (call_buf_t*)calloc(1, sizeof(*cb));
        if (!cb) return NULL;
        initid->ptr = (char*)cb;
    }
    if (cb->cap < need) {
        char *nb = (char*)realloc(cb->buf, need);
        if (!nb) return NULL;
        cb->buf = nb;
        cb->cap = need;
    }
    return cb->buf;
}

/* ──────────────────────────────────────────────────────────────────
 * streams_zcompress(text, dict_version) → blob
 * ──────────────────────────────────────────────────────────────── */
my_bool streams_zcompress_init(UDF_INIT *initid, UDF_ARGS *args, char *message) {
    if (args->arg_count != 2 ||
        args->arg_type[0] != STRING_RESULT ||
        args->arg_type[1] != INT_RESULT) {
        strcpy(message, "streams_zcompress(text, dict_version_int) requires (STRING, INT)");
        return 1;
    }
    initid->maybe_null = 1;
    initid->max_length = 16 * 1024 * 1024;  /* hint, not enforced */
    initid->ptr = NULL;
    return 0;
}

void streams_zcompress_deinit(UDF_INIT *initid) {
    call_buf_t *cb = (call_buf_t*)initid->ptr;
    if (cb) { free(cb->buf); free(cb); }
}

char *streams_zcompress(UDF_INIT *initid, UDF_ARGS *args,
                        char *result, unsigned long *length,
                        char *is_null, char *error) {
    (void)result;  /* UDF inline buffer unused; we own our own */
    if (!args->args[0]) { *is_null = 1; return NULL; }
    long long ver_ll = *((long long*)args->args[1]);
    int ver = (int)ver_ll;
    if (ver <= 0 || ver > MAX_DICT_VER) { *error = 1; return NULL; }

    dict_entry_t *d = load_dict(ver);
    if (!d) { *error = 1; return NULL; }

    const char *in   = args->args[0];
    size_t      inN  = args->lengths[0];
    size_t      bound = ZSTD_compressBound(inN) + 1;

    char *buf = ensure_buf(initid, bound);
    if (!buf) { *error = 1; return NULL; }

    /* Prepend the version byte */
    buf[0] = (char)(ver & 0xFF);

    ZSTD_CCtx *cctx = ZSTD_createCCtx();
    if (!cctx) { *error = 1; return NULL; }
    size_t cs = ZSTD_compress_usingCDict(cctx, buf + 1, bound - 1, in, inN, d->cdict);
    ZSTD_freeCCtx(cctx);
    if (ZSTD_isError(cs)) { *error = 1; return NULL; }

    *length = (unsigned long)(cs + 1);
    return buf;
}

/* ──────────────────────────────────────────────────────────────────
 * streams_zuncompress(blob) → text
 * ──────────────────────────────────────────────────────────────── */
my_bool streams_zuncompress_init(UDF_INIT *initid, UDF_ARGS *args, char *message) {
    if (args->arg_count != 1 || args->arg_type[0] != STRING_RESULT) {
        strcpy(message, "streams_zuncompress(blob) requires (STRING)");
        return 1;
    }
    initid->maybe_null = 1;
    initid->max_length = 64 * 1024 * 1024;
    initid->ptr = NULL;
    return 0;
}

void streams_zuncompress_deinit(UDF_INIT *initid) {
    call_buf_t *cb = (call_buf_t*)initid->ptr;
    if (cb) { free(cb->buf); free(cb); }
}

char *streams_zuncompress(UDF_INIT *initid, UDF_ARGS *args,
                          char *result, unsigned long *length,
                          char *is_null, char *error) {
    if (!args->args[0]) { *is_null = 1; return NULL; }

    const char *in  = args->args[0];
    size_t      inN = args->lengths[0];
    if (inN == 0) { *length = 0; return result; }

    unsigned char first = (unsigned char)in[0];

    /* Legacy plain JSON: first byte is '{' or '[' — return as-is */
    if (first == '{' || first == '[') {
        char *buf = ensure_buf(initid, inN);
        if (!buf) { *error = 1; return NULL; }
        memcpy(buf, in, inN);
        *length = (unsigned long)inN;
        return buf;
    }

    int ver = (int)first;
    if (ver <= 0 || ver > MAX_DICT_VER) { *error = 1; return NULL; }

    dict_entry_t *d = load_dict(ver);
    if (!d) { *error = 1; return NULL; }

    /* Get the decompressed size from the frame header (frame must include it) */
    unsigned long long const declared =
        ZSTD_getFrameContentSize(in + 1, inN - 1);
    size_t bound;
    if (declared == ZSTD_CONTENTSIZE_ERROR)   { *error = 1; return NULL; }
    if (declared == ZSTD_CONTENTSIZE_UNKNOWN) { bound = inN * 32 + 256; }
    else                                       { bound = (size_t)declared + 16; }

    char *buf = ensure_buf(initid, bound);
    if (!buf) { *error = 1; return NULL; }

    ZSTD_DCtx *dctx = ZSTD_createDCtx();
    if (!dctx) { *error = 1; return NULL; }
    size_t ds = ZSTD_decompress_usingDDict(dctx, buf, bound, in + 1, inN - 1, d->ddict);
    ZSTD_freeDCtx(dctx);
    if (ZSTD_isError(ds)) { *error = 1; return NULL; }

    *length = (unsigned long)ds;
    return buf;
}
