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
CANDIDATE_BUNDLE_ID = "fr.bunnytalks.mobile.c2https"
CANDIDATE_ENTRY = "qualification/ios-standard-https-entry.tsx"
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
NORMAL_CURL_OPTIONS = {
    "CURLOPT_PROTOCOLS_STR": '"https"',
    "CURLOPT_HTTP_VERSION": "(long)CURL_HTTP_VERSION_1_1",
    "CURLOPT_FOLLOWLOCATION": "0L",
    "CURLOPT_PROXY": '""',
    "CURLOPT_NETRC": "(long)CURL_NETRC_IGNORED",
    "CURLOPT_HTTPAUTH": "(long)CURLAUTH_NONE",
    "CURLOPT_SSL_VERIFYPEER": "1L",
    "CURLOPT_SSL_VERIFYHOST": "2L",
    "CURLOPT_SSL_OPTIONS": "(long)CURLSSLOPT_NATIVE_CA",
    "CURLOPT_SSLVERSION": "(long)(CURL_SSLVERSION_TLSv1_2|CURL_SSLVERSION_MAX_TLSv1_3)",
    "CURLOPT_SSL_SESSIONID_CACHE": "0L",
}


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


def check_curl_options(source):
    # This checks the reviewed SET calls in the source. Effective build settings and TLS need separate evidence.
    source = re.sub(r"/\*.*?\*/|//[^\n]*", "", source, flags=re.S)
    for option, expected in NORMAL_CURL_OPTIONS.items():
        calls = re.findall(rf"\bSET\s*\(\s*{option}\s*,\s*([^;]+)\);", source)
        check(len(calls) == 1 and re.sub(r"\s+", "", calls[0]) == expected
              and len(re.findall(rf"\b{option}\b", source)) == 1, "native-curl-options")
    check(not re.search(r"\b(?:CURLOPT_(?:PROXY_)?(?:CAINFO|CAPATH)(?:_BLOB)?|"
                        r"CURLOPT_SSL_CTX_(?:FUNCTION|DATA)|"
                        r"SecTrustSetAnchorCertificates|SSL_CTX_(?:load_verify_locations|set_default_verify_paths))\b",
                        source),
          "native-alternative-trust")


def check_https_sources(mobile):
    native = mobile / "modules/application-https/ios"
    check(native.resolve().is_relative_to(mobile.resolve()), "external-resource-link")
    for path in (mobile / "src", mobile / "assets", native, native / "Native"):
        check(not path.is_symlink(), "external-resource-link")
    check((mobile / "src").is_dir() and (native / "Native").is_dir(), "https-source-tree")
    check_resources(mobile / "src")
    if (mobile / "assets").is_dir():
        check_resources(mobile / "assets")
    for name in ("index.ts", "app.json", "package.json", "metro.config.js"):
        path = mobile / name
        check(path.is_file() and not path.is_symlink(), "https-source-tree")
        check_resource(path)
    # The pod contains the historical branches. Its approved vendor ZIP is checked by its own verifier.
    for path in native.iterdir():
        if path.name != "vendor":
            check(not path.is_symlink(), "external-resource-link")
            check_resource(path, allow_qualification_markers=True)
            if path.is_dir():
                check_resources(path, allow_qualification_markers=True)
    check_curl_options((native / "Native/BunnyHttpsNative.c").read_text())


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
    flags = " ".join(str(https.get(name, "")) for name in (
        "GCC_PREPROCESSOR_DEFINITIONS", "SWIFT_ACTIVE_COMPILATION_CONDITIONS",
        "OTHER_CFLAGS", "OTHER_CPLUSPLUSFLAGS", "OTHER_SWIFT_FLAGS",
    ))
    check("BUNNY_HTTPS_QUALIFICATION" not in flags, "qualification-flags")
    check("CURL_STATICLIB=1" in flags, "static-curl-flags")
    sqlite_flags = targets["ExpoSQLite"].get("OTHER_CFLAGS", "").split()
    check({"-DSQLITE_HAS_CODEC=1", "-DSQLCIPHER_CRYPTO_CC"} <= set(sqlite_flags), "sqlcipher-flags")


def check_bundle_sources(path, *, candidate=False):
    sources = [name.replace("\\", "/") for name in json.loads(path.read_bytes())["sources"]]
    if candidate:
        fixture_sources = {name.rsplit("/qualification/", 1)[1] for name in ("/" + n for n in sources)
                           if "/qualification/" in name}
        check(fixture_sources == {CANDIDATE_ENTRY.rsplit("/", 1)[1], "ios-libcurl-scenarios.ts"},
              "candidate-js-entry")
        check(not any(name.endswith("/src/composition/App.tsx") or name == "src/composition/App.tsx"
                      for name in sources), "candidate-standard-entry")
        return
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


