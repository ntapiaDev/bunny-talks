"""Exercise portable evidence checks without running Apple tools."""

import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


script = Path(__file__).resolve().parents[1] / "scripts/inspect-ios-standard.py"
spec = importlib.util.spec_from_file_location("inspection", script)
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)


class StandardInspectionTest(unittest.TestCase):
    def test_refuses_qualification_flags_and_plain_sqlite(self):
        https = {"CONFIGURATION": "Release", "GCC_PREPROCESSOR_DEFINITIONS": "CURL_STATICLIB=1"}
        sqlite = {"CONFIGURATION": "Release", "OTHER_CFLAGS": "-DSQLITE_HAS_CODEC=1 -DSQLCIPHER_CRYPTO_CC"}
        settings = [
            {"target": "ApplicationHttps", "buildSettings": https},
            {"target": "ExpoSQLite", "buildSettings": sqlite},
        ]
        inspection.check_pod_settings(settings)
        https["OTHER_SWIFT_FLAGS"] = "-D BUNNY_HTTPS_QUALIFICATION"
        with self.assertRaisesRegex(inspection.CheckFailed, "qualification-flags"):
            inspection.check_pod_settings(settings)
        del https["OTHER_SWIFT_FLAGS"]
        sqlite["OTHER_CFLAGS"] = ""
        with self.assertRaisesRegex(inspection.CheckFailed, "sqlcipher-flags"):
            inspection.check_pod_settings(settings)

    def test_refuses_qualification_bundle_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            source_map = Path(directory) / "bundle.map"
            sources = ["apps/mobile/index.ts", "apps/mobile/src/composition/App.tsx"]
            source_map.write_text(json.dumps({"sources": sources}))
            inspection.check_bundle_sources(source_map)
            sources.append("apps/mobile/qualification/ios-libcurl-runtime-entry.tsx")
            source_map.write_text(json.dumps({"sources": sources}))
            with self.assertRaisesRegex(inspection.CheckFailed, "qualification-js-entry"):
                inspection.check_bundle_sources(source_map)

    def test_refuses_qualification_resources_markers_and_ats_exceptions(self):
        inspection.check_ats({"NSAppTransportSecurity": {"NSAllowsArbitraryLoads": False}})
        with self.assertRaisesRegex(inspection.CheckFailed, "ats"):
            inspection.check_ats({"NSAppTransportSecurity": {"NSAllowsArbitraryLoads": True}})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / "BunnyTalks"
            app.write_bytes(b"standard content")
            inspection.check_resources(root)
            app.write_bytes(b"qualificationCompletion")
            with self.assertRaisesRegex(inspection.CheckFailed, "qualification-marker"):
                inspection.check_resources(root)
            app.write_bytes(b"-----BEGIN CERTIFICATE-----\n" + b"A" * 32)
            with self.assertRaisesRegex(inspection.CheckFailed, "certificate-or-key-payload"):
                inspection.check_resources(root)
            app.unlink()
            (root / "ca.cer").touch()
            with self.assertRaisesRegex(inspection.CheckFailed, "certificate-resource"):
                inspection.check_resources(root)

    def test_checks_bytes_of_the_archives_named_by_linker(self):
        with tempfile.TemporaryDirectory() as directory:
            archives = {}
            rows = []

            def digest(path):
                return hashlib.sha256(path.read_bytes()).hexdigest()

            for index, library in enumerate(("libcurl", "libopenssl"), start=1):
                archive = Path(directory) / f"{library}.a"
                archive.write_bytes(f"fixture-{library}".encode())
                archives[f"{library}.xcframework/ios-arm64-simulator/{archive.name}"] = digest(archive)
                rows.append(f"[  {index}] {archive}(sample.o)\n")
            raw_map = "".join(rows).encode()
            self.assertEqual(len(inspection.check_linked_archives(raw_map, archives, digest)), 2)
            archive.write_bytes(b"unexpected archive")
            with self.assertRaisesRegex(inspection.CheckFailed, "linked-archive-sha256"):
                inspection.check_linked_archives(raw_map, archives, digest)
            with self.assertRaisesRegex(inspection.CheckFailed, "linked-archive-path"):
                inspection.check_linked_archives(rows[0].encode(), archives, digest)


if __name__ == "__main__":
    unittest.main()
