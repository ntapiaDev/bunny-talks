"""Stage and verify the exact XCFramework artifact accepted in 4.5B2C3-A."""
import argparse
import hashlib
import io
import json
import os
import plistlib
import re
import shutil
import stat
import tarfile
import tempfile
import zipfile
from pathlib import Path


ZIP_SHA256 = "57908367212fb83b17b830e1aa69c0e4282e7afbb4fd368294943216f625d841"
SLICES = {"ios-arm64": ("iphoneos", "IOS"), "ios-arm64-simulator": ("iphonesimulator", "IOSSIMULATOR")}
LIBRARIES = {"libcurl": "curl/curl.h", "libopenssl": "openssl/ssl.h"}
METADATA = {"manifest.json", "curl-COPYING", "openssl-LICENSE.txt"}


class VerificationError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def inventory(path):
    if path in METADATA:
        return True
    return re.fullmatch(
        r"(?:libcurl|libopenssl)\.xcframework/(?:Info\.plist|ios-arm64(?:-simulator)?/"
        r"(?:lib(?:curl|openssl)\.a|Headers/(?:curl|openssl)/[A-Za-z0-9_-]+\.h))",
        path,
    ) is not None


def read_zip(archive):
    require(not archive.parent.is_symlink(), "symbolic link in XCFramework ZIP path")
    require(archive.is_file() and not archive.is_symlink(), "approved XCFramework ZIP is missing")
    require(archive.stat().st_size <= 16 * 1024 * 1024, "XCFramework ZIP exceeds the approved size bound")
    return archive.read_bytes()


def files_from_archive(source, pin=ZIP_SHA256):
    require(sha256(source) == pin, "XCFramework ZIP SHA-256 mismatch")
    with zipfile.ZipFile(io.BytesIO(source)) as outer:
        require(outer.namelist() == ["xcframeworks.tar"], "unexpected ZIP inventory")
        member = outer.infolist()[0]
        require(member.file_size <= 128 * 1024 * 1024, "XCFramework tar exceeds the approved size bound")
        payload = outer.read(member)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:") as package:
        for item in package:
            name = item.name
            if item.isdir():
                require(re.fullmatch(
                    r"(?:libcurl|libopenssl)\.xcframework(?:/ios-arm64(?:-simulator)?"
                    r"(?:/Headers(?:/(?:curl|openssl))?)?)?",
                    name,
                ), "unexpected directory in XCFramework tar")
                continue
            require(item.isfile() and inventory(name) and name not in files, "unexpected XCFramework file")
            with package.extractfile(item) as data:
                files[name] = data.read()
    return files


def verify(files):
    require(METADATA <= files.keys(), "missing licenses or manifest")
    manifest = json.loads(files["manifest.json"])
    hashes = manifest["sha256"]
    require(set(hashes) == files.keys() - {"manifest.json"}, "manifest inventory mismatch")
    for path, expected in hashes.items():
        require(sha256(files[path]) == expected, "XCFramework file SHA-256 mismatch")
    profile = manifest["profile"]
    require(profile["architecture"] == "arm64" and profile["minimumOS"] == "16.4", "incompatible build profile")
    upstream = {entry["directory"] for entry in profile["upstream"]}
    require(upstream == {"curl-8.23.0", "openssl-3.5.9"}, "unexpected native dependencies")
    observations = {entry["sdk"]: entry for entry in manifest["observations"]}
    require(len(manifest["observations"]) == 2 and set(observations) == {v[0] for v in SLICES.values()},
            "unexpected SDK observations")
    for sdk, platform in SLICES.values():
        probes = observations[sdk]["probes"]
        require(len(probes) == 2 and {probe["mode"] for probe in probes} == {"system", "qualification"},
                "missing or repeated link probes")
        for probe in probes:
            macho = probe["macho"]
            require(probe["importsSecTrust"] is True and macho["architecture"] == "arm64"
                    and macho["platform"] == platform and macho["minimumOS"] == "16.4"
                    and macho["sdks"] == ["26.5"], "incompatible link probe")
    for library, header in LIBRARIES.items():
        base = f"{library}.xcframework"
        slices = plistlib.loads(files[f"{base}/Info.plist"])["AvailableLibraries"]
        require(len(slices) == 2, "unexpected XCFramework slices")
        for slice_id, (sdk, platform) in SLICES.items():
            matching = [item for item in slices if item["LibraryIdentifier"] == slice_id]
            require(len(matching) == 1, "missing or repeated XCFramework slice")
            expected_variant = "simulator" if sdk == "iphonesimulator" else None
            item = matching[0]
            require(item["SupportedArchitectures"] == ["arm64"] and item["SupportedPlatform"] == "ios"
                    and item.get("SupportedPlatformVariant") == expected_variant
                    and item["LibraryPath"] == f"{library}.a" and item["HeadersPath"] == "Headers",
                    "incompatible XCFramework slice")
            prefix = f"{base}/{slice_id}"
            require(f"{prefix}/Headers/{header}" in files
                    and files[f"{prefix}/{library}.a"].startswith(b"!<arch>\n"), "missing archive or headers")
            observed = [entry for entry in observations[sdk]["archives"] if entry["library"] == library]
            require(len(observed) == 1 and observed[0]["architecture"] == "arm64"
                    and observed[0]["platform"] == platform and observed[0]["minimumOS"] == "16.4",
                    "incompatible Mach-O observation")
    return manifest


