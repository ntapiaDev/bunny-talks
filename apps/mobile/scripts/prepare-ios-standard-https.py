"""Stage C2 and reuse the C1 simulator checks for its run-bound evidence."""

import argparse
import hashlib
import importlib.util
from itertools import zip_longest
import json
import os
import re
import shlex
import shutil
import signal
import struct
import subprocess
import sys
import tarfile
import uuid
import zipfile
from pathlib import Path


MOBILE = Path(__file__).resolve().parents[1]
MOBILE_RELATIVE = Path("apps/mobile")
NATIVE = Path("modules/application-https/ios")
CONFIG = MOBILE_RELATIVE / "app.json"
PACKAGE = MOBILE_RELATIVE / "package.json"
CHANGES = {CONFIG.as_posix(), PACKAGE.as_posix()}
OWNER = ".c2-owner.json"
OVERRIDES = {
    "BUNNY_HTTPS_QUALIFICATION", "BUNNY_IOS_HTTPS_QUALIFICATION", "XCODE_XCCONFIG_FILE",
    "ENTRY_FILE", "EXTRA_PACKAGER_ARGS", "BUNDLE_COMMAND", "SKIP_BUNDLING",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "OPENSSL_CONF", "OPENSSL_MODULES", "SSLKEYLOGFILE",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
}


def load_support(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


c1 = load_support("c1_runtime", MOBILE / "scripts/run-ios-standard-runtime.py")
inspection = load_support("standard_inspection", MOBILE / "scripts/inspect-ios-standard.py")
vendor = load_support("xcframeworks", MOBILE / NATIVE / "verify_xcframeworks.py")
require, StageError = c1.require, c1.StageError
APP_IDS = {"standard": inspection.BUNDLE_ID, "candidate": inspection.CANDIDATE_BUNDLE_ID}
CANDIDATE_SCOPE = "ios-https-candidate-only-c2-b"
STAGES = ("revision", "archive", "staging", "environment", "fixture", "confinement", "nativeEquivalence",
          "installation", "candidateRuntime", "stop", "cleanup")
BUILD_KEYS = ("executableSha256", "hermesBundleSha256", "podfileLockSha256", "linkMapSha256")
CANDIDATE_RELEASE_KEYS = ("configuration", "platform", "architecture", "minimumOS", "ats",
                          "qualificationFlagsResourcesAndDiagnostics", "linkedArchiveSha256")
SOURCES = ("ApplicationHttpsModule.swift", "CurlHttpsTransport.swift", "ApplicationHttps.podspec",
           "Native/BunnyHttpsNative.c", "Native/BunnyHttpsNative.h", "Native/module.modulemap")
OBJECTS = ("ApplicationHttpsModule.o", "CurlHttpsTransport.o", "BunnyHttpsNative.o")
PATH_OPTIONS = ("-I", "-F", "-L", "-o", "-isystem", "-iquote", "-iframework", "-isysroot", "-sdk",
                "-include", "-include-pch", "-resource-dir", "-module-cache-path", "-fmodules-cache-path",
                "-ivfsoverlay", "-vfsoverlay", "-fmodule-map-file", "-emit-module-path",
                "-emit-module-interface-path", "-emit-objc-header-path", "-serialize-diagnostics-path",
                "-emit-dependencies-path", "-index-store-path", "-index-unit-output-path",
                "-working-directory", "-primary-file")
JOINED_PATH_OPTIONS = ("-I", "-F", "-L", "-isystem", "-iquote", "-iframework")
EQUALS_PATH_OPTIONS = ("-fmodule-map-file", "-fmodules-cache-path", "-resource-dir")
OPTION_VALUES = ("-D", "-U", "-target", "-module-name", "-swift-version")
SECURITY_OPTIONS = ("-fstack-protector", "-fstack-protector-strong", "-fno-stack-protector", "-fstack-protector-all")
FILELIST = "\0filelist:"
OUTPUT_MAP = "\0output-file-map:"
MODULE_MAP_DIGEST = "\0module-map-sha256:"
TEMP_ROOT = Path("/tmp")
PATH_COMPONENTS = frozenset(("Build", "Intermediates.noindex", "Products", "Release-iphonesimulator",
                             "Pods", "Headers", "Private", "Public", "Target Support Files", "ApplicationHttps",
                             "ApplicationHttps.build", "Pods.build", "Objects-normal", "arm64", "Native",
                             "ModuleCache.noindex", "ExplicitPrecompiledModules", "SDKStatCaches.noindex"))
PATH_EXTENSIONS = frozenset((".c", ".h", ".swift", ".modulemap", ".yaml", ".json", ".pcm", ".o", ".sdk", ".rsp"))
DIAGNOSTIC_PATH_OPTIONS = ("-fdebug-compilation-dir", "-ffile-compilation-dir", "-working-directory")
PORTS = range(29443, 29450)
PHASES = ("before", "after")


def hex_value(value, length=64):
    return isinstance(value, str) and re.fullmatch(rf"[a-f0-9]{{{length}}}", value) is not None


def validate_revision(revision, approved):
    require(hex_value(revision, 40) and revision == approved, "reviewed-sha-mismatch")


def check_environment(env):
    require(not any(name in OVERRIDES or name.startswith(("EXPO_PUBLIC_", "DYLD_", "SIMCTL_CHILD_"))
                    for name in env), "environment-overrides")


def manifest(root):
    require(root.is_dir() and not root.is_symlink(), "invalid-source-tree")
    result = {}
    for directory, dirs, files in os.walk(root):
        for name in dirs + files:
            path = Path(directory) / name
            relative = path.relative_to(root)
            require(not path.is_symlink() and name not in {".git", "node_modules", "__pycache__"}
                    and (not name.startswith(".env") or name == ".env.example")
                    and relative not in {MOBILE_RELATIVE / "ios", MOBILE_RELATIVE / NATIVE / "vendor"},
                    "unexpected-source-entry")
            if name in files:
                require(path.is_file(), "unexpected-source-entry")
                result[relative.as_posix()] = [c1.digest(path), path.stat().st_mode & 0o777]
    return result


def tree_digest(entries):
    return hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def changed_files(reference, candidate):
    return {path for path in reference.keys() | candidate.keys() if reference.get(path) != candidate.get(path)}


def candidate_config(root):
    app = c1.read_json(root / CONFIG)
    package = c1.read_json(root / PACKAGE)
    require(app["expo"]["ios"]["bundleIdentifier"] == APP_IDS["standard"] and package["main"] == "index.ts"
            and not app["expo"].get("extra", {}).get("eas"), "standard-source-identity")
    inspection.check_ats(app["expo"]["ios"]["infoPlist"])
    app["expo"]["ios"]["bundleIdentifier"] = APP_IDS["candidate"]
    package["main"] = inspection.CANDIDATE_ENTRY
    return app, package


def verify_archive(path):
    try:
        source = vendor.read_zip(path)
        files = vendor.files_from_archive(source)
        accepted = vendor.verify(files)
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError, zipfile.BadZipFile, vendor.VerificationError):
        raise StageError("archive-rejected") from None
    return source, {
        "zipSha256": vendor.ZIP_SHA256,
        "manifestSha256": vendor.sha256(files["manifest.json"]),
        "archives": {name: digest for name, digest in accepted["sha256"].items() if name.endswith(".a")},
    }


