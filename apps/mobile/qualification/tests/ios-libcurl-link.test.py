"""Offline tests of Xcode evidence formats, without running the Apple tools."""

import importlib.util
from pathlib import Path
import unittest

source = Path(__file__).resolve().parents[1] / "inspect-ios-libcurl-runtime.py"
spec = importlib.util.spec_from_file_location("inspect_link", source)
link = importlib.util.module_from_spec(spec)
spec.loader.exec_module(link)


class LinkEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.nm = """1000 (__TEXT,__text) non-external (was a private external) _curl_multi_perform
1010 (__TEXT,__text) non-external _curl_version_info
1020 (__TEXT,__text) external _OPENSSL_init_ssl"""
        self.mapping = b"""# Path: /private/build/Release-iphonesimulator/Fixture.app/Fixture
# Arch: arm64
# Object files:
[  0] linker synthesized
[  1] /private/input/libcurl.a(libcurl_la-multi.o)
[  2] /private/input/libcurl.a(libcurl_la-version.o)
[  3] /private/input/libopenssl.a(libssl-lib-ssl_init.o)
# Sections:
# Address\tSize    \tSegment\tSection
0x1000\t0x20\t__TEXT\t__text
# Symbols:
# Address\tSize    \tFile  Name
0x1000 0x10 [  1] _curl_multi_perform
0x1010 0x10 [  2] _curl_version_info
0x1020 0x10 [  3] _OPENSSL_init_ssl
# Dead Stripped Symbols:
#        \tSize    \tFile  Name
<<dead>> 0x4 [  1] _curl_multi_perform
"""

    def map_for_fixture(self):
        return link.inspect_map(self.mapping, "Fixture.app", "Fixture")

    def test_local_and_external_correlate_without_raw_paths(self):
        definitions = link.inspect_definitions(self.nm)
        self.assertEqual(definitions["_curl_multi_perform"][0]["visibility"], "local")
        self.assertEqual(definitions["_OPENSSL_init_ssl"][0]["visibility"], "external")
        mapping = self.map_for_fixture()
        self.assertTrue(link.link_matches(definitions, mapping))
        self.assertNotIn("/private", str(mapping))
        self.assertEqual(mapping["deadStrippedSymbols"]["_curl_multi_perform"][0]["size"], 4)

    def test_weak_missing_duplicate_and_indeterminate_definitions_fail(self):
        for output in [
            self.nm.replace("external _OPENSSL_init_ssl", "weak external _OPENSSL_init_ssl"),
            self.nm.rsplit("\n", 1)[0],
            self.nm + "\n1090 (__TEXT,__text) external _OPENSSL_init_ssl",
            self.nm.replace("external _OPENSSL_init_ssl", "unknown _OPENSSL_init_ssl"),
        ]:
            with self.subTest(output=output):
                self.assertFalse(link.link_matches(link.inspect_definitions(output), self.map_for_fixture()))
        weak = link.inspect_definitions(
            self.nm.replace("external _OPENSSL_init_ssl", "weak external _OPENSSL_init_ssl")
        )
        self.assertTrue(weak["_OPENSSL_init_ssl"][0]["weak"])

    def test_requires_matching_map_target_architecture_address_and_object(self):
        for other in [
            self.mapping.replace(b"Fixture.app", b"Other.app"),
            self.mapping.replace(b"arm64", b"x86_64"),
            self.mapping.replace(b"[  3] _OPENSSL_init_ssl", b"[  9] _OPENSSL_init_ssl"),
        ]:
            with self.subTest(other=other), self.assertRaises(ValueError):
                link.inspect_map(other, "Fixture.app", "Fixture")
        for other in [
            self.mapping.replace(b"0x1020", b"0x2020"),
            self.mapping.replace(b"libssl-lib-ssl_init.o", b"another.o"),
            self.mapping.replace(b"# Dead Stripped Symbols:", b"0x1000 0x10 [  1] _curl_multi_perform\n# Dead Stripped Symbols:"),
        ]:
            with self.subTest(other=other):
                mapping = link.inspect_map(other, "Fixture.app", "Fixture")
                self.assertFalse(link.link_matches(link.inspect_definitions(self.nm), mapping))

    def test_reports_fixed_reasons_for_malformed_map(self):
        for before, after, reason in [
            ("# Path: ", "# Path: duplicate\n# Path: ", "duplicate-path"),
            ("# Arch: arm64", "# Arch: x86_64", "architecture"),
            ("# Arch: arm64", "# Arch: arm64\n# Arch: arm64", "duplicate-architecture"),
            ("Release-iphonesimulator", "Debug-iphonesimulator", "executable-path"),
            ("# Sections:", "# Unrecognized: ", "unknown-header"),
            ("# Dead Stripped Symbols:", "# Symbols:", "section-order"),
            ("[  2] /private", "[  1] /private", "duplicate-object"),
            ("[  0] linker synthesized", "[  0] /other/libcurl.a(libcurl_la-version.o)", "ambiguous-object"),
            ("[  2] /private", "invalid /private", "object-record"),
            ("libcurl.a(libcurl_la-version.o)", "libcurl.a(libcurl$unsafe.o)", "object-label"),
            ("0x1000 0x10 [  1]", "0x1000 bad-size [  1]", "symbol-size"),
            ("0x1000 0x10 [  1]", "bad-address 0x10 [  1]", "symbol-address"),
            ("0x1000 0x10 [  1]", "0x1000 0x10 malformed", "symbol-record"),
            ("[  3] _OPENSSL_init_ssl", "[  9] _OPENSSL_init_ssl", "unknown-symbol-object"),
            ("<<dead>>", "0x100a", "symbol-address"),
        ]:
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(link.LinkMapError, f"^link-map-{reason}$"):
                    link.inspect_map(self.mapping.replace(before.encode(), after.encode()), "Fixture.app", "Fixture")

    def test_opaque_non_target_names_are_accepted_and_never_reported(self):
        mapped = self.mapping.replace(b"# Sections:", b"[  4] /private/opaque-\xff.o\n# Sections:")
        mapped = mapped.replace(
            b"# Dead Stripped Symbols:",
            b"0x1030 0x10 [  4] literal string: \xff _curl_multi_perform\n# Dead Stripped Symbols:",
        )
        mapped += b"<<dead>> 0x4 [  4] _unrelated_\xfe\n"
        mapping = link.inspect_map(mapped, "Fixture.app", "Fixture")
        self.assertEqual(mapping, self.map_for_fixture())
        self.assertTrue(link.link_matches(link.inspect_definitions(self.nm), mapping))

    def test_invalid_bytes_cannot_hide_critical_records(self):
        for before, after, reason in [
            (b"ssl_init.o", b"ssl_\xffinit.o", "object-label"),
            (b"/private/input/libopenssl", b"/private/\xff/libopenssl", "object-label"),
            (b"[  2] /private", b"[  \xff2] /private", "object-record"),
            (b"[  2] /private", b"[  01] /private", "object-record"),
            (b"0x1010 0x10", b"0x10\xff0 0x10", "symbol-address"),
            (b"0x1010 0x10", b"0x1010 0x\xff0", "symbol-size"),
            (b"[  2] _curl", b"[  \xff2] _curl", "symbol-record"),
            (b"# Arch: arm64", b"# Arch: arm64\xff", "architecture"),
            (b"# Sym", b"# Sy\xffm", "unknown-header"),
            (b"\tSegment", b"\tSeg\xffment", "unknown-header"),
            (b"/private/build", b"/private/\xff/build", "executable-path"),
            (b"_curl_version_info", b"_curl_\xffversion_info", "symbol-name"),
            (b"<<dead>> 0x4 [  1] _curl_multi_perform",
             b"<<dead>> 0x4 [  1] _curl_multi_perform\xff", "symbol-name"),
        ]:
            with self.subTest(reason=reason), self.assertRaisesRegex(link.LinkMapError, f"^link-map-{reason}$"):
                link.inspect_map(self.mapping.replace(before, after), "Fixture.app", "Fixture")

    def test_does_not_count_dead_definitions_as_live_provenance(self):
        before = self.mapping.split(b"# Symbols:")[0]
        dead_only = before + b"# Symbols:\n# Dead Stripped Symbols:\n<<dead>> 0x4 [  1] _curl_multi_perform\n"
        with self.assertRaisesRegex(link.LinkMapError, "^link-map-missing-live-symbols$"):
            link.inspect_map(dead_only, "Fixture.app", "Fixture")


if __name__ == "__main__":
    unittest.main()
