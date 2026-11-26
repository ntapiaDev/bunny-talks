"""Check the generated project and summarize scoped Release evidence."""

import argparse
import importlib.util
import json
import plistlib
import re
import subprocess
import sys
from pathlib import Path


MOBILE = Path(__file__).resolve().parents[1]
_runtime_spec = importlib.util.spec_from_file_location(
    "standard_runtime_inspection_support", MOBILE / "scripts/run-ios-standard-runtime.py",
)
_runtime = importlib.util.module_from_spec(_runtime_spec)
sys.modules[_runtime_spec.name] = _runtime
_runtime_spec.loader.exec_module(_runtime)
BUNDLE_ID = "fr.bunnytalks.mobile"
TARGET = "BunnyTalks"
CERTIFICATE_SUFFIXES = {".cer", ".crt", ".der", ".key", ".p7b", ".p12", ".pem", ".pfx", ".mobileprovision"}
QUALIFICATION_MARKERS = (
    b"qualificationProfile", b"qualificationCompletion", b"weird-reply-before-headers",
    b"fr.bunnytalks.mobile.httpsqualification", b"bunny-https-libcurl-runtime", b"Bunny fixture",
)
CERTIFICATE_PAYLOAD = re.compile(
    rb"-----BEGIN (?:(?:(?:TRUSTED|X509) )?CERTIFICATE|(?:[A-Z0-9]+ )*PRIVATE KEY)-----"
    rb"(?:\r?\n|(?:\\r)?\\n)[A-Za-z0-9+/]{32}"
)


class CheckFailed(ValueError):
    pass


class EvidenceUnavailable(ValueError):
    pass


def check(condition, reason):
    if not condition:
        raise CheckFailed(reason)


def read_plist(path):
    with path.open("rb") as handle:
        return plistlib.load(handle)


def check_ats(plist):
    check(plist.get("NSAppTransportSecurity") == {"NSAllowsArbitraryLoads": False}, "ats")


def check_resource(path, *, allow_qualification_markers=False):
    check(path.suffix.lower() not in CERTIFICATE_SUFFIXES, "certificate-resource")
    if path.is_file():
        data = path.read_bytes()
        if not allow_qualification_markers:
            check(not any(marker in data for marker in QUALIFICATION_MARKERS), "qualification-marker")
        check(not CERTIFICATE_PAYLOAD.search(data), "certificate-or-key-payload")


def check_resources(root, *, allow_qualification_markers=False):
    check(not root.is_symlink(), "external-resource-link")
    root = root.resolve()
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        check(not path.is_symlink() or path.resolve().is_relative_to(root), "external-resource-link")
        check(all("qualification" not in part.lower() for part in relative.parts), "qualification-resource")
        check_resource(path, allow_qualification_markers=allow_qualification_markers)


def check_urlsession_sources(mobile):
    native = mobile / "modules/application-https/ios"
    for root in (mobile / "src", mobile / "assets"):
        if root.exists():
            check_resources(root)
    for path in (
        mobile / "index.ts",
        mobile / "app.json",
        mobile / "package.json",
        mobile / "metro.config.js",
    ):
        check(path.is_file() and not path.is_symlink(), "https-source-tree")
        check_resource(path)
    check(not native.is_symlink() and native.resolve().is_relative_to(mobile.resolve()), "external-resource-link")
    for name in ("ApplicationHttps.podspec", "ApplicationHttpsModule.swift", "UrlSessionHttpsTransport.swift"):
        path = native / name
        check(path.is_file() and not path.is_symlink(), "https-source-tree")
        check_resource(path, allow_qualification_markers=True)
    pod = (native / "ApplicationHttps.podspec").read_text()
    check(
        re.findall(r"^\s*s\.source_files\s*=\s*(.*)$", pod, re.M)
        == ["'ApplicationHttpsModule.swift', 'UrlSessionHttpsTransport.swift'"]
        and not re.search(r"libcurl|openssl|vendor|CURL_STATICLIB", pod, re.I),
        "standard-transport-sources",
    )


def check_generated(ios, *, bundle_id=BUNDLE_ID, resources=True):
    properties = json.loads((ios / "Podfile.properties.json").read_bytes())
    check(properties.get("ios.deploymentTarget") == "16.4", "project-minimum-ios")
    check(properties.get("expo.jsEngine") == "hermes", "project-hermes")
    check(properties.get("expo.sqlite.useSQLCipher") == "true", "project-sqlcipher")
    project = (ios / f"{TARGET}.xcodeproj/project.pbxproj").read_text()
    identifiers = re.findall(r'^\s*PRODUCT_BUNDLE_IDENTIFIER = "?([\w.]+)"?;', project, re.M)
    check(set(identifiers) == {bundle_id}, "project-identity")
    check_ats(read_plist(ios / TARGET / "Info.plist"))
    if resources:
        check_resources(ios)


