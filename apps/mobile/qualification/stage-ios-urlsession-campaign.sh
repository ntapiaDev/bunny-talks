#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $# == 0 ]]

repo=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$repo"
stage=$(mktemp -d /tmp/bunny-ios-urlsession.XXXXXXXX)
stage=$(cd "$stage" && pwd -P)
trap 'rm -rf -- "$stage"' EXIT
mobile="$stage/apps/mobile"
module=apps/mobile/modules/application-https
native="$stage/$module/ios"
mkdir -p "$mobile/qualification" "$mobile/src/infrastructure/http" "$native" "$stage/packages"

cp package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.{base,bundler,node}.json "$stage/"
grep -E '^(save-exact|engine-strict)=(true|false)$' .npmrc > "$stage/.npmrc"
cp apps/mobile/{app.json,package.json,tsconfig.json,metro.config.js} "$mobile/"
rsync -rm --exclude='node_modules/' --exclude='dist/' --exclude='build/' --exclude='tests/' --exclude='.*/' \
  --exclude='.env*' --include='*/' --include='package.json' --include='tsconfig.json' \
  --include='**/src/**/*.ts' --include='**/src/*.ts' --exclude='*' packages/ "$stage/packages/"
cp "$module/expo-module.config.json" "$native/../"
cp "$module/ios/"{ApplicationHttpsModule.swift,ApplicationHttps.podspec,UrlSessionHttpsTransport.swift} "$native/"
cp apps/mobile/qualification/{standard-json-entry.tsx,standard-json-diagnostics.ts,standard-json-scenarios.ts,verify-standard-json.ts,server.ts,certificates.sh} \
  "$mobile/qualification/"
cp apps/mobile/src/infrastructure/http/{application-http,native-https-transport}.ts "$mobile/src/infrastructure/http/"

node --input-type=module - "$mobile" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [mobile] = process.argv.slice(2);
for (const filename of ['package.json', 'app.json']) {
  const path = join(mobile, filename);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (filename === 'package.json') data.main = 'qualification/standard-json-entry.tsx';
  else {
    data.expo.name = 'Bunny Talks HTTPS URLSession Qualification';
    data.expo.slug = 'bunny-talks-https';
    data.expo.scheme = 'bunnytalks-httpsurlsessionqualification';
    data.expo.ios.bundleIdentifier = 'fr.bunnytalks.mobile.httpsqualification.urlsession';
    data.expo.jsEngine = 'hermes';
    delete data.expo.owner;
    if (data.expo.extra?.eas) delete data.expo.extra.eas.projectId;
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}
JS

trap - EXIT
printf '%s\n' "$stage"
