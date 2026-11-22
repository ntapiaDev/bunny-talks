"""Synthetic inventories exercise local verification, without simulating an Apple build."""
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
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

    def test_refuse_manifest_inventory_and_archive_mismatches(self):
        files = fixture()
        key = "libopenssl.xcframework/ios-arm64/libopenssl.a"
        files[key] = b"bad archive"
        with self.assertRaisesRegex(verification.VerificationError, "file SHA-256 mismatch"):
            verification.verify(files)
        manifest = json.loads(files["manifest.json"])
        manifest["sha256"][key] = verification.sha256(files[key])
        files["manifest.json"] = json.dumps(manifest).encode()
        with self.assertRaisesRegex(verification.VerificationError, "missing archive"):
            verification.verify(files)
        del files[key]
        with self.assertRaisesRegex(verification.VerificationError, "inventory mismatch"):
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
                verification.files_from_archive(verification.read_zip(archive))
            with self.assertRaisesRegex(verification.VerificationError, "unexpected XCFramework file"):
                source = verification.read_zip(archive)
                verification.files_from_archive(source, verification.sha256(source))

    def test_install_refuses_missing_and_altered_zip_before_creating_vendor(self):
        with tempfile.TemporaryDirectory() as root:
            local_script = Path(root) / script.name
            shutil.copyfile(script, local_script)
            archive = Path(root) / "source.zip"
            command = [sys.executable, "-I", local_script, "install", archive]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("ZIP is missing", result.stderr)
            archive.write_bytes(b"altered")
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("SHA-256 mismatch", result.stderr)
            self.assertFalse((Path(root) / "vendor").exists())

    def test_install_zip_preserves_existing_paths_and_refuses_symlinks(self):
        with tempfile.TemporaryDirectory() as root:
            vendor = Path(root) / "vendor"
            target = Path(root) / "outside"
            target.mkdir()
            vendor.symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(verification.VerificationError, "vendor directory"):
                verification.install_zip(vendor, b"fixture")
            self.assertEqual(list(target.iterdir()), [])
            vendor.unlink()
            vendor.mkdir()
            archive = vendor / "xcframeworks.zip"
            archive.symlink_to(target / "missing")
            with self.assertRaisesRegex(verification.VerificationError, "ZIP is missing"):
                verification.install_zip(vendor, b"fixture")
            self.assertTrue(archive.is_symlink())
            archive.unlink()
            archive.write_bytes(b"existing")
            with self.assertRaisesRegex(verification.VerificationError, "existing XCFramework ZIP differs"):
                verification.install_zip(vendor, b"fixture")
            self.assertEqual(archive.read_bytes(), b"existing")

    @unittest.skipUnless(os.environ.get("BUNNY_IOS_XCFRAMEWORK_ZIP"), "approved ZIP not supplied")
    def test_approved_zip_installs_then_stages_and_verifies(self):
        approved = Path(os.environ["BUNNY_IOS_XCFRAMEWORK_ZIP"]).absolute()
        with tempfile.TemporaryDirectory() as root:
            local_script = Path(root) / script.name
            shutil.copyfile(script, local_script)
            installed = Path(root) / "vendor/xcframeworks.zip"
            package = installed.parent / "package"
            command = [sys.executable, "-I", local_script]
            report = subprocess.check_output([*command, "install", approved], text=True)
            self.assertEqual(len(json.loads(report)["archives"]), 4)
            self.assertEqual(installed.read_bytes(), approved.read_bytes())
            original_inode = installed.stat().st_ino
            subprocess.check_output([*command, "install", installed])
            self.assertEqual(installed.stat().st_ino, original_inode)
            subprocess.check_output([*command, "stage", installed, package])
            subprocess.check_output([*command, "verify", installed, package])
            self.assertTrue((package / "curl-COPYING").read_bytes())
            self.assertTrue((package / "openssl-LICENSE.txt").read_bytes())
            altered = Path(root) / "altered.zip"
            data = bytearray(installed.read_bytes())
            data[-1] ^= 1
            altered.write_bytes(data)
            result = subprocess.run([*command, "install", altered], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("SHA-256 mismatch", result.stderr)
            self.assertEqual(installed.stat().st_ino, original_inode)


if __name__ == "__main__":
    unittest.main()
