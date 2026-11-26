"""Exercise active iOS Release checks with synthetic evidence."""

import importlib.util
import json
import plistlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


script = Path(__file__).resolve().parents[1] / "scripts/inspect-ios-standard.py"
spec = importlib.util.spec_from_file_location("inspection", script)
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)


class StandardInspectionTest(unittest.TestCase):
    def test_urlsession_release_checks_macho_hermes_ats_and_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            derived = root / "DerivedData"
            app = derived / "Build/Products/Release-iphonesimulator/BunnyTalks.app"
            app.mkdir(parents=True)
            (app / "Info.plist").write_bytes(plistlib.dumps({
                "CFBundleIdentifier": inspection.BUNDLE_ID,
                "CFBundleDisplayName": "Bunny Talks",
                "MinimumOSVersion": "16.4",
                "NSAppTransportSecurity": {"NSAllowsArbitraryLoads": False},
                "CFBundleExecutable": "BunnyTalks",
            }))
            (app / "BunnyTalks").write_bytes(b"synthetic executable")
            (app / "main.jsbundle").write_bytes(bytes.fromhex("c61fbc03c103191f") + b"synthetic")
            link_map = derived / "BunnyTalks-LinkMap-arm64.txt"
            link_map.write_bytes(b"UrlSessionHttpsTransport.o\n")
            mobile = root / "mobile"
            (mobile / "ios").mkdir(parents=True)
            (mobile / "ios/Podfile.lock").write_text(
                "  - ApplicationHttps\n  - ExpoSQLite\n  - ExpoSecureStore\n  - hermes-engine\n"
            )
            settings = root / "pods.json"
            settings.write_text(json.dumps([
                {"target": "ApplicationHttps", "buildSettings": {"CONFIGURATION": "Release"}},
                {"target": "ExpoSQLite", "buildSettings": {
                    "CONFIGURATION": "Release",
                    "OTHER_CFLAGS": "-DSQLITE_HAS_CODEC=1 -DSQLCIPHER_CRYPTO_CC",
                }},
            ]))
            source_map = root / "bundle.json"
            source_map.write_text(json.dumps({"sources": [
                "apps/mobile/index.ts", "apps/mobile/src/product/App.tsx",
            ]}))

            def fake_command(*args):
                if args[1] == "lipo":
                    return "arm64"
                if args[1] == "vtool":
                    return "platform IOSSIMULATOR\nminos 16.4"
                if args[1] == "otool":
                    return "/System/Library/Frameworks/Foundation.framework/Foundation"
                return ""

            with patch.object(inspection, "command", side_effect=fake_command):
                result = inspection.inspect_release(derived, source_map, settings, mobile=mobile)
            self.assertEqual(result["verdict"], "PASS")
            self.assertEqual(result["transport"], "urlsession")

    def test_refuses_qualification_flags_and_plain_sqlite(self):
        https = {"CONFIGURATION": "Release", "GCC_PREPROCESSOR_DEFINITIONS": "CURL_STATICLIB=1"}
        sqlite = {"CONFIGURATION": "Release", "OTHER_CFLAGS": "-DSQLITE_HAS_CODEC=1 -DSQLCIPHER_CRYPTO_CC"}
        settings = [
            {"target": "ApplicationHttps", "buildSettings": https},
            {"target": "ExpoSQLite", "buildSettings": sqlite},
        ]
        with self.assertRaisesRegex(inspection.CheckFailed, "standard-transport-flags"):
            inspection.check_pod_settings(settings)
        https["GCC_PREPROCESSOR_DEFINITIONS"] = ""
        for setting in ("OTHER_SWIFT_FLAGS", "OTHER_CFLAGS", "SWIFT_ACTIVE_COMPILATION_CONDITIONS"):
            with self.subTest(setting=setting):
                https[setting] = "-D BUNNY_HTTPS_QUALIFICATION"
                with self.assertRaisesRegex(inspection.CheckFailed, "qualification-flags"):
                    inspection.check_pod_settings(settings)
                del https[setting]
        sqlite["OTHER_CFLAGS"] = ""
        with self.assertRaisesRegex(inspection.CheckFailed, "sqlcipher-flags"):
            inspection.check_pod_settings(settings)

    def test_refuses_qualification_bundle_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            source_map = Path(directory) / "bundle.map"
            sources = ["apps/mobile/index.ts", "apps/mobile/src/product/App.tsx"]
            source_map.write_text(json.dumps({"sources": sources}))
            inspection.check_bundle_sources(source_map)
            sources.append("apps/mobile/qualification/standard-json-entry.tsx")
            source_map.write_text(json.dumps({"sources": sources}))
            with self.assertRaisesRegex(inspection.CheckFailed, "qualification-js-entry"):
                inspection.check_bundle_sources(source_map)

    def test_refuses_crypto_qualification_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            source_map = Path(directory) / "bundle.map"
            for marker in (
                "node_modules/@open-e2ee/signal-protocol-sdk/client.js",
                "packages/crypto/backup/tests/fixtures/account-vault-v1.json",
            ):
                with self.subTest(marker=marker):
                    source_map.write_text(json.dumps({"sources": [
                        "apps/mobile/index.ts", "apps/mobile/src/product/App.tsx", marker,
                    ]}))
                    with self.assertRaisesRegex(inspection.CheckFailed, "crypto-qualification-js-entry"):
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
            app.write_bytes(b"-----BEGIN CERTIFICATE-----\\n" + b"A" * 32)
            with self.assertRaisesRegex(inspection.CheckFailed, "certificate-or-key-payload"):
                inspection.check_resources(root)
            app.unlink()
            (root / "ca.cer").touch()
            with self.assertRaisesRegex(inspection.CheckFailed, "certificate-resource"):
                inspection.check_resources(root)


if __name__ == "__main__":
    unittest.main()
