#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ "$(uname -s)" != Darwin || "${EAS_BUILD_PROFILE:-}" != ios-https-qualification ]]; then
  printf '%s\n' 'Run this script on the dedicated Expo iOS build worker.' >&2
  exit 1
fi

results=qualification/ios-results
mkdir "$results"
work=$(mktemp -d /tmp/bunny-ios-fixture.XXXXXXXX)
fixture_pid=
logs_pid=
cleanup() {
  for name in environment.txt app-results.txt server-events.json server-result.txt; do
    if [[ ! -s "$results/$name" ]]; then
      printf 'BUNNY_IOS_MISSING_EVIDENCE %s\n' "$name" >&2
    fi
  done
  if [[ -n "$logs_pid" ]]; then kill "$logs_pid" 2>/dev/null || true; fi
  if [[ -n "$fixture_pid" ]]; then
    kill "$fixture_pid" 2>/dev/null || true
    wait "$fixture_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

bundle_id=fr.bunnytalks.mobile.httpsqualification
simulator=$(xcrun simctl list devices booted --json | node -e '
  const devices = JSON.parse(require("node:fs").readFileSync(0, "utf8")).devices;
  const booted = Object.entries(devices).flatMap(([runtime, list]) =>
    list.filter((device) => device.state === "Booted").map((device) => ({ runtime, ...device })),
  );
  if (booted.length !== 1 || !booted[0].runtime.includes(".iOS-")) process.exit(1);
  console.log(booted[0].name + "\t" + booted[0].runtime + "\t" + booted[0].udid);
')
IFS=$'\t' read -r device runtime udid <<< "$simulator"

shopt -s nullglob
apps=(ios/build/Build/Products/Release-iphonesimulator/*.app)
if [[ "${#apps[@]}" != 1 ]]; then
  printf '%s\n' 'Expected exactly one Release simulator app in the build products.' >&2
  exit 1
fi
app="${apps[0]}"
[[ "$(plutil -extract CFBundleIdentifier raw -o - "$app/Info.plist")" == "$bundle_id" ]]
{
  printf 'Device: %s\nRuntime: %s\nConfiguration: Release (iOS Simulator)\n' "$device" "$runtime"
  version=$(plutil -extract CFBundleShortVersionString raw -o - "$app/Info.plist")
  printf 'App: %s\nVersion: %s\n' "$bundle_id" "$version"
  xcodebuild -version
} > "$results/environment.txt"

# Apple's LibreSSL may lack the verification flags used by the fixture.
if openssl version | grep -q '^LibreSSL'; then
  openssl_bin="$(brew --prefix openssl@3)/bin"
  [[ -x "$openssl_bin/openssl" ]]
  export PATH="$openssl_bin:$PATH"
fi
if ! bash qualification/certificates.sh "$work/certificates" > "$work/certificates.log" 2>&1; then
  printf '%s\n' 'Fixture certificate generation failed. Check OpenSSL on the worker.' >&2
  exit 1
fi
xcrun simctl keychain "$udid" add-root-cert "$work/certificates/ca.pem"

FIXTURE_HOST=127.0.0.1 FIXTURE_PORT=29443 FIXTURE_IDENTITY=1 node qualification/server.ts "$work/certificates" \
  > "$work/fixture.log" 2>&1 &
fixture_pid=$!
ready=
for ((attempt = 0; attempt < 20; attempt++)); do
  kill -0 "$fixture_pid"
  if curl --noproxy '*' --cacert "$work/certificates/ca.pem" --max-time 1 -fsS \
      https://localhost:29443/json -o /dev/null 2>/dev/null &&
      curl --noproxy '*' --max-time 1 -fsS http://127.0.0.1:29448/events -o /dev/null 2>/dev/null; then
    ready=yes
    break
  fi
  sleep 1
done
if [[ "$ready" != yes ]]; then
  printf '%s\n' 'Trusted loopback HTTPS fixture did not become ready.' >&2
  exit 1
fi
control=http://127.0.0.1:29448
curl --noproxy '*' --max-time 5 -fsS -X POST "$control/reset" -o /dev/null

xcrun simctl install "$udid" "$app"
printf '%s\n' BUNNY_IOS_APP_INSTALLED
xcrun simctl spawn "$udid" log stream --level info --style compact \
  --predicate 'subsystem == "com.facebook.react.log" AND category == "javascript" AND eventMessage CONTAINS "[BunnyHttpsQualification]"' \
  > "$work/app.log" 2>&1 &
logs_pid=$!
sleep 1
xcrun simctl launch "$udid" "$bundle_id"
printf '%s\n' BUNNY_IOS_APP_LAUNCHED

for ((attempt = 0; attempt < 360; attempt++)); do
  if grep -Eq '\[BunnyHttpsQualification\] (DONE |FAIL qualification unavailable)' "$work/app.log"; then
    sleep 1
    break
  fi
  sleep 1
done

sed -nE 's/^.*\[BunnyHttpsQualification\] ((READY|PLAN|START|PASS|FAIL|DONE) [A-Za-z0-9 ,-]+|PROFILE identity|TIMING [a-z0-9-]+ [0-9]{13} [0-9]{13}|INVOKE [a-z0-9-]+ [1-9][0-9]?|NATIVE [a-z0-9-]+ [1-9][0-9]? ([a-z][a-z0-9-]{0,27}:[0-9]{1,6},){0,23}[a-z][a-z0-9-]{0,27}:[0-9]{1,6})$/\1/p' "$work/app.log" \
  > "$results/app-results.txt"
cat "$results/app-results.txt"
server_status=0
if curl --noproxy '*' --max-time 5 -fsS "$control/events" -o "$work/server-events.json"; then
  mv "$work/server-events.json" "$results/server-events.json"
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON qualification/verify-https-events.ts ios "$results/app-results.txt" \
    < "$results/server-events.json" > "$results/server-result.txt" || server_status=$?
else
  printf '%s\n' 'FAIL input expected-server-events observed-unavailable' > "$results/server-result.txt"
  server_status=1
fi
cat "$results/server-result.txt"
if [[ "$server_status" == 0 ]]; then
  printf '%s\n' BUNNY_IOS_SERVER_CHECK_SUCCEEDED
else
  printf '%s\n' BUNNY_IOS_SERVER_CHECK_FAILED >&2
fi
if ! grep -q '^READY ApplicationHttps ' "$results/app-results.txt"; then
  if grep -qx 'FAIL qualification unavailable' "$results/app-results.txt"; then
    printf '%s\n' BUNNY_IOS_NATIVE_MODULE_UNAVAILABLE >&2
    exit 1
  fi
  printf '%s\n' BUNNY_IOS_APP_EVIDENCE_INCONCLUSIVE >&2
  exit 1
fi
if awk '
  /^PLAN [1-9][0-9]*$/ { plan = $2; plans++ }
  /^START [a-z0-9-]+$/ { starts++; if (started[$2]++) bad = 1 }
  /^PASS [a-z0-9-]+$/ { passes++; if (!started[$2] || passed[$2]++) bad = 1 }
  /^FAIL / { bad = 1 }
  /^DONE [0-9]+ passed, 0 failed$/ { done = $2; summaries++ }
  END { exit !(plans == 1 && summaries == 1 && starts == plan && passes == plan && done == plan && !bad) }
' "$results/app-results.txt"; then
  printf '%s\n' BUNNY_IOS_APP_CHECK_SUCCEEDED
elif grep -Eq '^DONE |^FAIL qualification unavailable$' "$results/app-results.txt"; then
  printf '%s\n' BUNNY_IOS_APP_CHECK_FAILED >&2
  exit 1
else
  printf '%s\n' BUNNY_IOS_APP_EVIDENCE_INCONCLUSIVE >&2
  exit 1
fi
[[ "$server_status" == 0 ]]