def inspect_release(derived, source_map, pod_settings, provenance, *, mobile=MOBILE, bundle_id=BUNDLE_ID,
                    c2=False):
    check_pod_settings(json.loads(pod_settings.read_bytes()))
    check_bundle_sources(source_map, candidate=bundle_id == CANDIDATE_BUNDLE_ID)
    link = link_helpers()
    apps = list((derived / "Build/Products/Release-iphonesimulator").glob("*.app"))
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
    check(link.command("xcrun", "lipo", "-archs", binary).split() == ["arm64"], "release-architecture")
    build = link.command("xcrun", "vtool", "-show-build", binary)
    check(re.search(r"^\s*platform\s+IOSSIMULATOR\s*$", build, re.M), "release-platform")
    check(re.search(r"^\s*minos\s+16\.4(?:\.0)?\s*$", build, re.M), "release-macho-minimum")
    bundle = app / "main.jsbundle"
    with bundle.open("rb") as handle:
        check(handle.read(8) == bytes.fromhex("c61fbc03c103191f"), "hermes-bytecode")

    vendor = mobile / "modules/application-https/ios/vendor/package"
    license_bundles = list(app.rglob("ApplicationHttpsLicenses.bundle"))
    check(len(license_bundles) == 1, "license-bundle")
    licenses = {}
    for name in ("curl-COPYING", "openssl-LICENSE.txt"):
        licenses[name] = link.digest(license_bundles[0] / name)
        check(licenses[name] == link.digest(vendor / name), "license-bytes")

    podfile_lock = mobile / "ios/Podfile.lock"
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
    result = {
        "verdict": "PASS", "bundleId": bundle_id, "displayName": "Bunny Talks",
        "configuration": "Release", "platform": "IOSSIMULATOR", "architecture": "arm64",
        "minimumOS": "16.4", "executableSha256": link.digest(binary),
        "hermesBundleSha256": link.digest(bundle), "podfileLockSha256": link.digest(podfile_lock),
        "ats": "default", "qualificationFlagsResourcesAndDiagnostics": "absent-in-checked-scope",
        "sqlcipherReleaseFlags": True, "secureStoreInPodfileLock": True, "licenseSha256": licenses,
        "linkedArchiveSha256": linked_archives, "linkMapSha256": link.digest(maps[0]),
        "linkMap": link_map, "definitions": definitions, "embeddedProviders": providers,
    }
    if c2:
        undefined = link.command("xcrun", "nm", "-u", binary)
        check(all(re.search(rf"\b{symbol}\b", undefined) for symbol in
                  ("_SecTrustEvaluateWithError", "_inflate", "_inflateInit2_"))
              and "Security.framework/Security" in dependencies
              and re.search(r"/libz(?:\.\d+)*\.dylib\b", dependencies), "c2-transport-imports")
        result["transportLinkSelection"] = transport_link_selection(raw_map, link.object_label)
    return result


def transport_link_selection(raw_map, object_label):
    selection = [(name.decode("ascii"), object_label(member)) for name, member in re.findall(
        rb"^\[[ \t]*\d+\][ \t]+[^\n]*?/"
        rb"(libcurl\.a|libopenssl\.a|libApplicationHttps\.a|ApplicationHttps)\(([^\n)]+)\)$", raw_map, re.M,
    )]
    selection.extend(("module", object_label(member)) for member in re.findall(
        rb"^\[[ \t]*\d+\][ \t]+[^\n]*?/ApplicationHttps\.build/[^\n]*/([^/\n]+\.o)$", raw_map, re.M,
    ))
    libraries = {name for name, _ in selection}
    if not ({"libcurl.a", "libopenssl.a"} <= libraries and
            libraries & {"module", "ApplicationHttps", "libApplicationHttps.a"}):
        raise EvidenceUnavailable("c2-link-selection-unavailable")
    return sorted(selection)


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="mode", required=True)
    commands.add_parser("generated")
    commands.add_parser("https-sources")
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
        elif args.mode == "https-sources":
            check_https_sources(MOBILE)
            result = {"verdict": "PASS", "scope": "https-standard-sources", "httpsRuntime": "NOT_RUN"}
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
