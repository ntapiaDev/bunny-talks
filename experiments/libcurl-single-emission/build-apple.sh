#!/usr/bin/env bash
set -euo pipefail
umask 077

phase() {
  if [[ -n "${BUNNY_LIBCURL_TMPDIR:-}" ]]; then
    printf '%s\n' "$1" > "$BUNNY_LIBCURL_TMPDIR/build-phase"
  fi
}

if [[ $# != 2 ]]; then
  echo 'Usage: bash build-apple.sh curl-8.23.0.tar.xz openssl-3.5.9.tar.gz' >&2
  exit 2
fi
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'Xcode on an Apple Silicon Mac is required (Apple proof NOT_RUN).' >&2
  exit 2
fi

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
phase archive-check
curl_archive="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
openssl_archive="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
curl_sha256=8dadd7d2536a314f982ad05a651b713f426bf7d02cc2c76cffb9796f2218e6c5
openssl_sha256=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a
printf '%s  %s\n' "$curl_sha256" "$curl_archive" | shasum -a 256 -c >&2
printf '%s  %s\n' "$openssl_sha256" "$openssl_archive" | shasum -a 256 -c >&2

xcode="$(xcodebuild -version)"
phase sdk-check
sdk=iphonesimulator
sdk_version="$(xcrun --sdk "$sdk" --show-sdk-version)"
sdk_build="$(xcrun --sdk "$sdk" --show-sdk-build-version)"
sdk_path="$(xcrun --sdk "$sdk" --show-sdk-path)"
clang="$(xcrun --sdk "$sdk" --find clang)"
if [[ "$xcode" != $'Xcode 26.6\nBuild version 17F113' || "$sdk_version" != 26.5 ||
      ! -d "$sdk_path" || -z "$sdk_build" || ! -x "$clang" ]]; then
  echo 'The target requires Xcode 26.6 (17F113) and iOS Simulator SDK 26.5.' >&2
  exit 2
fi

unset CC CXX CFLAGS CXXFLAGS CPPFLAGS LDFLAGS LIBS AR AS RANLIB CROSS_COMPILE \
  PKG_CONFIG_LIBDIR PKG_CONFIG_PATH MACOSX_DEPLOYMENT_TARGET IPHONEOS_DEPLOYMENT_TARGET
export SDKROOT="$sdk_path" LC_ALL=C PKG_CONFIG=false
target=arm64-apple-ios26.5-simulator
release_flags=("--target=$target" -O2 -DNDEBUG)
openssl_flags=(iossimulator-arm64-xcrun no-shared no-module no-dso no-tests no-apps)
curl_flags=(
  --enable-option-checking=fatal --disable-shared --enable-static
  --without-apple-sectrust --without-apple-idn --disable-openssl-auto-load-config
  --without-ca-bundle --without-ca-path --without-ca-fallback
  --without-nghttp2 --without-nghttp3 --without-ngtcp2 --without-quiche
  --without-zlib --without-brotli --without-zstd --without-libpsl --without-libidn2
  --disable-alt-svc --disable-hsts --disable-websockets --disable-cookies
  --disable-ftp --disable-file --disable-ldap --disable-ldaps --disable-rtsp
  --disable-telnet --disable-tftp --disable-pop3 --disable-imap --disable-smtp
  --disable-gopher --disable-mqtt --disable-ipfs --disable-docs --disable-manual
)

build_dir="$(mktemp -d "${BUNNY_LIBCURL_TMPDIR:-/tmp}/bunny-libcurl-apple.XXXXXXXX")"
printf 'Build logs: %s\n' "$build_dir" >&2
phase archive-extraction
tar -xzf "$openssl_archive" -C "$build_dir"
tar -xJf "$curl_archive" -C "$build_dir"
openssl_prefix="$build_dir/openssl"
(
  cd "$build_dir/openssl-3.5.9"
  phase openssl-configure
  perl ./Configure "${openssl_flags[@]}" "${release_flags[@]}" \
    --prefix="$openssl_prefix" --openssldir="$openssl_prefix" --libdir=lib
  phase openssl-compile
  make -j4
  phase openssl-install
  make install_sw
) >"$build_dir/openssl.log" 2>&1

curl_source="$build_dir/curl-8.23.0"
(
  cd "$curl_source"
  phase curl-configure
  CC="xcrun --sdk $sdk clang" CFLAGS="${release_flags[*]}" LDFLAGS="--target=$target" \
    ./configure --build="$(./config.guess)" --host=aarch64-apple-darwin \
    --with-openssl="$openssl_prefix" "${curl_flags[@]}"
  phase curl-compile
  make -C lib -j4 >"$build_dir/curl-make.log" 2>&1
) >"$build_dir/curl-configure.log" 2>&1

bundle="$build_dir/SingleEmission.app"
phase app-packaging
executable="$bundle/SingleEmission"
bundle_id="fr.bunnytalks.experiment.curl.run-$(uuidgen | tr '[:upper:]' '[:lower:]')"
mkdir "$bundle"
cp "$source_dir/Info.plist" "$bundle/Info.plist"
plutil -replace CFBundleIdentifier -string "$bundle_id" "$bundle/Info.plist"
plutil -lint "$bundle/Info.plist" >&2
phase harness-compile
xcrun --sdk "$sdk" clang "${release_flags[@]}" -std=c11 -Wall -Wextra -Werror \
  -pedantic -DCURL_STATICLIB -Dmain=bunny_single_emission_main \
  -I"$curl_source/include" -c "$source_dir/single-emission.c" -o "$build_dir/experiment.o"
phase app-link
xcrun --sdk "$sdk" clang "${release_flags[@]}" -Wall -Wextra -Werror -fobjc-arc \
  "$source_dir/SimulatorApp.m" "$build_dir/experiment.o" "$curl_source/lib/.libs/libcurl.a" \
  "$openssl_prefix/lib/libssl.a" "$openssl_prefix/lib/libcrypto.a" \
  -framework UIKit -framework Foundation -o "$executable"
phase app-sign
codesign --sign - "$bundle" >&2
codesign --verify --strict "$bundle"

inspect_macho() {
  local inspection="$1"
  shift
  phase "$inspection"
  xcrun "$@" "$executable" >"$build_dir/$inspection.txt"
  node "$source_dir/inspect-macho.mjs" "$inspection" "$build_dir/$inspection.txt" \
    "${BUNNY_LIBCURL_TMPDIR:-$build_dir}/$inspection.json"
}

inspect_macho macho-architecture lipo -archs
inspect_macho macho-build-version vtool -show-build
inspect_macho macho-dynamic-libraries otool -L >"$build_dir/macho-libraries.txt"

printf '%s\n' "${release_flags[@]}" >"$build_dir/release-flags.txt"
phase build-evidence
printf '%s\n' "${openssl_flags[@]}" >"$build_dir/openssl-flags.txt"
printf '%s\n' "${curl_flags[@]}" >"$build_dir/curl-flags.txt"
executable_sha256="$(shasum -a 256 "$executable" | awk '{print $1}')"
node - "$build_dir" "$bundle_id" "$sdk_version" "$sdk_build" "$executable_sha256" \
  "$curl_sha256" "$openssl_sha256" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const [, , directory, bundleId, sdkVersion, sdkBuild, executableSha256, curlSha256, opensslSha256] =
  process.argv;
const lines = (file) => readFileSync(join(directory, file), 'utf8').trim().split('\n');
const report = {
  bundleId, executableSha256, curlSha256, opensslSha256,
  xcode: '26.6 (17F113)', sdk: 'iphonesimulator', sdkVersion, sdkBuild,
  architecture: 'arm64', minimumOS: '26.5', configuration: 'Release',
  expectedTLS: 'OpenSSL/3.5.9',
  releaseFlags: lines('release-flags.txt'),
  opensslFlags: lines('openssl-flags.txt'),
  curlFlags: lines('curl-flags.txt'),
  dynamicLibraries: lines('macho-libraries.txt'),
};
writeFileSync(join(directory, 'build.json'), JSON.stringify(report, null, 2) + '\n');
NODE
printf '%s\n' "$build_dir"
