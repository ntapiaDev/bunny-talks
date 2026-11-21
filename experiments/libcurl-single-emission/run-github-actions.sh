#!/usr/bin/env bash
set -euo pipefail
umask 077

work="${BUNNY_LIBCURL_TMPDIR:?Missing experiment temporary directory}"
proof="${RUNNER_TEMP:?Missing runner temporary directory}/bunny-libcurl-proof"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ "$work" =~ ^/tmp/bunny-libcurl-ci\.[[:alnum:]]{8}$ && -d "$work" && -d "$proof" ]]
exec 2>"$work/technical.log"

current_stage=initialization
on_error() {
  local code="$1" subphase=none observation= fragment=
  if [[ "$current_stage" == build && -f "$work/build-phase" ]]; then
    subphase="$(cat "$work/build-phase")"
    case "$subphase" in
      macho-architecture|macho-build-version|macho-dynamic-libraries)
        # Only the inspector writes these files, using controlled labels and bounded fields.
        if [[ -f "$work/$subphase.json" ]] &&
          IFS= read -r -n 512 observation < "$work/$subphase.json" &&
          [[ ${#observation} -lt 512 && "$observation" == \{*\} ]]; then
          fragment=',"observation":'"$observation"
        fi
        ;;
      archive-check|sdk-check|archive-extraction|openssl-configure|openssl-compile|openssl-install|curl-configure|curl-compile|app-packaging|harness-compile|app-link|app-sign|build-evidence) ;;
      *) subphase=unknown ;;
    esac
  fi
  printf '{"verdict":"NOT_RUN","reason":"ci-%s-unavailable","diagnostic":{"stage":"%s","subphase":"%s","category":"command-failed","exitCode":%d%s}}\n' \
    "$current_stage" "$current_stage" "$subphase" "$code" "$fragment" > "$proof/.report.pending"
  mv "$proof/.report.pending" "$proof/report.json"
  printf -- '- Échec technique, étape %s, sous-phase %s, code %d.\n' "$current_stage" "$subphase" "$code" >> "$proof/summary.md"
}
trap 'on_error $?' ERR

stage() {
  current_stage="$1"
  printf '{"verdict":"NOT_RUN","reason":"ci-%s-unavailable"}\n' "$1" > "$proof/.report.pending"
  mv "$proof/.report.pending" "$proof/report.json"
  printf -- '- %s\n' "$2" >> "$proof/summary.md"
}

stage platform 'Vérification du runner macOS 26 arm64 et de Node 24.'
[[ "$RUNNER_OS" == macOS && "$RUNNER_ARCH" == ARM64 ]]
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]]
os_version="$(sw_vers -productVersion)"
[[ "$os_version" =~ ^26\.[0-9]+(\.[0-9]+)?$ ]]
node -e 'const [major, minor] = process.versions.node.split(".").map(Number);
  if (process.arch !== "arm64" || major !== 24 || minor < 7) process.exit(1);'
printf -- '  macOS %s, Node %s.\n' "$os_version" "$(node --version)" >> "$proof/summary.md"

stage xcode 'Vérification de Xcode 26.6 et du SDK iOS Simulator 26.5.'
[[ -d "$DEVELOPER_DIR" && "$(xcodebuild -version)" == $'Xcode 26.6\nBuild version 17F113' ]]
[[ "$(xcrun --sdk iphonesimulator --show-sdk-version)" == 26.5 ]]
[[ -d "$(xcrun --sdk iphonesimulator --show-sdk-path)" ]]
sdk_build="$(xcrun --sdk iphonesimulator --show-sdk-build-version)"
[[ "$sdk_build" =~ ^[0-9A-Za-z]+$ ]]

stage host-openssl 'Vérification du CLI OpenSSL 3.x pour la fixture.'
openssl_bin=/opt/homebrew/opt/openssl@3/bin
[[ -x "$openssl_bin/openssl" ]]
export PATH="$openssl_bin:$PATH"
openssl_version="$(openssl version)"
[[ "$openssl_version" =~ ^OpenSSL\ (3\.[0-9]+\.[0-9]+)\  ]]
host_version="${BASH_REMATCH[1]}"
req_help="$(openssl req -help 2>&1)"
[[ "$req_help" == *'-addext'* ]]
printf -- '  OpenSSL hôte %s.\n' "$host_version" >> "$proof/summary.md"