def stage_pair(source, work, tree, archive, revision, *, candidate_only=False):
    require(hex_value(revision, 40), "reviewed-sha-mismatch")
    reference = manifest(source)
    require(hex_value(tree) and tree_digest(reference) == tree, "reviewed-tree-mismatch")
    require(work.is_absolute() and work == work.resolve() and
            not work.is_relative_to(source.resolve()), "workspace-overlaps-source")
    expected_app, expected_package = candidate_config(source)
    work.mkdir(mode=0o700)
    try:
        names = ("candidate",) if candidate_only else APP_IDS
        for name in names:
            shutil.copytree(source, work / name, copy_function=shutil.copy2)
        candidate = work / "candidate"
        for relative, value in ((CONFIG, expected_app), (PACKAGE, expected_package)):
            (candidate / relative).write_text(json.dumps(value, indent=2) + "\n")
        require((candidate_only or manifest(work / "standard") == reference)
                and changed_files(reference, manifest(candidate)) == CHANGES,
                "unexpected-staging-delta")
        require(c1.read_json(candidate / CONFIG) == expected_app and c1.read_json(candidate / PACKAGE) == expected_package,
                "candidate-source-identity")
        for name in names:
            mobile = work / name / MOBILE_RELATIVE
            inspection.check_https_sources(mobile)
            for file in (inspection.CANDIDATE_ENTRY, "qualification/ios-libcurl-scenarios.ts"):
                path = mobile / file
                require(path.is_file(), "candidate-entry-missing")
                inspection.check_resource(path)
            vendor.install_zip(mobile / NATIVE / "vendor", archive)
        run_id = uuid.uuid4().hex
        context = {"runId": run_id, "treeSha256": tree, "revision": revision, "zipSha256": vendor.ZIP_SHA256}
        (work / OWNER).write_text(json.dumps(context))
        return {**context, "changes": sorted(CHANGES), "bundleIds": {name: APP_IDS[name] for name in names}}
    except BaseException:
        shutil.rmtree(work)
        raise


def owned_workspace(work, context):
    owner = work / OWNER
    require(work.is_absolute() and work == work.resolve() and owner.is_file() and not owner.is_symlink()
            and hex_value(context.get("runId"), 32) and hex_value(context.get("treeSha256"))
            and hex_value(context.get("revision"), 40) and context.get("zipSha256") == vendor.ZIP_SHA256
            and c1.read_json(owner) == context, "workspace-ownership-unconfirmed")


def remove_workspace(work, context):
    owned_workspace(work, context)
    shutil.rmtree(work)
    return not work.exists()


def output_file_map(path, normalize):
    data = c1.read_json(path)
    require(isinstance(data, dict), "compile-evidence-incomplete", verdict="NOT_RUN")
    result = {}
    for key, outputs in data.items():
        normalized = normalize(key)
        require(normalized not in result and isinstance(outputs, dict)
                and all(isinstance(value, str) for value in outputs.values()),
                "compile-evidence-incomplete", verdict="NOT_RUN")
        result[normalized] = {kind: normalize(value) for kind, value in outputs.items()}
    return json.dumps(result, sort_keys=True)


def path_operand(value, previous):
    option, separator, operand = value.partition("=")
    if separator and option in EQUALS_PATH_OPTIONS:
        return option, option + "=", operand
    for option in JOINED_PATH_OPTIONS:
        if value.startswith((option + "/", option + "{")):
            return option, option, value[len(option):]
    return previous if previous in PATH_OPTIONS else None, "", value


def preceding_option(args, index):
    if not index:
        return None
    if index >= 3 and args[index - 1] == args[index - 3] == "-Xcc":
        return args[index - 2]
    return args[index - 1]


def compile_commands(commands, root, derived):
    roots = ((derived.resolve(), "{derived}"), (root.resolve(), "{source}"))
    temp_real = TEMP_ROOT.resolve()
    spellings = []
    for logical, (physical, label) in zip((derived, root), roots, strict=True):
        spellings.append((physical, physical, label))
        if logical.is_absolute() and logical != physical:
            spellings.append((logical, physical, label))
        if TEMP_ROOT != temp_real and physical.is_relative_to(temp_real):
            spellings.append((TEMP_ROOT / physical.relative_to(temp_real), physical, label))

    def normalize(value):
        path = Path(value)
        if not path.is_absolute() or ".." in path.parts:
            return value
        for spelling, physical, label in spellings:
            prefix = str(spelling)
            if value == prefix or value.startswith(prefix + "/"):
                if path.resolve().is_relative_to(physical):
                    return label + value[len(prefix):]
                return value
        return value

    def argument_file(value):
        path = Path(value)
        require(path.is_absolute() and any(path.resolve().is_relative_to(base) for base, _ in roots)
                and path.is_file() and path.stat().st_size <= 2 * 1024 * 1024,
                "compile-argument-file", verdict="NOT_RUN")
        return path

    def expand(args, depth=0):
        require(depth <= 3 and isinstance(args, list) and args
                and all(isinstance(a, str) and "\0" not in a for a in args),
                "compile-evidence-incomplete", verdict="NOT_RUN")
        output = []
        for value in args:
            if value.startswith("@"):
                output.extend(expand(shlex.split(argument_file(value[1:]).read_text()), depth + 1))
            else:
                output.append(value)
        return output

    def invocation(raw):
        args = expand(raw)
        output, listed = [], []
        for index, value in enumerate(args):
            previous = preceding_option(args, index)
            if value == "-Xcc":
                output.append(value)
            elif previous == "-filelist":
                files = [normalize(line) for line in argument_file(value).read_text().splitlines()]
                output.append(FILELIST + json.dumps(files))
                listed.extend(files)
            elif previous == "-output-file-map":
                output.append(OUTPUT_MAP + output_file_map(argument_file(value), normalize))
            elif previous in OPTION_VALUES:
                output.append(value)
            else:
                option, prefix, operand = path_operand(value, previous)
                normalized = normalize(operand)
                if option == "-fmodule-map-file" and normalized != operand:
                    file = argument_file(operand)
                    normalized += MODULE_MAP_DIGEST + c1.digest(file)
                output.append(prefix + normalized)
        return output, listed

    require(set(commands) == {"swift", "c"}, "compile-evidence-incomplete", verdict="NOT_RUN")
    result = {}
    for language, rows in commands.items():
        require(isinstance(rows, list) and rows, "compile-evidence-incomplete", verdict="NOT_RUN")
        scanned = [invocation(row) for row in rows]
        result[language] = sorted(argv for argv, _ in scanned)
        for argv in result[language]:
            require(not any("BUNNY_HTTPS_QUALIFICATION" in a or "BUNNY_IOS_HTTPS_QUALIFICATION" in a for a in argv),
                    "qualification-flags")
            require(any(re.fullmatch(r"arm64-apple-ios16\.4(?:\.0)?-simulator", a) for a in argv)
                    and any("iPhoneSimulator" in a for a in argv) and
                    any(re.fullmatch(r"-O(?:[1-3sz]|size)?", a) for a in argv),
                    "compile-evidence-incomplete", verdict="NOT_RUN")
        flattened = [a for argv, listed in scanned for a in (*argv, *listed)]
        needles = ("BunnyHttpsNative.c", "CURL_STATICLIB=1") if language == "c" else SOURCES[:2]
        require(all(any(a.endswith(needle) for a in flattened) for needle in needles),
                "compile-evidence-incomplete", verdict="NOT_RUN")
    return result


