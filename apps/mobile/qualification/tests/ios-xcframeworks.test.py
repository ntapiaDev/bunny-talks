"""Synthetic inventories exercise local verification, without simulating an Apple build."""
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import tarfile
import tempfile
import unittest
import zipfile

script = Path(__file__).resolve().parents[2] / "modules/application-https/ios/verify_xcframeworks.py"
spec = importlib.util.spec_from_file_location("verification", script)
verification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verification)


def fixture():
    files = {"curl-COPYING": b"notice", "openssl-LICENSE.txt": b"notice"}
    observations = {
        sdk: {"sdk": sdk, "archives": [], "probes": [
            {"mode": mode, "importsSecTrust": True, "macho": {
                "architecture": "arm64", "platform": platform, "minimumOS": "16.4", "sdks": ["26.5"],
            }} for mode in ("qualification", "system")
        ]} for sdk, platform in verification.SLICES.values()
    }
    for library, header in verification.LIBRARIES.items():
        slices = []
        for slice_id, (sdk, platform) in verification.SLICES.items():
            entry = {
                "LibraryIdentifier": slice_id, "SupportedArchitectures": ["arm64"],
                "SupportedPlatform": "ios", "LibraryPath": library + ".a", "HeadersPath": "Headers",
            }
            if sdk == "iphonesimulator":
                entry["SupportedPlatformVariant"] = "simulator"
            slices.append(entry)
            prefix = f"{library}.xcframework/{slice_id}"
            files[f"{prefix}/{library}.a"] = b"!<arch>\nsynthetic"
            files[f"{prefix}/Headers/{header}"] = b"header"
            observations[sdk]["archives"].append({
                "library": library, "architecture": "arm64", "platform": platform, "minimumOS": "16.4",
            })
        files[f"{library}.xcframework/Info.plist"] = plistlib.dumps({"AvailableLibraries": slices})
    manifest = {
        "profile": {
            "architecture": "arm64", "minimumOS": "16.4",
            "upstream": [{"directory": "curl-8.23.0"}, {"directory": "openssl-3.5.9"}],
        },
        "observations": list(observations.values()),
        "sha256": {name: verification.sha256(data) for name, data in files.items()},
    }
    files["manifest.json"] = json.dumps(manifest).encode()
    return files


class PackageTest(unittest.TestCase):
    def test_verify_and_refuse_modified_installed_file(self):
        files = fixture()
        verification.verify(files)
        with tempfile.TemporaryDirectory() as root:
            package = Path(root) / "package"
            verification.stage(package, files)
            verification.verify_installed(package, files)
            (package / "curl-COPYING").write_bytes(b"changed")
            with self.assertRaisesRegex(verification.VerificationError, "differs"):
                verification.stage(package, files)

    def test_refuse_wrong_platform_even_with_matching_fingerprints(self):
        files = fixture()
        key = "libcurl.xcframework/Info.plist"
        plist = plistlib.loads(files[key])
        plist["AvailableLibraries"][0]["SupportedPlatform"] = "macos"
        files[key] = plistlib.dumps(plist)
        manifest = json.loads(files["manifest.json"])
        manifest["sha256"][key] = verification.sha256(files[key])
        files["manifest.json"] = json.dumps(manifest).encode()
        with self.assertRaisesRegex(verification.VerificationError, "incompatible XCFramework"):
            verification.verify(files)

    def test_refuse_wrong_pin_and_special_tar_entries(self):
        with tempfile.TemporaryDirectory() as root:
            archive = Path(root) / "xcframeworks.zip"
            payload = io.BytesIO()
            with tarfile.open(fileobj=payload, mode="w:") as package:
                entry = tarfile.TarInfo("manifest.json")
                entry.type = tarfile.SYMTYPE
                entry.linkname = "../unexpected"
                package.addfile(entry)
            with zipfile.ZipFile(archive, "w") as zipped:
                zipped.writestr("xcframeworks.tar", payload.getvalue())
            with self.assertRaisesRegex(verification.VerificationError, "SHA-256 mismatch"):
                verification.files_from_archive(archive)
            with self.assertRaisesRegex(verification.VerificationError, "unexpected XCFramework file"):
                verification.files_from_archive(archive, verification.sha256(archive.read_bytes()))


if __name__ == "__main__":
    unittest.main()