def verify_installed(directory, files):
    require(not directory.parent.is_symlink(), "symbolic link in XCFramework staging path")
    require(directory.is_dir() and not directory.is_symlink(), "missing or invalid staged XCFramework directory")
    found = set()
    for path in directory.rglob("*"):
        kind = path.lstat().st_mode
        relative = path.relative_to(directory).as_posix()
        if stat.S_ISDIR(kind):
            require(any(name.startswith(relative + "/") for name in files), "unexpected staged directory")
            continue
        require(stat.S_ISREG(kind) and relative in files, "unexpected staged file or symbolic link")
        require(path.stat().st_size == len(files[relative]) and path.read_bytes() == files[relative],
                "staged XCFramework differs from the approved archive")
        found.add(relative)
    require(found == set(files), "missing staged XCFramework file")


def stage(directory, files):
    require(not directory.parent.is_symlink(), "symbolic link in XCFramework staging path")
    if directory.exists() or directory.is_symlink():
        verify_installed(directory, files)
        return
    temporary = Path(tempfile.mkdtemp(prefix="xcframeworks.", dir=directory.parent))
    try:
        for relative, data in files.items():
            path = temporary / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        temporary.rename(directory)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def install_zip(vendor, source):
    vendor.mkdir(exist_ok=True)
    require(vendor.is_dir() and not vendor.is_symlink(), "invalid XCFramework vendor directory")
    archive = vendor / "xcframeworks.zip"
    with tempfile.TemporaryDirectory(prefix="xcframework-zip.", dir=vendor) as temporary:
        candidate = Path(temporary) / archive.name
        candidate.write_bytes(source)
        try:
            # Publish complete bytes without replacing an existing path.
            os.link(candidate, archive)
        except FileExistsError:
            require(read_zip(archive) == source, "existing XCFramework ZIP differs from the approved archive")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["archive", "install", "stage", "verify"])
    parser.add_argument("zip", type=Path)
    parser.add_argument("directory", type=Path, nargs="?")
    args = parser.parse_args()
    if args.mode in ("stage", "verify") and args.directory is None:
        parser.error("stage and verify require a directory")
    if args.mode in ("archive", "install") and args.directory is not None:
        parser.error("archive and install take only a ZIP path")
    try:
        source = read_zip(args.zip)
        files = files_from_archive(source)
        manifest = verify(files)
        if args.mode == "install":
            install_zip(Path(__file__).resolve().parent / "vendor", source)
        elif args.mode == "stage":
            stage(args.directory, files)
        elif args.mode == "verify":
            verify_installed(args.directory, files)
        print(json.dumps({
            "run": "44942974411",
            "revision": "8b965b0e209e3145bcff0f68fda9586a9c33c144",
            "artifactZipSha256": ZIP_SHA256,
            "manifestSha256": sha256(files["manifest.json"]),
            "archives": {path: digest for path, digest in manifest["sha256"].items() if path.endswith(".a")},
            "observations": manifest["observations"],
        }, sort_keys=True))
    except VerificationError as error:
        parser.exit(1, f"ApplicationHttps: {error}\n")
    except (OSError, KeyError, TypeError, ValueError, tarfile.TarError, zipfile.BadZipFile, plistlib.InvalidFileException):
        parser.exit(1, "ApplicationHttps: could not read approved XCFramework package\n")


if __name__ == "__main__":
    main()
