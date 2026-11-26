#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=$(cd "$(dirname "$0")/../../.." && pwd)
slug=bunny-talks-https
app_name='Bunny Talks HTTPS Qualification'
xcframework_zip=${BUNNY_IOS_XCFRAMEWORK_ZIP:-}
bundle_id=fr.bunnytalks.mobile.httpsqualification
runtime=0
urlsession=0
profile=ios-https-libcurl-build
if [[ "${1:-}" == --urlsession ]]; then
  urlsession=1
  shift
  [[ $# == 0 ]]
  app_name='Bunny Talks HTTPS URLSession Qualification'
  bundle_id=fr.bunnytalks.mobile.httpsqualification.urlsession
elif [[ "${1:-}" == --runtime ]]; then
  runtime=1
  shift
  profile=ios-https-libcurl-runtime
  app_name='Bunny Talks HTTPS Libcurl Qualification'
  bundle_id=fr.bunnytalks.mobile.httpsqualification.libcurl
  if [[ ! "${BUNNY_IOS_RUNTIME_REVISION:-}" =~ ^[a-f0-9]{40}$ ]]; then
    printf '%s\n' 'Runtime staging requires the reviewed revision in BUNNY_IOS_RUNTIME_REVISION.' >&2
    exit 1
  fi
fi

if [[ "$urlsession" == 0 && -z "$xcframework_zip" ]]; then
  printf '%s\n' 'Set BUNNY_IOS_XCFRAMEWORK_ZIP to the approved XCFramework ZIP.' >&2
  exit 1
fi

if [[ "${1:-}" == --check ]]; then
  if [[ "$#" != 3 && "$#" != 4 ]]; then
    printf '%s\n' 'Usage: prepare-ios-eas.sh [--runtime] --check STAGE PROJECT_ID [INSPECTED_ARCHIVE]' >&2
    exit 1
  fi
  stage=$(cd "$2" && pwd -P)
  if [[ "${EAS_NO_VCS:-}" != 1 || "${EAS_PROJECT_ROOT:-}" != "$stage" ||
        "$(pwd -P)" != "$stage/apps/mobile" ]]; then
    printf '%s\n' 'Use EAS_NO_VCS=1, EAS_PROJECT_ROOT set to the prepared workspace, and run from its apps/mobile directory.' >&2
    exit 1
  fi
  if [[ "$runtime" == 1 ]]; then
    reference=$(bash "$0" --runtime)
  else
    reference=$(bash "$0")
  fi
  trap 'rm -rf -- "$reference"' EXIT
  node "$repo/apps/mobile/qualification/verify-ios-eas-tree.mjs" "$reference" "$2" "${4:-}"
  node --input-type=module - "$stage/apps/mobile/app.json" "$3" "$slug" "$app_name" "$bundle_id" <<'JS'
import { readFileSync } from 'node:fs';
const [config, projectId, slug, name, bundleId] = process.argv.slice(2);
const { expo } = JSON.parse(readFileSync(config, 'utf8'));
if (expo.slug !== slug || expo.name !== name || expo.ios?.bundleIdentifier !== bundleId) {
  console.error('The staged app identity does not match the iOS qualification app.');
  process.exit(1);
}
if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(projectId) ||
    expo.extra?.eas?.projectId !== projectId) {
  console.error('The staged app is not linked to the approved Expo project ID.');
  process.exit(1);
}
JS
  printf '%s\n' 'EAS qualification preflight passed.'
  exit 0
fi
[[ $# == 0 ]]

cd "$repo"
stage=$(mktemp -d /tmp/bunny-ios-eas.XXXXXXXX)
stage=$(cd "$stage" && pwd -P)
trap 'rm -rf -- "$stage"' EXIT
mobile="$stage/apps/mobile"
mkdir -p "$mobile/.eas/build" "$mobile/qualification" "$stage/packages"

cp package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.{base,bundler,node}.json "$stage/"
grep -E '^(save-exact|engine-strict)=(true|false)$' .npmrc > "$stage/.npmrc"
cp apps/mobile/{app.json,package.json,tsconfig.json,metro.config.js} "$mobile/"

# Preserve workspace layout without local caches, generated projects, or test data.
rsync -rm --exclude='node_modules/' --exclude='dist/' --exclude='build/' --exclude='tests/' --exclude='.*/' \
  --exclude='.env*' --include='*/' --include='package.json' --include='tsconfig.json' \
  --include='**/src/**/*.ts' --include='**/src/*.ts' --exclude='*' packages/ "$stage/packages/"
module=apps/mobile/modules/application-https
native="$stage/$module/ios"
if [[ "$urlsession" == 1 ]]; then
  entry=qualification/standard-json-entry.tsx
  mkdir -p "$native" "$mobile/src/infrastructure/http"
  cp "$module/expo-module.config.json" "$native/../"
  cp "$module/ios/ApplicationHttpsModule.swift" "$native/"
  cp apps/mobile/qualification/urlsession/{ApplicationHttps.podspec,UrlSessionHttpsTransport.swift} "$native/"
  cp apps/mobile/qualification/{standard-json-entry.tsx,standard-json-scenarios.ts,verify-standard-json.ts,server.ts,certificates.sh} \
    "$mobile/qualification/"
  cp apps/mobile/src/infrastructure/http/{application-http,native-https-transport}.ts "$mobile/src/infrastructure/http/"
else
  cp apps/mobile/eas.json "$mobile/"
  python3 "$module/ios/verify_xcframeworks.py" archive "$xcframework_zip" >/dev/null
  mkdir -p "$native/Native" "$native/vendor"
  cp "$module/expo-module.config.json" "$native/../"
  cp "$module/ios/"{ApplicationHttps.podspec,ApplicationHttpsModule.swift,CurlHttpsTransport.swift,verify_xcframeworks.py} "$native/"
  cp "$module/ios/Native/"{BunnyHttpsNative.c,BunnyHttpsNative.h,module.modulemap} "$native/Native/"
  cp "$xcframework_zip" "$native/vendor/xcframeworks.zip"
  python3 "$native/verify_xcframeworks.py" archive "$native/vendor/xcframeworks.zip" >/dev/null
  cp "apps/mobile/.eas/build/$profile.yml" "$mobile/.eas/build/"
  if [[ "$runtime" == 1 ]]; then
    entry=qualification/ios-libcurl-runtime-entry.tsx
    cp apps/mobile/qualification/{ios-libcurl-runtime-entry.tsx,ios-libcurl-scenarios.ts,ios-libcurl-diagnostics.ts,server.ts,standard-json-scenarios.ts,certificates.sh,run-ios-libcurl-runtime.mjs,verify-ios-libcurl-runtime.mjs,inspect-ios-libcurl-runtime.py,with-ios-libcurl-link-map.cjs} \
      "$mobile/qualification/"
    mkdir -p "$mobile/src/infrastructure/http" "$stage/experiments/libcurl-single-emission"
    cp apps/mobile/src/infrastructure/http/{application-http,native-https-transport}.ts "$mobile/src/infrastructure/http/"
    cp experiments/libcurl-single-emission/{run.mjs,run-apple.mjs,single-emission.c,SimulatorApp.m,Info.plist} \
      "$stage/experiments/libcurl-single-emission/"
    printf '{"reviewedRevision":"%s"}\n' "$BUNNY_IOS_RUNTIME_REVISION" > "$mobile/qualification/ios-libcurl-input.json"
  else
    entry=qualification/ios-libcurl-build-entry.tsx
    cp "apps/mobile/$entry" apps/mobile/qualification/inspect-ios-libcurl-build.sh "$mobile/qualification/"
  fi
fi

node --input-type=module - "$mobile" "$slug" "$app_name" "$bundle_id" "$entry" "$profile" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [mobile, slug, name, bundleId, entry, profile] = process.argv.slice(2);
function edit(filename, update) {
  const path = join(mobile, filename);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  update(data);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}
edit('package.json', (data) => {
  data.main = entry;
});
const runtime = entry === 'qualification/ios-libcurl-runtime-entry.tsx';
const urlsession = entry === 'qualification/standard-json-entry.tsx';
if (!urlsession) {
  edit('eas.json', (data) => {
    if (!data.build?.[profile]) throw new Error('Missing qualification profile.');
    data.build = { [profile]: data.build[profile] };
  });
}
edit('app.json', ({ expo }) => {
  expo.name = name;
  expo.slug = slug;
  expo.scheme = 'bunnytalks-httpsqualification';
  expo.ios.bundleIdentifier = bundleId;
  if (runtime) {
    expo.jsEngine = 'hermes';
    expo.scheme = 'bunnytalks-httpslibcurlqualification';
    expo.plugins.push('./qualification/with-ios-libcurl-link-map.cjs');
  }
  if (urlsession) {
    expo.jsEngine = 'hermes';
    expo.scheme = 'bunnytalks-httpsurlsessionqualification';
  }
  delete expo.owner;
  if (expo.extra?.eas) delete expo.extra.eas.projectId;
});
JS

trap - EXIT
printf '%s\n' "$stage"