stage runtime 'Vérification du runtime 26.5 et du type iPhone 17.'
runtime=com.apple.CoreSimulator.SimRuntime.iOS-26-5
device_type=com.apple.CoreSimulator.SimDeviceType.iPhone-17
runtime_build="$(xcrun simctl list runtimes -j | node -e '
  const { runtimes } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const runtime = runtimes.find((item) => item.identifier === process.argv[1]);
  if (!runtime?.isAvailable || runtime.version !== "26.5" ||
      !/^[0-9A-Za-z]+$/.test(runtime.buildversion ?? "")) process.exit(1);
  console.log(runtime.buildversion);
' "$runtime")"
xcrun simctl list devicetypes -j | node -e '
  const { devicetypes } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  if (!devicetypes.some((item) => item.identifier === process.argv[1])) process.exit(1);
' "$device_type"
printf -- '  Xcode 17F113, SDK %s, runtime %s.\n' "$sdk_build" "$runtime_build" >> "$proof/summary.md"

stage downloads 'Téléchargement des archives officielles curl 8.23.0 et OpenSSL 3.5.9.'
curl_options=(--fail --silent --show-error --location --proto '=https' --proto-redir '=https'
  --max-time 120 --retry 2 --retry-max-time 150)
curl_archive="$work/curl-8.23.0.tar.xz"
openssl_archive="$work/openssl-3.5.9.tar.gz"
/usr/bin/curl -q "${curl_options[@]}" --output "$curl_archive" \
  https://curl.se/download/curl-8.23.0.tar.xz
/usr/bin/curl -q "${curl_options[@]}" --output "$openssl_archive" \
  https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz

stage build 'Vérification des SHA-256 avant extraction, compilation Release et inspection du Mach-O.'
build_dir="$(bash "$script_dir/build-apple.sh" "$curl_archive" "$openssl_archive")"
[[ "$build_dir" == "$work"/bunny-libcurl-apple.* && -s "$build_dir/build.json" ]]
cp "$build_dir/build.json" "$proof/build.json"

stage simulator 'Création et démarrage d’un iPhone 17 jetable.'
xcrun simctl create "Bunny libcurl ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" "$device_type" "$runtime" \
  > "$work/simulator-udid"
udid="$(cat "$work/simulator-udid")"
[[ "$udid" =~ ^[[:xdigit:]]{8}(-[[:xdigit:]]{4}){3}-[[:xdigit:]]{12}$ ]]
xcrun simctl boot "$udid" >> "$work/technical.log"
xcrun simctl bootstatus "$udid" -b >> "$work/technical.log"
printf -- '  Simulateur disponible, UDID `%s`.\n' "$udid" >> "$proof/summary.md"

stage campaign-report 'Exécution des contrôles TLS, puis du témoin et du candidat selon le verdict du runner.'
status=0
node "$script_dir/run-apple.mjs" "$build_dir" "$udid" > "$work/report.json" || status=$?
result="$(node - "$work/report.json" "$status" <<'NODE'
const { readFileSync } = require('node:fs');
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { verdict, reason } = report;
const codes = { PASS: 0, FAIL: 1, NOT_RUN: 2 };
if (!Object.hasOwn(codes, verdict) || codes[verdict] !== Number(process.argv[3]) ||
    typeof reason !== 'string' || !/^[a-z0-9-]+$/.test(reason)) process.exit(1);
let area = 'réémission HTTP';
if (report.tls?.verdict === 'FAIL' || reason.includes('tls-')) area = 'TLS';
else if (verdict === 'NOT_RUN') area = 'préparation ou preuve incomplète';
console.log(`${verdict} — ${area} (${reason})`);
NODE
)"
cp "$work/report.json" "$proof/.report.pending"
mv "$proof/.report.pending" "$proof/report.json"
printf -- '- Résultat **%s**.\n' "$result" >> "$proof/summary.md"
trap - ERR
exit "$status"