def check_pod_settings(settings):
    targets = {entry["target"]: entry["buildSettings"] for entry in settings}
    for name in ("ApplicationHttps", "ExpoSQLite"):
        check(targets[name].get("CONFIGURATION") == "Release", "pod-configuration")
    https = targets["ApplicationHttps"]
    flags = " ".join(
        str(https.get(name, ""))
        for name in (
            "GCC_PREPROCESSOR_DEFINITIONS",
            "SWIFT_ACTIVE_COMPILATION_CONDITIONS",
            "OTHER_CFLAGS",
            "OTHER_CPLUSPLUSFLAGS",
            "OTHER_SWIFT_FLAGS",
            "OTHER_LDFLAGS",
            "LIBRARY_SEARCH_PATHS",
            "FRAMEWORK_SEARCH_PATHS",
        )
    )
    check("BUNNY_HTTPS_QUALIFICATION" not in flags, "qualification-flags")
    check(
        not re.search(
            r"BUNNY_HTTPS_URLSESSION_QUALIFICATION|CURL_STATICLIB|libcurl|openssl|(?:^|\s)-l(?:curl|ssl|crypto)\b",
            flags,
            re.I,
        ),
        "standard-transport-flags",
    )
    sqlite_flags = targets["ExpoSQLite"].get("OTHER_CFLAGS", "").split()
    check({"-DSQLITE_HAS_CODEC=1", "-DSQLCIPHER_CRYPTO_CC"} <= set(sqlite_flags), "sqlcipher-flags")


def check_bundle_sources(path, *, laboratory_sources=None):
    sources = [name.replace("\\", "/") for name in json.loads(path.read_bytes())["sources"]]
    if laboratory_sources is not None:
        fixture_sources = {
            name.rsplit("/qualification/", 1)[1]
            for name in ("/" + item for item in sources)
            if "/qualification/" in name
        }
        check(
            fixture_sources == laboratory_sources
            and not any(name.endswith("src/composition/App.tsx") for name in sources),
            "laboratory-js-entry",
        )
        return
    check(any(name in ("index.ts", "./index.ts") or ("/" + name).endswith("/apps/mobile/index.ts")
              for name in sources)
          and any(name.endswith("src/composition/App.tsx") for name in sources), "standard-js-entry")
    check(not any("/qualification/" in "/" + name for name in sources), "qualification-js-entry")


def command(*args):
    try:
        result = _runtime.run_command(args, cwd=Path.cwd(), timeout=120, capture=True)
    except (OSError, subprocess.SubprocessError, _runtime.StageError):
        raise EvidenceUnavailable("inspection-command-unavailable") from None
    if result.exit_code != 0:
        raise EvidenceUnavailable("inspection-command-unavailable")
    return result.output


def digest(path):
    return _runtime.digest(Path(path))


