"""Collect scoped Mach-O and link-map evidence for the dedicated Release target."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

RESULTS = Path("qualification/ios-libcurl-results")
PRODUCTS = Path("ios/build/Build/Products/Release-iphonesimulator")
BUNDLE = "fr.bunnytalks.mobile.httpsqualification.libcurl"
SYMBOLS = {
    "_curl_multi_perform": "libcurl.a(libcurl_la-multi.o)",
    "_curl_version_info": "libcurl.a(libcurl_la-version.o)",
    "_OPENSSL_init_ssl": "libopenssl.a(libssl-lib-ssl_init.o)",
}
MAP_SYMBOLS = {name.encode("ascii"): name for name in SYMBOLS}
MAP_OBJECTS = {label.encode("ascii") for label in SYMBOLS.values()}
MAP_HEX = rb"(?:0[xX])?[0-9A-Fa-f]{1,16}"
MAP_ID = rb"(0|[1-9][0-9]{0,9})"
# Fail closed if an opaque byte could be shadowing an exact target name.
MAP_UNCERTAIN_SYMBOLS = re.compile(b"|".join(
    rb"[\x80-\xff]*" + rb"[\x80-\xff]*".join(bytes([byte]) for byte in name) + rb"[\x80-\xff]*"
    for name in MAP_SYMBOLS
))


def require(condition):
    if not condition:
        raise ValueError("unconfirmed link evidence")


def command(*args):
    return subprocess.run(
        args, check=True, capture_output=True, text=True, timeout=30,
    ).stdout


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()


def inspect_definitions(output):
    entries = {name: [] for name in SYMBOLS}
    for line in output.splitlines():
        fields = line.split()
        if not fields or fields[-1] not in entries:
            continue
        name = fields[-1]
        row = re.fullmatch(r"([0-9a-fA-F]+)\s+\(([^)]+)\)\s+(.+?)\s+" + name, line.strip())
        require(row)
        address, section, attributes = row.groups()
        require(re.fullmatch(r"[A-Za-z0-9_,]{1,80}", section))
        if "non-external" in attributes:
            visibility = "local"
        elif re.search(r"\b(?:private )?external\b", attributes):
            visibility = "external"
        else:
            visibility = "unknown"
        entries[name].append({
            "address": int(address, 16),
            "section": section,
            "visibility": visibility,
            "weak": "weak" in attributes.split(),
        })
    return entries


class LinkMapError(ValueError):
    pass


def require_map(condition, reason):
    if not condition:
        raise LinkMapError("link-map-" + reason)


def object_label(value):
    leaf = value.rsplit(b"/", 1)[-1]
    require_map(value.isascii() and re.fullmatch(rb"[A-Za-z0-9_ .()+\[\],:@-]{1,255}", leaf), "object-label")
    return leaf.decode("ascii")


def inspect_map(source, app, executable):
    objects, live, stripped = {}, {}, {}
    expected_objects = set()
    map_path, architecture, section = None, None, None
    columns = {
        "sections": [b"#", b"Address", b"Size", b"Segment", b"Section"],
        "live": [b"#", b"Address", b"Size", b"File", b"Name"],
        "stripped": [b"#", b"Size", b"File", b"Name"],
    }
    # ld64 uses LF records and opaque names, including bytes copied from C string literals.
    require_map(source.endswith(b"\n"), "incomplete-record")
    for line in source.split(b"\n"):
        if not line:
            continue
        if line.startswith(b"# Path: "):
            require_map(map_path is None, "duplicate-path")
            require_map(section is None, "header-order")
            map_path = line.removeprefix(b"# Path: ")
        elif line.startswith(b"# Arch: "):
            require_map(architecture is None, "duplicate-architecture")
            require_map(section is None, "header-order")
            architecture = line.removeprefix(b"# Arch: ")
        elif line == b"# Object files:":
            require_map(section is None, "section-order")
            section = "objects"
        elif line == b"# Sections:":
            require_map(section == "objects", "section-order")
            section = "sections"
        elif line == b"# Symbols:":
            require_map(section == "sections", "section-order")
            section = "live"
        elif line == b"# Dead Stripped Symbols:":
            require_map(section == "live", "section-order")
            section = "stripped"
        elif line.startswith(b"#"):
            require_map(re.fullmatch(rb"[\t -~]+", line) and line.split() == columns.get(section), "unknown-header")
        elif section == "objects":
            row = re.fullmatch(rb"\[[ \t]*" + MAP_ID + rb"\][ \t]([^\x00-\x1f\x7f]+)", line)
            require_map(row and int(row[1]) <= 0xFFFFFFFF, "object-record")
            require_map(row[1] not in objects, "duplicate-object")
            leaf = row[2].rsplit(b"/", 1)[-1]
            if leaf in MAP_OBJECTS:
                require_map(leaf not in expected_objects, "ambiguous-object")
                expected_objects.add(leaf)
            objects[row[1]] = row[2]
        elif section == "sections":
            row = re.fullmatch(MAP_HEX + rb"[ \t]+" + MAP_HEX + rb"(?:[ \t]+[!-~]{1,16}){2}", line)
            require_map(row, "section-record")
        elif section in ("live", "stripped"):
            row = re.fullmatch(rb"([^ \t]+)[ \t]+([^ \t]+)[ \t]+\[[ \t]*" + MAP_ID + rb"\][ \t]([^\x00]+)", line)
            require_map(row, "symbol-record")
            address, size, object_id, raw_name = row.groups()
            require_map(object_id in objects, "unknown-symbol-object")
            require_map(re.fullmatch(MAP_HEX, size), "symbol-size")
            require_map(
                re.fullmatch(MAP_HEX, address) if section == "live" else address == b"<<dead>>",
                "symbol-address",
            )
            name = MAP_SYMBOLS.get(raw_name)
            if name is None:
                require_map(not MAP_UNCERTAIN_SYMBOLS.fullmatch(raw_name.strip()), "symbol-name")
                continue
            records = live if section == "live" else stripped
            records.setdefault(name, []).append({
                "object": object_id.decode("ascii"),
                "size": int(size, 16),
                "address": int(address, 16) if section == "live" else None,
            })
        else:
            raise LinkMapError("link-map-header-order")
    require_map(architecture == b"arm64", "architecture")
    suffix = f"/Release-iphonesimulator/{app}/{executable}".encode("ascii")
    require_map(map_path and re.fullmatch(rb"[ -~]+", map_path) and map_path.endswith(suffix), "executable-path")
    require_map(section in ("live", "stripped"), "missing-sections")
    require_map(objects, "missing-objects")
    require_map(live, "missing-live-symbols")
    referenced = {row["object"] for records in (live, stripped) for rows in records.values() for row in rows}
    labels = {key: object_label(objects[key.encode("ascii")]) for key in referenced}
    return {"objects": labels, "liveSymbols": live, "deadStrippedSymbols": stripped}


def link_matches(definitions, link_map):
    for name, expected in SYMBOLS.items():
        entries = definitions[name]
        rows = link_map["liveSymbols"].get(name, [])
        if len(entries) != 1 or len(rows) != 1:
            return False
        entry, row = entries[0], rows[0]
        if (entry["address"] != row["address"] or entry["section"] != "__TEXT,__text"
                or entry["visibility"] == "unknown" or entry["weak"]
                or link_map["objects"][row["object"]] != expected or row["size"] <= 0):
            return False
    return True


def inspect_frameworks(app):
    reports = {}
    for framework in sorted((app / "Frameworks").glob("*.framework")):
        require(re.fullmatch(r"[A-Za-z0-9_.-]+\.framework", framework.name))
        executable = command(
            "plutil", "-extract", "CFBundleExecutable", "raw", "-o", "-", framework / "Info.plist",
        ).strip()
        require(re.fullmatch(r"[A-Za-z0-9_-]+", executable))
        binary = framework / executable
        reports[framework.name] = {
            "executableSha256": digest(binary),
            "definitions": inspect_definitions(command("xcrun", "nm", "-arch", "arm64", "-m", "-U", binary)),
        }
    require(reports)
    return reports


def inspect():
    report = {"verdict": "NOT_RUN", "reason": "binary-unavailable"}
    try:
        apps = list(PRODUCTS.glob("*.app"))
        require(len(apps) == 1)
        app = apps[0]
        plist = app / "Info.plist"
        identifier = command("plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", plist).strip()
        name = command("plutil", "-extract", "CFBundleExecutable", "raw", "-o", "-", plist).strip()
        require(identifier == BUNDLE and re.fullmatch(r"[A-Za-z0-9_-]+", name))
        binary = app / name
        require(command("xcrun", "lipo", "-archs", binary).split() == ["arm64"])
        build = command("xcrun", "vtool", "-show-build", binary)
        require(re.search(r"^\s*platform\s+IOSSIMULATOR\s*$", build, re.M))
        minimum = re.search(r"^\s*minos\s+(\d+(?:\.\d+){1,2})\s*$", build, re.M)
        require(minimum)
        dependencies = []
        for line in command("xcrun", "otool", "-L", binary).splitlines()[1:]:
            row = re.fullmatch(
                r"\s*((?:/System/Library/Frameworks/|/usr/lib/|@rpath/)[A-Za-z0-9/_.+\-]+)"
                r" \(compatibility version [^)]+\)", line,
            )
            require(row)
            dependencies.append(row[1])
        require(dependencies)
        report.update({
            "bundleId": identifier,
            "executable": name,
            "executableSha256": digest(binary),
            "platform": "IOSSIMULATOR",
            "architecture": "arm64",
            "configuration": "Release",
            "minimumOS": minimum[1],
            "dependencies": dependencies,
        })
        if (
            any(re.search(r"(?:libcurl|libssl|libcrypto|libopenssl)(?:\.|/)", item, re.I)
                for item in dependencies)
            or not all(any(required in item for item in dependencies)
                       for required in ("Security.framework/", "hermesvm.framework/", "/libz.1.dylib"))
        ):
            return {**report, "verdict": "FAIL", "reason": "dynamic-dependencies"}

        report["reason"] = "build-identity-unavailable"
        build_id = os.environ.get("EAS_BUILD_ID", "")
        metadata = json.loads(Path("qualification/ios-libcurl-input.json").read_text())
        revision = metadata["reviewedRevision"]
        require(re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", build_id))
        require(re.fullmatch(r"[0-9a-f]{40}", revision))
        provenance = json.loads((RESULTS / "provenance.json").read_text())
        report.update({
            "easBuildId": build_id,
            "reviewedRevision": revision,
            "zipSha256": provenance["artifactZipSha256"],
            "manifestSha256": provenance["manifestSha256"],
            "archives": provenance["archives"],
        })

        report["reason"] = "mach-o-symbols-unconfirmed"
        definitions = inspect_definitions(command("xcrun", "nm", "-m", "-U", binary))
        report["definitions"] = definitions
        maps = list(Path("ios/build").rglob("BunnyHttpsLinkMap-arm64.txt"))
        report["reason"] = "link-map-unavailable"
        require(len(maps) == 1 and maps[0].stat().st_size <= 128 * 1024 * 1024)
        report["reason"] = "link-map-read-error"
        raw_map = maps[0].read_bytes()
        report["rawMapSha256"] = hashlib.sha256(raw_map).hexdigest()
        report["reason"] = "link-map-unconfirmed"
        link_map = inspect_map(raw_map, app.name, name)
        report["linkMap"] = link_map
        if not link_matches(definitions, link_map):
            return {**report, "verdict": "FAIL", "reason": "symbol-provenance-mismatch"}
        report["reason"] = "framework-symbols-unconfirmed"
        frameworks = inspect_frameworks(app)
        report["frameworks"] = frameworks
        if any(rows for framework in frameworks.values() for rows in framework["definitions"].values()):
            return {**report, "verdict": "FAIL", "reason": "additional-framework-definition"}
        return {**report, "verdict": "PASS", "reason": "selected-objects-correlated"}
    except LinkMapError as error:
        return {**report, "reason": str(error)}
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return report


if __name__ == "__main__":
    if sys.platform != "darwin" or os.environ.get("EAS_BUILD_PROFILE") != "ios-https-libcurl-runtime":
        sys.exit("The dedicated Apple worker is required.")
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "link.json").write_text(json.dumps(inspect(), sort_keys=True, indent=2) + "\n")
