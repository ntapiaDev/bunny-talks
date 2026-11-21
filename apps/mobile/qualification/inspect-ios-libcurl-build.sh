#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

apps=(ios/build/Build/Products/*simulator/*.app)
if (( ${#apps[@]} != 1 )); then
  printf '%s\n' 'Expected one simulator app for link inspection.' >&2
  exit 1
fi
app=${apps[0]}
identifier=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Info.plist")
[[ "$identifier" == fr.bunnytalks.mobile.httpsqualification ]]
name=$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$app/Info.plist")
[[ "$name" =~ ^[A-Za-z0-9_.-]+$ && "$name" != . && "$name" != .. ]]
python3 -I - "$app/$name" <<'PY' > qualification/ios-link-evidence/link.json
import hashlib
import json
import re
import subprocess
import sys

binary = sys.argv[1]
def inspect(*args):
    return subprocess.run(["xcrun", *args, binary], check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True).stdout

try:
    arch = inspect("lipo", "-archs").split()
    assert arch == ["arm64"]
    commands = inspect("vtool", "-show-build")
    assert re.search(r"^\s*platform\s+IOSSIMULATOR\s*$", commands, re.M)
    minimum = re.search(r"^\s*minos\s+(\d+(?:\.\d+){1,2})\s*$", commands, re.M)
    assert minimum
    libraries = []
    for line in inspect("otool", "-L").splitlines()[1:]:
        entry = re.fullmatch(r"\s*((?:/System/Library/Frameworks/|/usr/lib/|@rpath/)[A-Za-z0-9/_.+\-]+) \(compatibility version [^)]+\)", line)
        assert entry
        assert not re.search(r"(?:libcurl|libssl|libcrypto|libopenssl)(?:\.|/)", entry[1], re.I)
        libraries.append(entry[1])
    assert libraries
    symbols = {name: 0 for name in ["_curl_multi_perform", "_curl_version_info", "_OPENSSL_init_ssl"]}
    for line in inspect("nm", "-gU").splitlines():
        fields = line.split()
        if fields and fields[-1] in symbols:
            symbols[fields[-1]] += 1
    assert all(count <= 1 for count in symbols.values())
    with open(binary, "rb") as handle:
        fingerprint = hashlib.sha256(handle.read()).hexdigest()
    print(json.dumps({
        "executableSha256": fingerprint, "architecture": arch,
        "platform": "IOSSIMULATOR", "minimumOS": minimum[1], "dependencies": libraries,
        "visibleDefinitions": symbols,
        "symbolEvidence": "visible" if all(symbols.values()) else "incomplete",
    }, indent=2))
except (AssertionError, OSError, subprocess.SubprocessError):
    print('{"status":"inspection-failed"}')
    sys.exit(1)
PY
