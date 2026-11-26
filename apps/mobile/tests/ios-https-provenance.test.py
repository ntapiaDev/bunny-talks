"""Regression checks for the active reviewed-source provenance helpers."""

import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

PROVENANCE_PATH = Path(__file__).resolve().parents[1] / "scripts/ios-https-provenance.py"
spec = importlib.util.spec_from_file_location("ios_https_provenance", PROVENANCE_PATH)
provenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provenance)


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def make_tar(path, members):
    with tarfile.open(path, "w:gz") as archive:
        for name, kind, data in members:
            member = tarfile.TarInfo(name)
            if kind == "file":
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            else:
                member.type = kind
                archive.addfile(member)


class ProvenanceTests(unittest.TestCase):
    def test_reviewed_revision_and_tree_hash_are_exact(self):
        approved = "a" * 40
        provenance.validate_revision(approved, approved, require)
        for candidate in ("b" * 40, "a" * 39, "A" * 40, "a" * 40 + "0"):
            with self.subTest(candidate=candidate), self.assertRaisesRegex(ValueError, "reviewed-sha-mismatch"):
                provenance.validate_revision(candidate, approved, require)
        entries = {"source.ts": ["d" * 64, 0o644]}
        self.assertEqual(provenance.tree_digest(entries), provenance.tree_digest(entries))
        self.assertNotEqual(provenance.tree_digest(entries), provenance.tree_digest({}))

    def test_forbidden_environment_names_are_rejected(self):
        for name in ("HTTPS_PROXY", "SSLKEYLOGFILE", "EXPO_PUBLIC_API", "DYLD_INSERT_LIBRARIES",
                     "SIMCTL_CHILD_PATH"):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "environment-overrides"):
                provenance.check_active_environment({name: "fixture"}, require)
        provenance.check_active_environment({"PATH": "/usr/bin", "LANG": "C"}, require)

    def test_tar_extraction_rejects_non_files_traversal_duplicates_and_size_limits(self):
        invalid = (
            [("repo/", tarfile.DIRTYPE, b""), ("repo/link", tarfile.SYMTYPE, b"target")],
            [("repo/", tarfile.DIRTYPE, b""), ("repo/../escape", "file", b"x")],
            [("repo/", tarfile.DIRTYPE, b""), ("repo/a", "file", b"x"), ("repo/a", "file", b"y")],
        )
        for members in invalid:
            with self.subTest(members=members), tempfile.TemporaryDirectory(dir="/tmp") as temporary:
                root = Path(temporary)
                archive = root / "source.tar.gz"
                make_tar(archive, members)
                destination = root / "out"
                with self.assertRaisesRegex(ValueError, "source-archive-invalid"):
                    provenance.export_source(archive, destination, require=require)

        class OversizedArchive:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def getmembers(self):
                directory = tarfile.TarInfo("repo/")
                directory.type = tarfile.DIRTYPE
                oversized = tarfile.TarInfo("repo/large")
                oversized.size = 100_000_001
                return [directory, oversized]

            def extractfile(self, _member):
                raise AssertionError("oversized archive member must be rejected before extraction")

        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            archive, destination = root / "source.tar.gz", root / "out"
            archive.touch()
            with patch.object(provenance.tarfile, "open", return_value=OversizedArchive()):
                with self.assertRaisesRegex(ValueError, "source-archive-invalid"):
                    provenance.export_source(archive, destination, require=require)

    def test_manifest_and_checkout_inventory_preserve_hashes_modes_and_detect_drift(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            (root / "script.sh").write_text("#!/bin/sh\n")
            (root / "script.sh").chmod(0o755)
            (root / "source.ts").write_text("export {};\n")
            digest = lambda path: __import__("hashlib").sha256(path.read_bytes()).hexdigest()
            entries = provenance.manifest(root, digest=digest, require=require, excluded=set())
            self.assertEqual(entries["script.sh"][1], 0o755)
            self.assertEqual(provenance.checkout_inventory(root, digest=digest, require=require), entries)
            (root / "source.ts").write_text("changed\n")
            self.assertNotEqual(provenance.checkout_inventory(root, digest=digest, require=require), entries)
            (root / "extra.txt").write_text("extra\n")
            self.assertNotEqual(provenance.checkout_inventory(root, digest=digest, require=require), entries)
            with self.assertRaisesRegex(ValueError, "unexpected-source-entry"):
                (root / ".env.local").write_text("fixture\n")
                provenance.manifest(root, digest=digest, require=require, excluded=set())

    def test_github_token_is_forwarded_only_for_the_explicit_archive_command(self):
        class Runtime:
            class Interrupted(Exception):
                pass

            class StageError(Exception):
                pass

            @staticmethod
            def run_command(args, **kwargs):
                calls.append((args, kwargs["env"]))
                return Mock(exit_code=0, output="")

        class Qualification(provenance.HostedQualification):
            def steps(self):
                return ()

        calls = []
        env = {"HOME": "/tmp", "PATH": "/usr/bin", "GH_TOKEN": "fixture-token"}
        qualification = Qualification(
            Path("/tmp/report.json"), env, runtime=Runtime, require=require,
            manifest_fn=Mock(), tree_digest_fn=Mock(), environment_check=lambda _env: None,
        )
        qualification.scratch = Path("/tmp")
        qualification.command(("pnpm", "--version"))
        qualification.command(("gh", "api", "repos/ntapiaDev/bunny-talks/tarball/" + "a" * 40), github=True)
        self.assertNotIn("GH_TOKEN", calls[0][1])
        self.assertEqual(calls[1][0][:2], ("gh", "api"))
        self.assertEqual(calls[1][1]["GH_TOKEN"], "fixture-token")

    def test_interruption_preserves_verdict_and_runs_cleanup(self):
        class Runtime:
            class Interrupted(Exception):
                pass

            class StageError(Exception):
                def __init__(self, code):
                    self.record = {"verdict": "FAIL", "code": code}

            @staticmethod
            def run_command(*_args, **_kwargs):
                return Mock(exit_code=0, output="")

        class Qualification(provenance.HostedQualification):
            def steps(self):
                return (("work", self.interrupt),)

            def interrupt(self):
                raise Runtime.Interrupted()

            def cleanup(self):
                return {"scratchRemoved": "PASS"}

        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            report = Path(temporary) / "report.json"
            qualification = Qualification(
                report, {}, runtime=Runtime, require=require,
                manifest_fn=Mock(), tree_digest_fn=Mock(), environment_check=lambda _env: None,
            )
            qualification.cleanup = Mock(return_value={"scratchRemoved": "PASS"})
            with patch.object(provenance.signal, "alarm"):
                self.assertEqual(qualification.run(), 1)
            self.assertEqual(qualification.report["verdict"], "NOT_RUN")
            self.assertTrue(qualification.report["complete"] is False)
            self.assertEqual(qualification.report["stages"]["cleanup"]["verdict"], "PASS")
            qualification.cleanup.assert_called_once()


if __name__ == "__main__":
    unittest.main()
