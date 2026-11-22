#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'iOS standard preflight: %s\n' "$1" >&2
  exit 1
}

[[ $# == 1 && "$1" == /* ]] || fail 'provide the absolute path to the approved ZIP'
archive=$1
mobile=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$mobile"

[[ ! -e ios && ! -L ios ]] || fail 'use a dedicated workspace without a generated ios directory'
if [[ ${BUNNY_IOS_HTTPS_QUALIFICATION+x} || ${XCODE_XCCONFIG_FILE+x} ||
      ${ENTRY_FILE+x} || ${EXTRA_PACKAGER_ARGS+x} || ${BUNDLE_COMMAND+x} || ${SKIP_BUNDLING+x} ]]; then
  fail 'remove the qualification and build overrides from the environment'
fi
if compgen -e EXPO_PUBLIC_ >/dev/null; then
  fail 'remove the EXPO_PUBLIC variables from the compilation environment'
fi

python3 -I modules/application-https/ios/verify_xcframeworks.py archive "$archive" >/dev/null
EXPO_OFFLINE=1 EXPO_NO_DOTENV=1 pnpm exec vitest run \
  tests/native-standard-config.test.ts tests/application-http-composition.test.ts tests/architecture.test.js
