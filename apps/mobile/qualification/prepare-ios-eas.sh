#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=$(cd "$(dirname "$0")/../../.." && pwd)
slug=bunny-talks-https
app_name='Bunny Talks HTTPS Qualification'
xcframework_zip=${BUNNY_IOS_XCFRAMEWORK_ZIP:-}
bundle_id=fr.bunnytalks.mobile.httpsqualification

if [[ "${1:-}" == --check ]]; then
  if [[ "$#" != 3 && "$#" != 4 ]]; then
    printf '%s\n' 'Usage: prepare-ios-eas.sh --check STAGE PROJECT_ID [INSPECTED_ARCHIVE]' >&2
    exit 1
  fi
  stage=$(cd "$2" && pwd -P)
  if [[ "${EAS_NO_VCS:-}" != 1 || "${EAS_PROJECT_ROOT:-}" != "$stage" ||
        "$(pwd -P)" != "$stage/apps/mobile" ]]; then
    printf '%s\n' 'Use EAS_NO_VCS=1, EAS_PROJECT_ROOT set to the prepared workspace, and run from its apps/mobile directory.' >&2
    exit 1
  fi
  reference=$(bash "$0")
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

cd "$repo"
stage=$(mktemp -d /tmp/bunny-ios-eas.XXXXXXXX)
stage=$(cd "$stage" && pwd -P)
mobile="$stage/apps/mobile"
mkdir -p "$mobile/.eas/build" "$mobile/qualification" "$stage/packages"

cp package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.{base,bundler,node}.json "$stage/"
grep -E '^(save-exact|engine-strict)=(true|false)$' .npmrc > "$stage/.npmrc"
cp apps/mobile/{app.json,eas.json,package.json,tsconfig.json,metro.config.js} "$mobile/"

# Preserve workspace layout without local caches, generated projects, or test data.
rsync -rm --exclude='node_modules/' --exclude='dist/' --exclude='build/' --exclude='tests/' --exclude='.*/' \
  --exclude='.env*' --include='*/' --include='package.json' --include='tsconfig.json' \
  --include='**/src/**/*.ts' --include='**/src/*.ts' --exclude='*' packages/ "$stage/packages/"
if [[ -n "$xcframework_zip" ]]; then
  module=apps/mobile/modules/application-https
  native="$stage/$module/ios"
  python3 "$module/ios/verify_xcframeworks.py" archive "$xcframework_zip" >/dev/null
  mkdir -p "$native/Native" "$native/vendor"
  cp "$module/expo-module.config.json" "$native/../"
  cp "$module/ios/"{ApplicationHttps.podspec,ApplicationHttpsModule.swift,CurlHttpsTransport.swift,verify_xcframeworks.py} "$native/"
  cp "$module/ios/Native/"{BunnyHttpsNative.c,BunnyHttpsNative.h,module.modulemap} "$native/Native/"
  cp "$xcframework_zip" "$native/vendor/xcframeworks.zip"
  python3 "$native/verify_xcframeworks.py" archive "$native/vendor/xcframeworks.zip" >/dev/null
  entry=qualification/ios-libcurl-build-entry.tsx
  cp apps/mobile/.eas/build/ios-https-libcurl-build.yml "$mobile/.eas/build/"
  cp "apps/mobile/$entry" apps/mobile/qualification/inspect-ios-libcurl-build.sh "$mobile/qualification/"
else
  entry=qualification/native-https-entry.tsx
  cp apps/mobile/.eas/build/{ios-https-qualification,ios-https-libcurl-build}.yml "$mobile/.eas/build/"
  cp apps/mobile/qualification/{certificates.sh,native-https-entry.tsx,run-ios-eas.sh,server.ts,verify-https-events.ts,ios-libcurl-build-entry.tsx,inspect-ios-libcurl-build.sh} \
    "$mobile/qualification/"
  rsync -rm --exclude='node_modules/' --exclude='.*/' --exclude='.env*' \
    --include='*/' --include='*.ts' --include='*.tsx' --exclude='*' \
    apps/mobile/src/ "$mobile/src/"
  rsync -rm --exclude='android/' --exclude='build/' --exclude='.*/' --exclude='vendor/' \
    --include='*/' --include='expo-module.config.json' --include='*.swift' \
    --include='*.podspec' --include='*.py' --include='*.c' --include='*.h' \
    --include='*.modulemap' --exclude='*' apps/mobile/modules/ "$mobile/modules/"
fi

node --input-type=module - "$mobile" "$slug" "$app_name" "$bundle_id" "$entry" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [mobile, slug, name, bundleId, entry] = process.argv.slice(2);
function edit(filename, update) {
  const path = join(mobile, filename);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  update(data);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}
edit('package.json', (data) => {
  data.main = entry;
});
if (entry === 'qualification/ios-libcurl-build-entry.tsx') {
  edit('eas.json', (data) => {
    const profile = 'ios-https-libcurl-build';
    if (!data.build?.[profile]) throw new Error('Missing iOS libcurl build profile.');
    data.build = { [profile]: data.build[profile] };
  });
}
edit('app.json', ({ expo }) => {
  expo.name = name;
  expo.slug = slug;
  expo.scheme = 'bunnytalks-httpsqualification';
  expo.ios.bundleIdentifier = bundleId;
  delete expo.owner;
  if (expo.extra?.eas) delete expo.extra.eas.projectId;
});
JS

printf '%s\n' "$stage"