def object_fingerprints(path):
    """Retain section and relocation fingerprints without publishing object contents."""
    try:
        if path.stat().st_size > 64 * 1024**2:
            return {}
        data = path.read_bytes()
        magic, cpu, _, kind, count, length, _, _ = struct.unpack_from("<8I", data)
        if (magic, cpu, kind) != (0xFEEDFACF, 0x0100000C, 1) or 32 + length > len(data):
            return {}
        position, result = 32, {}
        for _ in range(count):
            command, size = struct.unpack_from("<2I", data, position)
            if size < 8 or position + size > 32 + length:
                return {}
            if command == 0x19 and size >= 72:  # LC_SEGMENT_64
                sections = struct.unpack_from("<I", data, position + 64)[0]
                if 72 + sections * 80 > size or len(result) + sections > 64:
                    return {}
                for index in range(sections):
                    start = position + 72 + index * 80
                    section, segment, _, length_bytes, offset, _, reloc, reloc_count, flags = struct.unpack_from(
                        "<16s16s2Q5I", data, start)
                    label = "/".join(value.rstrip(b"\0").decode("ascii") for value in (segment, section))
                    if not re.fullmatch(r"__[A-Za-z0-9_]+/__[A-Za-z0-9_]+", label) or label in result:
                        return {}
                    row = {"size": length_bytes, "relocations": reloc_count}
                    if (flags & 0xff) not in (1, 0x0c, 0x12):  # Zero-fill section types have no file data.
                        if offset + length_bytes > len(data):
                            return {}
                        row["bytesSha256"] = hashlib.sha256(data[offset:offset + length_bytes]).hexdigest()
                    if reloc_count:
                        if reloc + 8 * reloc_count > len(data):
                            return {}
                        row["relocationsSha256"] = hashlib.sha256(data[reloc:reloc + 8 * reloc_count]).hexdigest()
                    result[label] = row
            position += size
        return result if position == 32 + length else {}
    except (OSError, struct.error, UnicodeError):
        return {}


def evidence_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def path_summary(value, option):
    path, separator, content = value.partition(MODULE_MAP_DIGEST)
    root, spelling, suffix = "external" if path.startswith("/") else "relative", None, path
    for prefix, logical, form in (("{source}", "staging", None), ("{derived}", "derived-data", None),
                                  ("/private/tmp", "temporary", "private-tmp"), ("/tmp", "temporary", "tmp")):
        if path == prefix or path.startswith(prefix + "/"):
            root, spelling, suffix = logical, form, path[len(prefix):]
            break
    components = [part for part in Path(suffix).parts if part in PATH_COMPONENTS][:8]
    extension = Path(suffix).suffix
    category = "other"
    if option == "-fmodule-map-file" or extension == ".modulemap":
        category = "module-map"
    elif option in ("-module-cache-path", "-fmodules-cache-path") or "ModuleCache.noindex" in components:
        category = "module-cache"
    elif option in ("-isysroot", "-sdk"):
        category = "sdk"
    elif option in ("-I", "-F", "-L", "-isystem", "-iquote", "-iframework"):
        category = "search-path"
    elif root == "derived-data" or any(c in components for c in ("Intermediates.noindex", "Target Support Files")):
        category = "generated"
    elif extension in (".c", ".h", ".swift"):
        category = "source"
    summary = {"root": root, "underBuildRoot": root in ("staging", "derived-data"),
               "category": category, "components": components, "suffixSha256": evidence_digest(suffix)}
    if spelling:
        summary["spelling"] = spelling
    if extension in PATH_EXTENSIONS:
        summary["extension"] = extension
    if separator and hex_value(content):
        summary["contentSha256"] = content
    return summary


def argument_summary(row, index):
    if index >= len(row):
        return {"kind": "absent"}
    value = row[index]
    previous = preceding_option(row, index)
    if re.fullmatch(r"-O(?:[0-3sz]|size|none|unchecked)?|arm64-apple-ios16\.4(?:\.0)?-simulator", value):
        return {"kind": "optimization" if value.startswith("-O") else "target", "value": value}
    if value in SECURITY_OPTIONS:
        return {"kind": "security-option", "option": value}
    if value in (*PATH_OPTIONS, *OPTION_VALUES, "-filelist", "-output-file-map", "-Xcc"):
        return {"kind": "option", "option": value}
    summary = {"kind": "opaque", "sha256": evidence_digest(value)}
    if value.startswith(FILELIST):
        summary["kind"] = "filelist"
    elif value.startswith(OUTPUT_MAP):
        summary["kind"] = "output-file-map"
    elif previous == "-target":
        summary.update(kind="target", option=previous)
    elif value.startswith(("-D_FORTIFY_SOURCE", "-fstack-protector", "-fno-stack-protector",
                           "-fvisibility", "-fno-visibility")):
        summary["kind"] = "security-option"
    elif previous in ("-D", "-U") or value.startswith(("-D", "-U")):
        summary.update(kind="macro", option=previous if previous in ("-D", "-U") else value[:2])
    else:
        option, _, path = path_operand(value, previous)
        name, separator, operand = value.partition("=")
        if not option and separator and name in DIAGNOSTIC_PATH_OPTIONS:
            option, path = name, operand
        if option or path.startswith(("/", "{source}", "{derived}")):
            summary.update(kind="path", path=path_summary(path, option))
            if option:
                summary["option"] = option
        elif value.startswith("-"):
            summary["kind"] = "option"
    return summary


