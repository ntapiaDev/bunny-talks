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
            sources = ["apps/mobile/index.ts", "apps/mobile/src/composition/App.tsx"]
            source_map.write_text(json.dumps({"sources": sources}))
            inspection.check_bundle_sources(source_map)
            sources.append("apps/mobile/qualification/ios-libcurl-runtime-entry.tsx")
            source_map.write_text(json.dumps({"sources": sources}))
            with self.assertRaisesRegex(inspection.CheckFailed, "qualification-js-entry"):
                inspection.check_bundle_sources(source_map)

    def test_candidate_bundle_requires_only_the_reviewed_fixture_imports(self):
        with tempfile.TemporaryDirectory() as directory:
            source_map = Path(directory) / "bundle.map"
            files = [inspection.CANDIDATE_ENTRY, "apps/mobile/qualification/ios-libcurl-scenarios.ts"]
            source_map.write_text(json.dumps({"sources": files}))
            inspection.check_bundle_sources(source_map, candidate=True)
            for extra in ("qualification/ios-libcurl-diagnostics.ts", "src/composition/App.tsx"):
                with self.subTest(extra=extra):
                    source_map.write_text(json.dumps({"sources": [*files, extra]}))
                    with self.assertRaises(inspection.CheckFailed):
                        inspection.check_bundle_sources(source_map, candidate=True)

    def test_c2_link_selection_has_no_paths_and_requires_all_three_providers(self):
        raw = (b"[  1] /root/slice/libcurl.a(connect.o)\n"
               b"[  2] /root/slice/libopenssl.a(ssl.o)\n"
               b"[  3] /root/products/libApplicationHttps.a(BunnyHttpsNative.o)\n")
        convert = lambda value: value.decode("ascii")
        selected = inspection.transport_link_selection(raw, convert)
        self.assertEqual(len(selected), 3)
        self.assertIn(("libApplicationHttps.a", "BunnyHttpsNative.o"), selected)
        self.assertNotIn("/root", str(selected))
        with self.assertRaises(inspection.EvidenceUnavailable):
            inspection.transport_link_selection(raw.splitlines()[0], convert)

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

    def test_checks_normal_curl_options_and_refuses_alternate_trust(self):
        native = inspection.MOBILE / "modules/application-https/ios/Native/BunnyHttpsNative.c"
        source = native.read_text()
        inspection.check_curl_options(source)
        for original, replacement in (
            ("CURLOPT_SSL_VERIFYPEER, 1L", "CURLOPT_SSL_VERIFYPEER, 0L"),
            ("CURLOPT_SSL_VERIFYHOST, 2L", "CURLOPT_SSL_VERIFYHOST, 0L"),
            ("(long)CURLSSLOPT_NATIVE_CA", "0L"),
            ('CURLOPT_PROTOCOLS_STR, "https"', 'CURLOPT_PROTOCOLS_STR, "http,https"'),
            ("CURLOPT_FOLLOWLOCATION, 0L", "CURLOPT_FOLLOWLOCATION, 1L"),
        ):
            with self.subTest(option=original):
                self.assertIn(original, source)
                with self.assertRaisesRegex(inspection.CheckFailed, "native-curl-options"):
                    inspection.check_curl_options(source.replace(original, replacement))
        with self.assertRaisesRegex(inspection.CheckFailed, "native-curl-options"):
            inspection.check_curl_options(source + "\ncurl_easy_setopt(easy, CURLOPT_SSL_VERIFYHOST, 0L);")
        for option in ("CURLOPT_CAINFO", "CURLOPT_CAPATH", "CURLOPT_CAINFO_BLOB", "CURLOPT_SSL_CTX_FUNCTION"):
            with self.subTest(option=option):
                with self.assertRaisesRegex(inspection.CheckFailed, "native-alternative-trust"):
                    inspection.check_curl_options(source + f"\nSET({option}, value);")

    def test_refuses_certificate_material_in_standard_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            mobile = Path(directory)
            native = mobile / "modules/application-https/ios/Native"
            native.mkdir(parents=True)
            (mobile / "src").mkdir()
            (mobile / "assets").mkdir()
            for name in ("index.ts", "app.json", "package.json", "metro.config.js"):
                (mobile / name).touch()
            real_native = inspection.MOBILE / "modules/application-https/ios/Native/BunnyHttpsNative.c"
            (native / real_native.name).write_bytes(real_native.read_bytes())
            inspection.check_https_sources(mobile)
            certificate = mobile / "assets/fixture.DER"
            certificate.touch()
            with self.assertRaisesRegex(inspection.CheckFailed, "certificate-resource"):
                inspection.check_https_sources(mobile)
            certificate.unlink()
            (mobile / "src/inline.ts").write_bytes(b"-----BEGIN CERTIFICATE-----\\n" + b"A" * 32)
            with self.assertRaisesRegex(inspection.CheckFailed, "certificate-or-key-payload"):
                inspection.check_https_sources(mobile)

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
