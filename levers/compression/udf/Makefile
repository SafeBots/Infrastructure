# Makefile for streams_compress.so MariaDB UDF
#
# Usage:
#   make            # build streams_compress.so
#   make install    # copy to MariaDB plugin_dir (needs sudo)
#   make clean      # remove build artifacts
#
# Override at command line if your paths are non-standard:
#   make MARIADB_INCLUDE=/opt/maria/include/mariadb/server DICT_DIR=/data/dicts/

MARIADB_INCLUDE ?= $(shell mariadb_config --include 2>/dev/null | sed 's/^-I//')
DICT_DIR        ?= /safebox/dicts/

ifeq ($(MARIADB_INCLUDE),)
  $(error Could not detect MariaDB include path. Install mariadb-dev/devel, or set MARIADB_INCLUDE manually.)
endif

CC      ?= gcc
CFLAGS  ?= -O2 -Wall -Wextra -fPIC -std=c99 -D_GNU_SOURCE
CFLAGS  += -I"$(MARIADB_INCLUDE)" -I"$(MARIADB_INCLUDE)/server"
CFLAGS  += -DDICT_DIR='"$(DICT_DIR)"'
LDFLAGS ?= -shared -lzstd -lpthread

TARGET  := streams_compress.so
SRC     := streams_compress.c

all: $(TARGET)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) $(SRC) $(LDFLAGS) -o $@

install: $(TARGET)
	@plugin_dir=$$(mariadb -BNe 'SELECT @@plugin_dir' 2>/dev/null); \
	if [ -z "$$plugin_dir" ]; then echo "Could not find plugin_dir"; exit 1; fi; \
	install -m 755 $(TARGET) $$plugin_dir/; \
	echo "Installed $(TARGET) to $$plugin_dir/"; \
	echo "Now run: sudo mariadb < register.sql"

clean:
	rm -f $(TARGET)

.PHONY: all install clean