def command_difference(left, right):
    rows = []
    for index, (a, b) in enumerate(zip_longest(left, right, fillvalue=())):
        if a == b:
            continue
        arguments = []
        for position, (x, y) in enumerate(zip_longest(a, b)):
            if x != y:
                left_summary, right_summary = argument_summary(a, position), argument_summary(b, position)
                delta = {"index": position, "standard": left_summary, "candidate": right_summary}
                if "path" in left_summary and "path" in right_summary:
                    delta["pathDifferences"] = [key for key in ("root", "spelling", "suffixSha256", "contentSha256")
                                                if left_summary["path"].get(key) != right_summary["path"].get(key)]
                arguments.append(delta)
                if len(arguments) == 4:
                    break
        rows.append({"index": index, "arguments": arguments})
        if len(rows) == 2:
            break
    return rows


def compare_builds(standard, candidate):
    for name, evidence in zip(APP_IDS, (standard, candidate), strict=True):
        require(evidence["release"]["bundleId"] == APP_IDS[name], "release-identity")
        require(evidence["release"]["verdict"] == "PASS", "inspection-incomplete", verdict="NOT_RUN")
        require(all(hex_value(evidence["release"].get(key)) for key in BUILD_KEYS),
                "build-fingerprints-unavailable", verdict="NOT_RUN")
        require(set(evidence.get("nativeSources", {})) == set(SOURCES) and
                all(map(hex_value, evidence["nativeSources"].values())) and evidence.get("commands") and
                evidence.get("objects"), "native-evidence-incomplete", verdict="NOT_RUN")
        commands = evidence["commands"]
        require(isinstance(commands, dict) and set(commands) == {"c", "swift"} and all(
            isinstance(rows, list) and rows and all(isinstance(row, list) and row and all(
                isinstance(arg, str) for arg in row) for row in rows) for rows in commands.values()),
            "compile-evidence-incomplete", verdict="NOT_RUN")
    different_sources = [name for name in SOURCES if standard["nativeSources"][name] != candidate["nativeSources"][name]]
    categories = ["sources"] if different_sources else []
    categories.extend(language for language in ("c", "swift")
                      if standard["commands"][language] != candidate["commands"][language])
    if categories:
        error = StageError("native-" + {"sources": "source", "c": "c-command", "swift": "swift-command"}[categories[0]]
                           + "-mismatch")
        error.record["comparison"] = {
            "categories": categories, "differentSources": different_sources,
            "builds": {name: {"sourceSha256": evidence["nativeSources"],
                              "commands": {lang: {"sha256": evidence_digest(rows), "count": len(rows),
                                                  "argumentCount": sum(map(len, rows))}
                                           for lang, rows in evidence["commands"].items()}}
                       for name, evidence in zip(APP_IDS, (standard, candidate), strict=True)},
            "commandDifferences": {language: command_difference(standard["commands"][language],
                                                                 candidate["commands"][language])
                                   for language in categories if language != "sources"},
        }
        raise error
    link_fields = ("podfileLockSha256", "linkedArchiveSha256", "transportLinkSelection")
    for key in link_fields:
        left, right = standard["release"].get(key), candidate["release"].get(key)
        require(left and right, "native-link-evidence-incomplete", verdict="NOT_RUN")
    different_links = [key for key in link_fields if standard["release"][key] != candidate["release"][key]]
    if different_links:
        error = StageError("native-link-mismatch")
        error.record["comparison"] = {"differentFields": different_links,
                                      "builds": {name: {key: evidence_digest(evidence["release"][key])
                                                        for key in link_fields}
                                                 for name, evidence in zip(APP_IDS, (standard, candidate), strict=True)}}
        raise error
    require(all(set(row["objects"]) == set(OBJECTS) and all(map(hex_value, row["objects"].values()))
                for row in (standard, candidate)), "native-objects-unavailable", verdict="NOT_RUN")
    if standard["objects"] != candidate["objects"]:
        error = StageError("native-object-difference", verdict="NOT_RUN")
        different_objects = [name for name in OBJECTS if standard["objects"][name] != candidate["objects"][name]]
        error.record["differentObjects"] = different_objects
        error.record["comparison"] = {
            name: {"objects": evidence["objects"],
                   "commandsSha256": evidence_digest(evidence["commands"]),
                   **{key: evidence["release"][key] for key in BUILD_KEYS}}
            for name, evidence in zip(APP_IDS, (standard, candidate), strict=True)
        }
        for name, evidence in zip(APP_IDS, (standard, candidate), strict=True):
            error.record["comparison"][name]["differingObjectSections"] = {
                label: object_fingerprints(path) for label, path in evidence.get("objectPaths", {}).items()
                if label in different_objects
            }
        raise error
    return {name: {"bundleId": APP_IDS[name], **{k: evidence["release"][k] for k in BUILD_KEYS}}
            for name, evidence in zip(APP_IDS, (standard, candidate), strict=True)}


def inspect_build(workspace, derived, source_map, settings, compilation, provenance, *, name, collect_objects=True):
    mobile = workspace / MOBILE_RELATIVE
    inspection.check_generated(mobile / "ios", bundle_id=APP_IDS[name], resources=False)
    release = inspection.inspect_release(derived, source_map, settings, provenance, mobile=mobile,
                                         bundle_id=APP_IDS[name], c2=True)
    commands = compile_commands(c1.read_json(compilation), workspace, derived)
    evidence = {"release": release, "commands": commands,
                "nativeSources": {name: c1.digest(mobile / NATIVE / name) for name in SOURCES}}
    if not collect_objects:
        return evidence
    files = {}
    for object_name in OBJECTS:
        matches = [p for p in derived.rglob(object_name) if
                   any(part == "ApplicationHttps.build" for part in p.parts)]
        require(len(matches) == 1, "native-objects-unavailable", verdict="NOT_RUN")
        files[object_name] = matches[0]
    return {**evidence, "objectPaths": files, "objects": {name: c1.digest(path) for name, path in files.items()}}


def private_file(work, name):
    path = work / name
    require(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(work)
            and 0 < path.stat().st_size <= 4 * 1024 * 1024, "evidence-unavailable", verdict="NOT_RUN")
    return path


def bound_record(data, context, scope):
    require(isinstance(data, dict), "evidence-unavailable", verdict="NOT_RUN")
    require(data.get("context") is not None, "evidence-context-unavailable", verdict="NOT_RUN")
    require(data["context"] == context and data.get("scope") == scope, "evidence-run-mismatch")
    return data


