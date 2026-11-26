#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'iOS standard preflight: %s\n' "$1" >&2
  exit 1
}

[[ $# == 0 ]] || fail 'this path uses the standard Foundation pod'
mobile=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$mobile"

[[ ! -e ios && ! -L ios ]] || fail 'use a dedicated workspace without a generated ios directory'
if [[ ${BUNNY_IOS_HTTPS_QUALIFICATION+x} || ${BUNNY_HTTPS_URLSESSION_QUALIFICATION+x} || ${XCODE_XCCONFIG_FILE+x} ||
      ${ENTRY_FILE+x} || ${EXTRA_PACKAGER_ARGS+x} || ${BUNDLE_COMMAND+x} || ${SKIP_BUNDLING+x} ]]; then
  fail 'remove the qualification and build overrides from the environment'
fi
if compgen -e EXPO_PUBLIC_ >/dev/null; then
  fail 'remove the EXPO_PUBLIC variables from the compilation environment'
fi
EXPO_OFFLINE=1 EXPO_NO_DOTENV=1 pnpm exec vitest run \
  tests/native-standard-config.test.ts tests/application-http-composition.test.ts \
  tests/architecture.test.js tests/local-api-health.test.ts
python3 -IB scripts/inspect-ios-standard.py urlsession-sources
