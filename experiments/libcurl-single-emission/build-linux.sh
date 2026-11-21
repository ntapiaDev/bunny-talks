#!/usr/bin/env bash
set -euo pipefail
umask 077

archive="$(realpath "${1:?Provide the official curl-8.23.0.tar.xz archive}")"
openssl=--with-openssl
if [[ $# -eq 2 ]]; then
  openssl="--with-openssl=$(realpath "$2")"
fi
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build_dir="$(mktemp -d /tmp/bunny-libcurl-build.XXXXXXXX)"
archive_sha256=8dadd7d2536a314f982ad05a651b713f426bf7d02cc2c76cffb9796f2218e6c5

printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check --status
tar -xf "$archive" -C "$build_dir"
cd "$build_dir/curl-8.23.0"

# Keep configure and the final link on the same compiler and OpenSSL prefix.
export CC=cc CFLAGS='-O2' LC_ALL=C
unset CPPFLAGS LDFLAGS LIBS PKG_CONFIG_LIBDIR PKG_CONFIG_PATH
link_flags=()
if [[ $# -eq 2 ]]; then
  ssl_root="${openssl#*=}"
  link_flags=(-L"$ssl_root/lib")
  export LDFLAGS="-L$ssl_root/lib"
fi

printf 'Build logs: %s\n' "$build_dir" >&2
./configure --enable-option-checking=fatal --disable-shared --enable-static \
  "$openssl" --disable-openssl-auto-load-config \
  --without-ca-bundle --without-ca-path --without-ca-fallback \
  --without-nghttp2 --without-nghttp3 --without-ngtcp2 --without-quiche \
  --without-zlib --without-brotli --without-zstd --without-libpsl --without-libidn2 \
  --disable-alt-svc --disable-hsts --disable-websockets --disable-cookies \
  --disable-ftp --disable-file --disable-ldap --disable-ldaps --disable-rtsp \
  --disable-telnet --disable-tftp --disable-pop3 --disable-imap --disable-smtp \
  --disable-gopher --disable-mqtt --disable-ipfs --disable-docs --disable-manual \
  >"$build_dir/configure.log" 2>&1
make -C lib -j4 >"$build_dir/make.log" 2>&1
cc -std=c11 -O2 -Wall -Wextra -Werror -pedantic -DCURL_STATICLIB \
  -Iinclude "$source_dir/single-emission.c" lib/.libs/libcurl.a \
  "${link_flags[@]}" -lssl -lcrypto -pthread -o "$build_dir/single-emission"
printf '%s\n' "$build_dir/single-emission"