def save_receipt(work, name, context, **evidence):
    record = {"scope": name, "context": context, **evidence}
    with (work / (name + ".json")).open("x", encoding="utf-8") as output:
        json.dump(record, output, sort_keys=True)
    return record


def load_receipt(work, name, context):
    return bound_record(c1.read_json(private_file(work, name + ".json")), context, name)


def verify_confinement(data, work, context, *, window):
    if not data:
        raise StageError("confinement-unconfirmed", verdict="NOT_RUN")
    witness = bound_record(data, context, "network-" + window)
    if witness.get("outsideReachable") is True or (
        type(witness.get("outsidePackets")) is int and witness["outsidePackets"] > 0
    ):
        raise StageError("confinement-violation")
    if witness.get("profile") == "hosted-observed":
        return {"profile": "hosted-observed", "fullConfinement": "NOT_RUN"}
    require(witness.get("profile") == "full" and witness.get("method") in ("physical", "external-boundary")
            and witness.get("reviewed") is True and type(witness.get("outsidePackets")) is int
            and witness["outsidePackets"] == 0 and witness.get("outsideReachable") is False,
            "confinement-unconfirmed", verdict="NOT_RUN")
    # These digests bind the manual review to private observations. Their contents require a human review.
    files = witness.get("observations", {})
    channels = ("boundary", "interfaces", "ipv4", "ipv6", "packetObservation")
    require(set(files) == set(channels), "confinement-observations-missing", verdict="NOT_RUN")
    digests = {}
    paths = set()
    for name in channels:
        raw = private_file(work, files[name]["path"])
        require(raw.resolve() not in paths, "confinement-observations-missing", verdict="NOT_RUN")
        paths.add(raw.resolve())
        digests[name] = c1.digest(raw)
        require(digests[name] == files[name].get("sha256"), "confinement-observation-mismatch")
    return {"profile": "full", "fullConfinement": "PASS", "basis": "manual-review", "observationSha256": digests}


def require_full(network):
    if network["fullConfinement"] != "PASS":
        error = StageError("full-confinement-not-demonstrated", verdict="NOT_RUN")
        error.record.update(network)
        raise error
    return network


def verify_fixture(fixture, environment):
    require(fixture.get("environmentDevice") == environment["device"], "fixture-device-mismatch")
    require(fixture.get("bindings") == [{"address": "127.0.0.1", "port": port} for port in PORTS]
            and fixture.get("initialCounters") == {"connections": 0, "requests": 0}, "fixture-nonconforming")
    require(hex_value(fixture.get("fixtureId"), 32) and hex_value(fixture.get("leafSha256"))
            and hex_value(fixture.get("rootSha256")), "fixture-evidence-incomplete", verdict="NOT_RUN")
    return fixture


def simulator(work, context, *, command=c1.run_command):
    return c1.RuntimeRun(work, work / "unused-c1-report.json", os.environ, command,
                         device_name="Bunny Talks C2 " + context["runId"], bundle_id=APP_IDS["candidate"])