def inspect_release(
    derived,
    source_map,
    pod_settings,
    *,
    mobile=MOBILE,
    bundle_id=BUNDLE_ID,
    laboratory_sources=None,
):
    check_pod_settings(json.loads(pod_settings.read_bytes()))
    check_bundle_sources(source_map, laboratory_sources=laboratory_sources)
    apps = list((derived / "Build/Products/Release-iphonesimulator").glob("*.app"))
    if not apps:
        raise EvidenceUnavailable("release-application-unavailable")
    check(len(apps) == 1, "release-application")
    app = apps[0]
    plist = read_plist(app / "Info.plist")
    check(plist.get("CFBundleIdentifier") == bundle_id and plist.get("CFBundleDisplayName") == "Bunny Talks",
          "release-identity")
    check(plist.get("MinimumOSVersion") in ("16.4", "16.4.0"), "release-plist-minimum")
    check_ats(plist)
    check_resources(app)

    executable = plist["CFBundleExecutable"]
    check(executable == TARGET, "release-executable")
    binary = app / executable
    check(command("xcrun", "lipo", "-archs", str(binary)).split() == ["arm64"], "release-architecture")
    build = command("xcrun", "vtool", "-show-build", str(binary))
    check(re.search(r"^\s*platform\s+IOSSIMULATOR\s*$", build, re.M), "release-platform")
    check(re.search(r"^\s*minos\s+16\.4(?:\.0)?\s*$", build, re.M), "release-macho-minimum")
    bundle = app / "main.jsbundle"
    with bundle.open("rb") as handle:
        check(handle.read(8) == bytes.fromhex("c61fbc03c103191f"), "hermes-bytecode")

    podfile_lock = mobile / "ios/Podfile.lock"
    pods = podfile_lock.read_text()
    for name in ("ApplicationHttps", "ExpoSQLite", "ExpoSecureStore", "hermes-engine"):
        check(re.search(rf"^  - {name}(?:\s|:)", pods, re.M), "native-dependencies")
    dependencies = command("xcrun", "otool", "-L", str(binary))
    check(not re.search(r"(?:libcurl|libssl|libcrypto|libopenssl)(?:\.|/)", dependencies, re.I),
          "dynamic-transport-provider")

    maps = list(derived.rglob(f"{TARGET}-LinkMap-arm64.txt"))
    if not maps:
        raise EvidenceUnavailable("release-link-map-unavailable")
    check(len(maps) == 1, "release-link-map-ambiguous")
    if maps[0].stat().st_size > 128 * 1024 * 1024:
        raise EvidenceUnavailable("release-link-map-too-large")
    raw_map = maps[0].read_bytes()
    check(
        not re.search(r"libcurl|openssl|ApplicationHttpsLicenses", pods, re.I)
        and not any(
            re.search(r"ApplicationHttpsLicenses|lib(?:curl|openssl|ssl|crypto)\.", path.name, re.I)
            for path in app.rglob("*")
        ),
        "legacy-transport-dependency",
    )
    check(
        re.search(rb"UrlSessionHttpsTransport(?:\.o|[A-Za-z0-9_]+)", raw_map)
        and not re.search(
            rb"CurlHttpsTransport|BunnyHttpsNative|libcurl\.|libopenssl\.|libssl\.|libcrypto\.",
            raw_map,
            re.I,
        ),
        "standard-transport-link-map",
    )
    symbols = command("xcrun", "nm", "-j", str(binary))
    check(not re.search(r"(?m)^_(?:curl_|SSL_|OPENSSL_|bunny_https_)", symbols)
              and "Foundation.framework/Foundation" in dependencies, "standard-transport-symbols")
    diagnostic_fields = rb"qualificationReason|qualificationStatus|qualificationBytes"
    instrumented_profile = rb"https-qualification/standard-json|BunnyHttpsStandardJson"
    check(not re.search(diagnostic_fields + b"|" + instrumented_profile, binary.read_bytes()),
              "qualification-marker")
    js_forbidden = (
        diagnostic_fields + b"|" + instrumented_profile
        if laboratory_sources is None
        else diagnostic_fields
    )
    check(not re.search(js_forbidden, bundle.read_bytes()), "qualification-marker")
    return {
        "verdict": "PASS", "bundleId": bundle_id, "displayName": "Bunny Talks",
        "configuration": "Release", "platform": "IOSSIMULATOR", "architecture": "arm64",
        "minimumOS": "16.4", "executableSha256": digest(binary),
        "hermesBundleSha256": digest(bundle), "podfileLockSha256": digest(podfile_lock),
        "linkMapSha256": digest(maps[0]),
        "ats": "default",
        "transport": "urlsession",
        "qualificationFlagsResourcesAndDiagnostics": "absent-in-checked-scope",
        "sqlcipherReleaseFlags": True, "secureStoreInPodfileLock": True,
    }


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="mode", required=True)
    commands.add_parser("generated")
    commands.add_parser("urlsession-sources")
    pods = commands.add_parser("pods")
    pods.add_argument("pod_settings", type=Path)
    release = commands.add_parser("release")
    for name in ("derived", "source_map", "pod_settings"):
        release.add_argument(name, type=Path)
    args = parser.parse_args()
    status = 0
    try:
        if args.mode == "generated":
            check_generated(MOBILE / "ios")
            result = {"verdict": "PASS", "scope": "generated-project"}
        elif args.mode == "urlsession-sources":
            check_urlsession_sources(MOBILE)
            result = {"verdict": "PASS", "scope": "https-standard-sources", "httpsRuntime": "NOT_RUN"}
        elif args.mode == "pods":
            check_pod_settings(json.loads(args.pod_settings.read_bytes()))
            result = {"verdict": "PASS", "scope": "release-pod-settings"}
        else:
            result = inspect_release(args.derived, args.source_map, args.pod_settings)
    except CheckFailed as error:
        result, status = {"verdict": "FAIL", "reason": str(error)}, 1
    except EvidenceUnavailable as error:
        result, status = {"verdict": "NOT_RUN", "reason": str(error)}, 1
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError, plistlib.InvalidFileException):
        result, status = {"verdict": "NOT_RUN", "reason": "missing-or-unreadable-evidence"}, 1
    print(json.dumps(result, sort_keys=True, indent=2))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
