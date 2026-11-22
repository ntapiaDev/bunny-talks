"""Check the generated project and summarize scoped Release evidence."""

import argparse
import importlib.util
import json
import plistlib
import re
import subprocess
from pathlib import Path


MOBILE = Path(__file__).resolve().parents[1]
BUNDLE_ID = "fr.bunnytalks.mobile"
TARGET = "BunnyTalks"
CERTIFICATE_SUFFIXES = {".cer", ".crt", ".der", ".key", ".p12", ".pem", ".pfx", ".mobileprovision"}
QUALIFICATION_MARKERS = (
    b"qualificationProfile", b"qualificationCompletion", b"weird-reply-before-headers",
    b"fr.bunnytalks.mobile.httpsqualification", b"bunny-https-libcurl-runtime", b"Bunny fixture",
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


def check_resources(root):
    root = root.resolve()
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        check(not path.is_symlink() or path.resolve().is_relative_to(root), "external-resource-link")
        check(path.suffix.lower() not in CERTIFICATE_SUFFIXES, "certificate-resource")
        check(all("qualification" not in part.lower() for part in relative.parts), "qualification-resource")
        if path.is_file():
            data = path.read_bytes()
            check(not any(marker in data for marker in QUALIFICATION_MARKERS), "qualification-marker")
            check(not re.search(rb"-----BEGIN (?:CERTIFICATE|(?:[A-Z]+ )?PRIVATE KEY)-----\r?\n"
                                rb"[A-Za-z0-9+/]{32}", data), "certificate-or-key-payload")


def check_generated(ios):
    properties = json.loads((ios / "Podfile.properties.json").read_bytes())
    check(properties.get("ios.deploymentTarget") == "16.4", "project-minimum-ios")
    check(properties.get("expo.jsEngine") == "hermes", "project-hermes")
    check(properties.get("expo.sqlite.useSQLCipher") == "true", "project-sqlcipher")
    project = (ios / f"{TARGET}.xcodeproj/project.pbxproj").read_text()
    identifiers = re.findall(r'^\s*PRODUCT_BUNDLE_IDENTIFIER = "?([\w.]+)"?;', project, re.M)
    check(set(identifiers) == {BUNDLE_ID}, "project-identity")
    check_ats(read_plist(ios / TARGET / "Info.plist"))
    check_resources(ios)


def check_pod_settings(settings):
    targets = {entry["target"]: entry["buildSettings"] for entry in settings}
    for name in ("ApplicationHttps", "ExpoSQLite"):
        check(targets[name].get("CONFIGURATION") == "Release", "pod-configuration")
    https = targets["ApplicationHttps"]
    flags = " ".join(str(https.get(name, "")) for name in (
        "GCC_PREPROCESSOR_DEFINITIONS", "SWIFT_ACTIVE_COMPILATION_CONDITIONS",
        "OTHER_CFLAGS", "OTHER_CPLUSPLUSFLAGS", "OTHER_SWIFT_FLAGS",
    ))
    check("BUNNY_HTTPS_QUALIFICATION" not in flags, "qualification-flags")
    check("CURL_STATICLIB=1" in flags, "static-curl-flags")
    sqlite_flags = targets["ExpoSQLite"].get("OTHER_CFLAGS", "").split()
    check({"-DSQLITE_HAS_CODEC=1", "-DSQLCIPHER_CRYPTO_CC"} <= set(sqlite_flags), "sqlcipher-flags")


def check_bundle_sources(path):
    sources = [name.replace("\\", "/") for name in json.loads(path.read_bytes())["sources"]]
    check(any(name in ("index.ts", "./index.ts") or ("/" + name).endswith("/apps/mobile/index.ts")
              for name in sources)
          and any(name.endswith("src/composition/App.tsx") for name in sources), "standard-js-entry")
    check(not any("/qualification/" in "/" + name for name in sources), "qualification-js-entry")


def link_helpers():
    path = MOBILE / "qualification/inspect-ios-libcurl-runtime.py"
    spec = importlib.util.spec_from_file_location("link_inspection", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_linked_archives(raw_map, archives, digest):
    result = {}
    for library in ("libcurl", "libopenssl"):
        archive = f"{library}.a"
        paths = set(re.findall(rb"^\[ *\d+\][ \t]+([^\n]+/" + re.escape(archive.encode()) + rb")\(",
                               raw_map, re.M))
        check(len(paths) == 1, "linked-archive-path")
        actual = digest(Path(next(iter(paths)).decode()))
        check(actual == archives[f"{library}.xcframework/ios-arm64-simulator/{archive}"],
              "linked-archive-sha256")
        result[archive] = actual
    return result


def inspect_release(derived, source_map, pod_settings, provenance):
    check_pod_settings(json.loads(pod_settings.read_bytes()))
    check_bundle_sources(source_map)
    link = link_helpers()
    apps = list((derived / "Build/Products/Release-iphonesimulator").glob("*.app"))
    check(len(apps) == 1, "release-application")
    app = apps[0]
    plist = read_plist(app / "Info.plist")
    check(plist.get("CFBundleIdentifier") == BUNDLE_ID and plist.get("CFBundleDisplayName") == "Bunny Talks",
          "release-identity")
    check(plist.get("MinimumOSVersion") in ("16.4", "16.4.0"), "release-plist-minimum")
    check_ats(plist)
    check_resources(app)

    executable = plist["CFBundleExecutable"]
    check(executable == TARGET, "release-executable")
    binary = app / executable
    check(link.command("xcrun", "lipo", "-archs", binary).split() == ["arm64"], "release-architecture")
    build = link.command("xcrun", "vtool", "-show-build", binary)
    check(re.search(r"^\s*platform\s+IOSSIMULATOR\s*$", build, re.M), "release-platform")
    check(re.search(r"^\s*minos\s+16\.4(?:\.0)?\s*$", build, re.M), "release-macho-minimum")
    bundle = app / "main.jsbundle"
    with bundle.open("rb") as handle:
        check(handle.read(8) == bytes.fromhex("c61fbc03c103191f"), "hermes-bytecode")

    vendor = MOBILE / "modules/application-https/ios/vendor/package"
    license_bundles = list(app.rglob("ApplicationHttpsLicenses.bundle"))
    check(len(license_bundles) == 1, "license-bundle")
    licenses = {}
    for name in ("curl-COPYING", "openssl-LICENSE.txt"):
        licenses[name] = link.digest(license_bundles[0] / name)
        check(licenses[name] == link.digest(vendor / name), "license-bytes")

    podfile_lock = MOBILE / "ios/Podfile.lock"
    pods = podfile_lock.read_text()
    for name in ("ApplicationHttps", "ExpoSQLite", "ExpoSecureStore", "hermes-engine"):
        check(re.search(rf"^  - {name}(?:\s|:)", pods, re.M), "native-dependencies")
    dependencies = link.command("xcrun", "otool", "-L", binary)
    check(not re.search(r"(?:libcurl|libssl|libcrypto|libopenssl)(?:\.|/)", dependencies, re.I),
          "dynamic-transport-provider")

    maps = list(derived.rglob(f"{TARGET}-LinkMap-arm64.txt"))
    check(len(maps) == 1 and maps[0].stat().st_size <= 128 * 1024 * 1024, "release-link-map")
    raw_map = maps[0].read_bytes()
    link_map = link.inspect_map(raw_map, app.name, executable)
    definitions = link.inspect_definitions(link.command("xcrun", "nm", "-m", "-U", binary))
    if not all(definitions.values()):
        raise EvidenceUnavailable("executable-symbols-unavailable")
    check(link.link_matches(definitions, link_map), "symbol-provenance-mismatch")
    linked_archives = check_linked_archives(raw_map, provenance["archives"], link.digest)

    providers = link.inspect_frameworks(app)
    for dylib in (app / "Frameworks").rglob("*.dylib"):
        check(re.fullmatch(r"[A-Za-z0-9_.+-]+", dylib.name) and dylib.name not in providers,
              "dylib-inventory")
        providers[dylib.name] = {
            "executableSha256": link.digest(dylib),
            "definitions": link.inspect_definitions(link.command("xcrun", "nm", "-arch", "arm64", "-m", "-U", dylib)),
        }
    check(not any(rows for provider in providers.values() for rows in provider["definitions"].values()),
          "additional-visible-provider")
    return {
        "verdict": "PASS", "bundleId": BUNDLE_ID, "displayName": "Bunny Talks",
        "configuration": "Release", "platform": "IOSSIMULATOR", "architecture": "arm64",
        "minimumOS": "16.4", "executableSha256": link.digest(binary),
        "hermesBundleSha256": link.digest(bundle), "podfileLockSha256": link.digest(podfile_lock),
        "ats": "default", "qualificationFlagsResourcesAndDiagnostics": "absent-in-checked-scope",
        "sqlcipherReleaseFlags": True, "secureStoreInPodfileLock": True, "licenseSha256": licenses,
        "linkedArchiveSha256": linked_archives, "linkMapSha256": link.digest(maps[0]),
        "linkMap": link_map, "definitions": definitions, "embeddedProviders": providers,
    }


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="mode", required=True)
    commands.add_parser("generated")
    pods = commands.add_parser("pods")
    pods.add_argument("pod_settings", type=Path)
    release = commands.add_parser("release")
    for name in ("derived", "source_map", "pod_settings", "provenance"):
        release.add_argument(name, type=Path)
    args = parser.parse_args()
    status = 0
    try:
        if args.mode == "generated":
            check_generated(MOBILE / "ios")
            result = {"verdict": "PASS", "scope": "generated-project"}
        elif args.mode == "pods":
            check_pod_settings(json.loads(args.pod_settings.read_bytes()))
            result = {"verdict": "PASS", "scope": "release-pod-settings"}
        else:
            result = inspect_release(args.derived, args.source_map, args.pod_settings,
                                     json.loads(args.provenance.read_bytes()))
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