def boot_environment(work, context, network, *, hosted_feasibility=False, command=c1.run_command):
    runner = simulator(work, context, command=command)
    if not hosted_feasibility:
        require_full(verify_confinement(network, work, context, window="before-boot"))
    # A hosted laboratory receipt carries no authorization to compile by itself.
    runner.verify_toolchain(require_hosted=hosted_feasibility or os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted")
    runner.find_runtime()
    require(not (work / "environment.json").exists() and not runner.device_set.exists(), "environment-already-prepared")
    try:
        runner.boot()
        return save_receipt(work, "environment", context, device=runner.device,
                            target="hosted-observed" if hosted_feasibility else "full",
                            toolchain=runner.evidence["toolchain"], simulator=runner.evidence["simulator"],
                            freeBytes=shutil.disk_usage(work).free)
    except BaseException:
        shutdown_error = runner.cleanup_device()
        if shutdown_error is not None:
            raise shutdown_error
        raise


def attach_device(runner, environment):
    runner.device = environment["device"]
    require(re.fullmatch(c1.UUID, runner.device), "simulator-identity-unconfirmed", verdict="NOT_RUN")
    runner.creation_attempted = True
    rows = runner.devices()
    require(len(rows) == 1 and rows[0].get("udid") == runner.device and rows[0].get("name") == runner.device_name
            and rows[0].get("state") == "Booted", "simulator-identity-mismatch")


def observe_installed(runner, phase, pid, launch):
    require(pid > 0, "installed-process-unconfirmed", verdict="NOT_RUN")
    path = runner.sim("get_app_container", runner.device, APP_IDS["candidate"], "app",
                      code="installed-app-unavailable", capture=True).output
    app = Path(path)
    require(app.is_absolute() and app.resolve().is_relative_to(runner.device_set / runner.device),
            "installed-container-mismatch")
    evidence = runner.app_hashes(app)
    require(all(launch["builds"]["candidate"][key] == value for key, value in evidence.items()),
            "installed-app-mismatch")
    process = c1.process_path(pid)
    require(process is not None, "installed-process-unconfirmed", verdict="NOT_RUN")
    require(process == (app / c1.EXECUTABLE).resolve(), "installed-process-mismatch")
    runner.installed = app.resolve()
    return {**evidence, "pid": pid, "device": runner.device, "phase": phase}


def phase_binding(work, launch):
    return {"prelaunchSha256": c1.digest(private_file(work, "prelaunch.json")),
            "device": launch["device"], "fixtureId": launch["fixtureId"]}


def stop_phase(runner, work, context, launch, phase):
    installed = load_receipt(work, "installed-" + phase, context)
    require(installed["binding"] == phase_binding(work, launch), "evidence-phase-mismatch")
    runner.pid = installed["pid"]
    observed = observe_installed(runner, phase, runner.pid, launch)
    require(all(installed[key] == value for key, value in observed.items()), "installed-process-mismatch")
    runner.stop()
    return save_receipt(work, "stopped-" + phase, context, binding=installed["binding"],
                        pid=runner.pid, installedSha256=c1.digest(private_file(work, "installed-" + phase + ".json")))


def run_protocol(actions, revision, approved, cleanup):
    report = {"schemaVersion": 1, "scope": "ios-https-candidate-c2", "revision": None,
              "identity": APP_IDS, "standardHttpsRuntime": "NOT_RUN",
              "stages": {name: {"verdict": "NOT_RUN"} for name in STAGES}}
    current = "revision"
    states = report["stages"]
    try:
        validate_revision(revision, approved)
        report["revision"] = revision
        states[current] = {"verdict": "PASS"}
        for current in STAGES[1:-1]:
            data = actions[current](report)
            states[current] = {"verdict": "PASS", "evidence": data}
    except (KeyboardInterrupt, c1.Interrupted):
        states[current] = {"verdict": "NOT_RUN", "code": "interrupted"}
    except StageError as error:
        states[current] = error.record
    except inspection.CheckFailed:
        states[current] = {"verdict": "FAIL", "code": "standard-inspection-rejected"}
    except inspection.EvidenceUnavailable as error:
        states[current] = {"verdict": "NOT_RUN", "code": str(error)}
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        states[current] = {"verdict": "NOT_RUN", "code": "evidence-unavailable"}
    finally:
        if states["installation"]["verdict"] == "PASS" and states["stop"]["verdict"] == "NOT_RUN":
            try:
                data = actions["stop"](report)
                states["stop"] = {"verdict": "PASS", "evidence": data}
            except (Exception, KeyboardInterrupt):
                states["stop"] = {"verdict": "NOT_RUN", "code": "process-stop-unconfirmed"}
        try:
            require(cleanup() is True, "cleanup-unconfirmed")
            states["cleanup"] = {"verdict": "PASS"}
        except (Exception, KeyboardInterrupt):
            states["cleanup"] = {"verdict": "FAIL", "code": "cleanup-unconfirmed"}
    verdicts = {stage["verdict"] for stage in states.values()}
    report["verdict"] = "FAIL" if "FAIL" in verdicts else ("NOT_RUN" if "NOT_RUN" in verdicts else "PASS")
    return report


def read_runtime(paths, *, command=c1.run_command):
    # Fixed executable and parser. Tool chatter and input contents never reach the report.
    evidence = []
    for path in paths:
        path = Path(path)
        require(path.is_file() and path.stat().st_size <= 4 * 1024 * 1024,
                "runtime-evidence-unavailable", verdict="NOT_RUN")
        evidence.append(str(path.absolute()))
    result = command(("node", str(MOBILE / "qualification/verify-ios-libcurl-runtime.mjs"),
                             "--standard", *evidence), cwd=MOBILE, timeout=15, capture=True)
    require(result.exit_code in (0, 1, 2), "runtime-evidence-unavailable", verdict="NOT_RUN")
    report = json.loads(result.output)
    require(report["verdict"] == {0: "PASS", 1: "FAIL", 2: "NOT_RUN"}[result.exit_code],
            "runtime-verdict-mismatch")
    return report


def verify_staging(source, work, tree, *, candidate_only=False):
    entries = manifest(source)
    require(tree_digest(entries) == tree, "reviewed-tree-mismatch")
    candidate_app, candidate_package = candidate_config(source)
    for name in (("candidate",) if candidate_only else APP_IDS):
        root = work / name
        if name == "candidate":
            require(c1.read_json(root / CONFIG) == candidate_app and c1.read_json(root / PACKAGE) == candidate_package,
                    "candidate-source-identity")
        for path, (digest, mode) in entries.items():
            actual = root / path
            require(actual.is_file() and actual.resolve().is_relative_to(root) and not actual.is_symlink()
                    and actual.stat().st_mode & 0o777 == mode, "reviewed-source-difference")
            if name == "standard" or path not in CHANGES:
                require(c1.digest(actual) == digest, "reviewed-source-difference")
        zip_path = root / MOBILE_RELATIVE / NATIVE / "vendor/xcframeworks.zip"
        require(zip_path.is_file() and not zip_path.is_symlink() and zip_path.resolve().is_relative_to(root)
                and c1.digest(zip_path) == vendor.ZIP_SHA256, "staged-archive-mismatch")
    return {"treeSha256": tree, "changes": sorted(CHANGES)}


def approve_context(args, inputs, work):
    context = c1.read_json(private_file(work, OWNER))
    owned_workspace(work, context)
    validate_revision(context["revision"], args.reviewed_revision)
    require(hex_value(args.reviewed_tree_sha256) and context["treeSha256"] == args.reviewed_tree_sha256,
            "reviewed-tree-mismatch")
    require(inputs.get("context") == context, "evidence-run-mismatch")
    return context


def load_fixture(work, context, environment):
    fixture = verify_fixture(load_receipt(work, "fixture", context), environment)
    require(fixture.get("environmentSha256") == c1.digest(private_file(work, "environment.json")),
            "fixture-environment-mismatch")
    return fixture


def verify_lab_ready(work, context, environment, *, command=c1.run_command):
    attach_device(simulator(work, context, command=command), environment)
    pilot = MOBILE / "qualification/run-ios-libcurl-runtime.mjs"
    result = command(("node", str(pilot), "--standard-check", str(work)),
                            cwd=MOBILE, timeout=10)
    require(result.exit_code == 0, "fixture-readiness-unconfirmed", verdict="NOT_RUN")


def prebuild_evidence(work, context, inputs, *, hosted_observed=False):
    environment = load_receipt(work, "environment", context)
    fixture = load_fixture(work, context, environment)
    if environment["target"] == "hosted-observed":
        network = {"profile": "hosted-observed", "fullConfinement": "NOT_RUN"}
        observed = verify_confinement(inputs["confinement"], work, context, window="before-build") \
            if inputs.get("confinement") else network
        if not hosted_observed:
            error = StageError("hosted-feasibility-only", verdict="NOT_RUN")
            error.record.update(network)
            raise error
        require(observed == network, "environment-profile-mismatch")
    else:
        require(environment["target"] == "full" and not hosted_observed,
                "environment-unconfirmed", verdict="NOT_RUN")
        network = require_full(verify_confinement(inputs.get("confinement"), work, context, window="before-build"))
    require(not (work / "fixture-stopped.json").exists(), "fixture-not-running", verdict="NOT_RUN")
    verify_lab_ready(work, context, environment)
    return {"device": environment["device"], "fixtureId": fixture["fixtureId"],
            "environmentSha256": c1.digest(private_file(work, "environment.json")),
            "fixtureSha256": c1.digest(private_file(work, "fixture.json")), "confinement": network}


def get_launch(work, context):
    launch = load_receipt(work, "prelaunch", context)
    for key, name in (("environmentSha256", "environment"), ("fixtureSha256", "fixture"),
                      ("prebuildSha256", "prebuild")):
        require(launch.get(key) == c1.digest(private_file(work, name + ".json")), "evidence-run-mismatch")
    return launch


def phase_wire(work, context, binding, phase):
    wire = load_receipt(work, phase + "-wire", context)
    require(wire.get("binding") == binding and wire.get("fixtureId") == binding["fixtureId"],
            "fixture-phase-mismatch")
    return wire


def verify_trust_transition(work, context, binding):
    fixture = load_receipt(work, "fixture", context)
    trusted = load_receipt(work, "trust", context)
    require(trusted.get("binding") == binding and trusted.get("rootSha256") == fixture["rootSha256"]
            and trusted.get("beforeWireSha256") == c1.digest(private_file(work, "before-wire.json")),
            "trust-transition-mismatch")
    return fixture


def verify_phases(work, context, launch):
    binding = phase_binding(work, launch)
    fixture = verify_trust_transition(work, context, binding)
    identities = {}
    paths = []
    for phase in PHASES:
        installed = load_receipt(work, "installed-" + phase, context)
        stopped = load_receipt(work, "stopped-" + phase, context)
        require(installed.get("binding") == stopped.get("binding") == binding
                and stopped["pid"] == installed["pid"] and installed["device"] == launch["device"]
                and type(installed["pid"]) is int and 0 < installed["pid"] <= 2**31 - 1
                and installed["phase"] == phase and stopped.get("installedSha256")
                == c1.digest(private_file(work, "installed-" + phase + ".json")), "evidence-phase-mismatch")
        require(all(installed.get(key) == launch["builds"]["candidate"][key]
                    for key in ("bundleId", *BUILD_KEYS[:2])), "installed-app-mismatch")
        wire = phase_wire(work, context, binding, phase)
        require(wire.get("stoppedSha256") == c1.digest(private_file(work, "stopped-" + phase + ".json")),
                "evidence-phase-mismatch")
        log = private_file(work, phase + ".log")
        require(wire.get("logSha256") == c1.digest(log), "evidence-phase-mismatch")
        marker = "[BunnyIosStandardHttpsRun] " + context["runId"] + " " + fixture["fixtureId"] + " " + phase
        marks = [line for line in log.read_text().splitlines() if "[BunnyIosStandardHttpsRun]" in line]
        require(len(marks) == 1 and marks[0].endswith(marker), "log-run-mismatch")
        identities[phase] = {key: installed[key] for key in ("pid", "bundleId", *BUILD_KEYS[:2])}
        paths.extend((log, private_file(work, phase + "-wire.json")))
    require(identities["before"]["pid"] != identities["after"]["pid"], "installed-process-mismatch")
    return identities, paths


def cleanup_simulator(work, context, *, command=c1.run_command):
    runner = simulator(work, context, command=command)
    if (work / "environment.json").exists():
        runner.device = load_receipt(work, "environment", context)["device"]
    runner.creation_attempted = runner.device_set.exists()
    shutdown_error = runner.cleanup_device()
    if shutdown_error is not None:
        if runner.evidence.get("simulatorRemoved") is True:
            shutdown_error.record["simulatorRemoved"] = "PASS"
        raise shutdown_error
    return save_receipt(work, "device-cleanup", context, device=runner.device, inventoryEmpty=True)


def review(args):
    inputs = c1.read_json(args.input)
    work = Path(inputs["workspace"])
    context = approve_context(args, inputs, work)
    source = Path(inputs["reviewedSource"])

    if args.mode == "environment":
        verify_archive(Path(inputs["archive"]))
        verify_staging(source, work, context["treeSha256"])
        return boot_environment(work, context, inputs.get("initialConfinement"),
                                hosted_feasibility=args.hosted_feasibility)

    if args.mode == "prebuild":
        candidate_only = getattr(args, "candidate_only", False)
        verify_archive(Path(inputs["archive"]))
        verify_staging(source, work, context["treeSha256"], candidate_only=candidate_only)
        return save_receipt(work, "prebuild", context, **prebuild_evidence(
            work, context, inputs, hosted_observed=getattr(args, "hosted_observed", False)),
            **({"qualificationScope": CANDIDATE_SCOPE} if candidate_only else {}))

    if args.mode == "prelaunch":
        candidate_only = getattr(args, "candidate_only", False)
        prebuild = load_receipt(work, "prebuild", context)
        current = prebuild_evidence(work, context, inputs, hosted_observed=getattr(args, "hosted_observed", False))
        require(prebuild.get("qualificationScope") == (CANDIDATE_SCOPE if candidate_only else None),
                "prebuild-scope-mismatch")
        require(all(prebuild[key] == value for key, value in current.items()), "prebuild-evidence-mismatch")
        _, archive = verify_archive(Path(inputs["archive"]))
        staging = verify_staging(source, work, context["treeSha256"], candidate_only=candidate_only)
        if candidate_only:
            name = "candidate"
            paths = inputs["builds"][name]
            evidence = inspect_build(work / name, *(Path(paths[key]) for key in
                                     ("derived", "sourceMap", "podSettings", "compileCommands")),
                                     archive, name=name, collect_objects=False)
            release = evidence["release"]
            require(release.get("bundleId") == APP_IDS[name], "release-identity")
            require(release.get("verdict") == "PASS", "inspection-incomplete", verdict="NOT_RUN")
            require(all(hex_value(release.get(key)) for key in BUILD_KEYS), "build-fingerprints-unavailable",
                    verdict="NOT_RUN")
            provenance = {key: release[key] for key in CANDIDATE_RELEASE_KEYS}
            provenance.update(nativeSources=evidence["nativeSources"], targetedSymbols=sorted(release["definitions"]),
                              transportLinkSelectionSha256=evidence_digest(release["transportLinkSelection"]))
            return save_receipt(work, "prelaunch", context, **current, qualificationScope=CANDIDATE_SCOPE,
                                builds={name: {"bundleId": APP_IDS[name], **{key: release[key] for key in BUILD_KEYS}}},
                                provenance=provenance, archive=archive, staging=staging,
                                prebuildSha256=c1.digest(private_file(work, "prebuild.json")))
        reports = []
        for name in APP_IDS:
            paths = inputs["builds"][name]
            reports.append(inspect_build(work / name, *(Path(paths[key]) for key in
                           ("derived", "sourceMap", "podSettings", "compileCommands")), archive, name=name))
        return save_receipt(work, "prelaunch", context, **current, builds=compare_builds(*reports),
                            archive=archive, staging=staging,
                            prebuildSha256=c1.digest(private_file(work, "prebuild.json")))

    def launched(_):
        return get_launch(work, context)

    runtime_paths = None

    def installation(_):
        nonlocal runtime_paths
        phases, runtime_paths = verify_phases(work, context, launched(None))
        return phases

    def runtime(report):
        result = read_runtime(runtime_paths)
        if result["verdict"] != "PASS":
            report["runtimeEvidence"] = result
            raise StageError("runtime-evidence-not-passing", verdict=result["verdict"])
        return result

    def stop(_):
        for phase in PHASES:
            load_receipt(work, "stopped-" + phase, context)
        return {"beforeStopped": True, "afterStopped": True}

    def cleanup():
        device = load_receipt(work, "device-cleanup", context)
        require(device.get("inventoryEmpty") is True, "cleanup-unconfirmed")
        if (work / "environment.json").exists():
            require(device.get("device") == load_receipt(work, "environment", context)["device"], "cleanup-unconfirmed")
        if (work / "fixture-start.json").exists():
            started = load_receipt(work, "fixture-start", context)
            closed = load_receipt(work, "fixture-stopped", context)
            require(closed.get("fixtureId") == started["fixtureId"] and closed.get("closed") is True,
                    "cleanup-unconfirmed")
        return remove_workspace(work, context)

    def fixture_summary(_):
        fixture = load_fixture(work, context, load_receipt(work, "environment", context))
        return {key: fixture[key] for key in ("fixtureId", "leafSha256", "rootSha256", "initialCounters")}

    def environment_summary(_):
        environment = load_receipt(work, "environment", context)
        return {key: environment[key] for key in ("device", "target", "toolchain", "simulator", "freeBytes")}

    actions = {
        "archive": lambda _: verify_archive(Path(inputs["archive"]))[1],
        "staging": lambda _: verify_staging(source, work, context["treeSha256"]),
        "environment": environment_summary,
        "fixture": fixture_summary,
        "confinement": lambda _: require_full(verify_confinement(inputs.get("finalConfinement"), work, context,
                                                                window="through-stop")),
        "nativeEquivalence": lambda _: launched(None)["builds"],
        "installation": installation,
        "candidateRuntime": runtime,
        "stop": stop,
    }
    return {**run_protocol(actions, context["revision"], args.reviewed_revision, cleanup), "context": context}


def observe(args):
    work = args.workspace
    context = c1.read_json(private_file(work, OWNER))
    owned_workspace(work, context)
    if args.mode == "cleanup-simulator":
        return cleanup_simulator(work, context)
    launch = get_launch(work, context)
    runner = simulator(work, context)
    attach_device(runner, load_receipt(work, "environment", context))
    binding = phase_binding(work, launch)
    if args.mode == "trust":
        wire = phase_wire(work, context, binding, "before")
        require(wire.get("stoppedSha256") == c1.digest(private_file(work, "stopped-before.json")),
                "evidence-phase-mismatch")
        fixture = load_receipt(work, "fixture", context)
        root = private_file(work, args.root)
        require(c1.digest(root) == fixture["rootSha256"] and not (work / "trust.json").exists(),
                "fixture-root-mismatch")
        runner.sim("keychain", runner.device, "add-root-cert", str(root), code="fixture-root-install-failed")
        return save_receipt(work, "trust", context, binding=binding, rootSha256=fixture["rootSha256"],
                            beforeWireSha256=c1.digest(private_file(work, "before-wire.json")))
    if args.mode == "stop":
        return stop_phase(runner, work, context, launch, args.phase)
    if args.phase == "before":
        require(not (work / "trust.json").exists(), "trust-phase-mismatch")
    else:
        require(load_receipt(work, "trust", context)["binding"] == binding, "trust-phase-mismatch")
    evidence = observe_installed(runner, args.phase, args.pid, launch)
    return save_receipt(work, "installed-" + args.phase, context, binding=binding, **evidence)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    stage = modes.add_parser("stage")
    for name in ("source", "workspace", "archive"):
        stage.add_argument(name, type=Path)
    stage.add_argument("--revision", required=True)
    stage.add_argument("--reviewed-revision", required=True)
    stage.add_argument("--reviewed-tree-sha256", required=True)
    inventory = modes.add_parser("inventory")
    inventory.add_argument("source", type=Path)
    generated = modes.add_parser("generated")
    generated.add_argument("workspace", type=Path)
    generated.add_argument("application", choices=APP_IDS)
    for mode in ("installed", "stop", "trust", "cleanup-simulator"):
        observe_mode = modes.add_parser(mode)
        observe_mode.add_argument("workspace", type=Path)
        if mode in ("installed", "stop"):
            observe_mode.add_argument("phase", choices=PHASES)
        if mode == "installed":
            observe_mode.add_argument("pid", type=int)
        if mode == "trust":
            observe_mode.add_argument("root", type=Path)
    for mode in ("environment", "prebuild", "prelaunch", "review"):
        report = modes.add_parser(mode)
        report.add_argument("input", type=Path)
        report.add_argument("--reviewed-revision", required=True)
        report.add_argument("--reviewed-tree-sha256", required=True)
        if mode == "environment":
            report.add_argument("--hosted-feasibility", action="store_true")
        if mode in ("prebuild", "prelaunch"):
            report.add_argument("--hosted-observed", action="store_true")
            report.add_argument("--candidate-only", action="store_true")
    args = parser.parse_args()
    signal.signal(signal.SIGINT, c1.interrupt)
    signal.signal(signal.SIGTERM, c1.interrupt)
    try:
        check_environment(os.environ)
        if args.mode == "inventory":
            result = {"verdict": "PASS", "treeSha256": tree_digest(manifest(args.source))}
        elif args.mode == "stage":
            validate_revision(args.revision, args.reviewed_revision)
            raw, archive = verify_archive(args.archive)
            staging = stage_pair(args.source, args.workspace, args.reviewed_tree_sha256, raw, args.revision)
            result = {"verdict": "PASS", "scope": "source-staging", "revision": args.revision,
                      "archive": archive, "staging": staging, "standardHttpsRuntime": "NOT_RUN"}
        elif args.mode == "generated":
            inspection.check_generated(args.workspace / args.application / MOBILE_RELATIVE / "ios",
                                       bundle_id=APP_IDS[args.application])
            result = {"verdict": "PASS", "bundleId": APP_IDS[args.application]}
        elif args.mode in ("installed", "stop", "trust", "cleanup-simulator"):
            result = observe(args)
        else:
            result = review(args)
        result.setdefault("verdict", "PASS")
    except StageError as error:
        result = error.record
    except inspection.CheckFailed:
        result = {"verdict": "FAIL", "code": "standard-inspection-rejected"}
    except inspection.EvidenceUnavailable as error:
        result = {"verdict": "NOT_RUN", "code": str(error)}
    except (KeyboardInterrupt, c1.Interrupted):
        result = {"verdict": "NOT_RUN", "code": "interrupted"}
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        result = {"verdict": "NOT_RUN", "code": "evidence-unavailable"}
    print(json.dumps(result, sort_keys=True, indent=2))
    return {"PASS": 0, "FAIL": 1, "NOT_RUN": 2}[result["verdict"]]


if __name__ == "__main__":
    raise SystemExit(main())
