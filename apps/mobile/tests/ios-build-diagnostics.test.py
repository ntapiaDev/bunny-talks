"""Exercise the diagnostic report with synthetic Xcode output."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from textwrap import dedent
import unittest
from unittest.mock import patch


script = Path(__file__).resolve().parents[1] / "scripts/collect-ios-build-diagnostics.py"
spec = importlib.util.spec_from_file_location("collector", script)
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
repository = script.parents[3]
workflow = (repository / ".github/workflows/ios-standard-release.yml").read_text()
fixtures = Path(__file__).parent / "fixtures/ios-build-diagnostics"


def run_workflow_shell(name, env):
    step = workflow.split(f"      - name: {name}\n", 1)[1].split("\n      - name: ", 1)[0]
    shell = dedent(step.split("\n        run: |\n", 1)[1])
    return subprocess.run(
        ["bash", "-eo", "pipefail", "-c", shell], cwd=repository, env=env, capture_output=True, text=True,
    )


class BuildDiagnosticsTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.log = self.root / "xcodebuild.log"
        self.exit_code = self.root / "xcodebuild.exit"
        self.exit_code.write_text("65\n")

    def collect(self, outcome="failure"):
        return collector.collect(self.root, outcome)

    def test_success_does_not_publish_errors_or_read_result(self):
        self.exit_code.write_text("0\n")
        self.log.write_text("error: no such module 'BunnyHttpsNative'\n")
        with patch.object(collector, "read_structured") as structured:
            report = self.collect("success")
        structured.assert_not_called()
        self.assertEqual(report["verdict"], "NOT_RUN")
        self.assertEqual(report["reason"], "build-succeeded")
        self.assertEqual(report["xcodeExitCode"], 0)
        self.assertEqual(report["diagnostics"], [])

    def test_swift_error_uses_apple_json_and_keeps_the_nonzero_exit(self):
        bundle = self.root / "build.xcresult"
        bundle.mkdir()
        result = {"errors": [{
            "issueType": "Swift Compiler Error", "targetName": "ApplicationHttps",
            "sourceURL": "file:///private/work/CurlHttpsTransport.swift#StartingLineNumber=12",
            "message": "No such module 'BunnyHttpsNative'",
        }]}

        with patch.object(collector, "read_structured", return_value=result):
            report = self.collect()
        self.assertEqual(report["sources"], ["xcresult"])
        self.assertEqual(report["xcresultStatus"], "recognized-errors")
        self.assertEqual(report["quality"], "technical-error")
        self.assertEqual(report["verdict"], "PASS")
        self.assertEqual(report["xcodeExitCode"], 65)
        self.assertEqual(report["diagnostics"], [{
            "code": "module-not-found", "category": "compilation", "message": "Swift module not found",
            "target": "ApplicationHttps", "file": "CurlHttpsTransport.swift", "line": 12,
            "component": "BunnyHttpsNative",
        }])

    def test_strict_xcresulttool_accepts_documented_command_and_sanitizes_json(self):
        bundle = self.root / "build.xcresult"
        bundle.mkdir()
        executable = self.root / "xcrun"
        executable.write_text(
            "#!/usr/bin/env python3\n"
            "import json, sys\n"
            "if len(sys.argv) != 6 or sys.argv[1:5] != "
            "['xcresulttool', 'get', 'build-results', '--path']:\n"
            "    sys.exit(2)\n"
            "print(json.dumps({'errors': ["
            "{'message': \"No such module 'BunnyHttpsNative'\", "
            "'sourceURL': 'file:///private/fixture-secret/CurlHttpsTransport.swift#StartingLineNumber=12'},"
            "{'message': \"No such module 'BunnyHttpsNative'\", "
            "'sourceURL': 'file:///private/fixture-secret/Private.swift#StartingLineNumber=99'}"
            "], 'warnings': [], 'private': 'fixture-secret'}))\n"
        )
        executable.chmod(0o700)
        env = dict(os.environ, PATH=f"{self.root}{os.pathsep}{os.environ['PATH']}")
        command = [str(executable), "xcresulttool", "get", "build-results", "--path", str(bundle)]
        self.assertEqual(subprocess.run(command, env=env, capture_output=True).returncode, 0)
        self.assertNotEqual(subprocess.run(command + ["--format", "json"], env=env, capture_output=True).returncode, 0)
        with patch.dict(os.environ, {"PATH": env["PATH"]}):
            report = self.collect()
        self.assertEqual(report["sources"], ["xcresult"])
        self.assertEqual(report["verdict"], "PASS")
        first, second = report["diagnostics"]
        self.assertEqual((first["file"], first["line"]), ("CurlHttpsTransport.swift", 12))
        self.assertNotIn("file", second)
        self.assertNotIn("line", second)
        self.assertNotIn("fixture-secret", json.dumps(report))
        self.assertNotIn("sourceURL", json.dumps(report))

    def test_c_error_uses_log_when_no_bundle_exists(self):
        self.log.write_text(
            "/private/work/BunnyHttpsNative.c:8:9: fatal error: 'curl/curl.h' file not found "
            "(in target 'ApplicationHttps' from project 'Pods')\n"
        )
        report = self.collect()
        self.assertEqual(report["sources"], ["log"])
        diagnostic = report["diagnostics"][0]
        self.assertEqual(diagnostic["file"], "BunnyHttpsNative.c")
        self.assertEqual(diagnostic["component"], "curl/curl.h")
        self.assertEqual(diagnostic["target"], "ApplicationHttps")
        self.assertEqual(diagnostic["code"], "header-not-found")

    def test_linker_symbol_and_failed_command_target(self):
        self.log.write_text(
            'Undefined symbols for architecture arm64:\n'
            '  "_curl_multi_perform", referenced from:\n'
            '      _example in fixture.o\n'
            'ld: symbol(s) not found for architecture arm64\n'
            'The following build commands failed:\n'
            "   Ld /private/fixture normal arm64 (in target 'BunnyTalks' from project 'BunnyTalks')\n"
            '(1 failure)\n'
        )
        diagnostics = self.collect()["diagnostics"]
        self.assertTrue(all(row["category"] == "linkage" for row in diagnostics))
        self.assertIn("_curl_multi_perform", [row.get("component") for row in diagnostics])
        self.assertIn("BunnyTalks", [row.get("target") for row in diagnostics])

    def test_incomplete_and_unreadable_structured_results_fall_back(self):
        self.log.write_text("xcodebuild: error: Unable to find a destination matching the scheme\n")
        bundle = self.root / "build.xcresult"
        self.assertEqual(self.collect()["xcresultStatus"], "bundle-absent")
        bundle.mkdir()
        for result, status in ((None, "invalid-output"), ({"warnings": []}, "invalid-output"),
                               ({"errors": [{"message": "unrecognized text"}]}, "no-recognized-error")):
            with self.subTest(result=result), patch.object(collector, "read_structured", return_value=result):
                report = self.collect()
                self.assertEqual(report["xcresultStatus"], status)
                self.assertEqual(report["logUsage"], "fallback")
                self.assertEqual(report["diagnostics"][0]["category"], "configuration")
        for executable, status in (("exit 1", "invocation-failed"), ("echo '{broken'", "invalid-output"),
                                   ("exec sleep 2", "time-limit")):
            with self.fake_xcrun(executable), patch.object(collector, "XCRESULT_SECONDS", .2):
                report = self.collect()
                self.assertEqual(report["xcresultStatus"], status)
                self.assertEqual(report["sources"], ["log"])

    def fake_xcrun(self, script):
        executable = self.root / "xcrun"
        executable.write_text("#!/bin/sh\n" + script + "\n")
        executable.chmod(0o700)
        return patch.dict(os.environ, {"PATH": f"{self.root}{os.pathsep}{os.environ['PATH']}"})

    def test_bounds_message_length_and_published_count(self):
        with self.log.open("wb") as stream:
            stream.write(b"error: " + b"x" * collector.MAX_LINE + b" no space left on device\n")
            for line in range(1, 30):
                stream.write(f"/private/BunnyHttpsNative.c:{line}:1: error: expected expression\n".encode())
        report = self.collect()
        self.assertTrue(report["limitReached"])
        self.assertEqual(len(report["diagnostics"]), collector.MAX_DIAGNOSTICS)
        self.assertLess(len(json.dumps(report)), 8192)
        self.assertTrue(all(row["code"] == "syntax-error" for row in report["diagnostics"]))

    def test_oversized_structured_output_falls_back_to_the_log(self):
        (self.root / "build.xcresult").mkdir()
        self.log.write_text("BunnyHttpsNative.c:3: error: expected expression\n")
        with self.fake_xcrun("head -c 2097153 /dev/zero"):
            report = self.collect()
        self.assertEqual(report["xcresultStatus"], "byte-limit")
        self.assertTrue(report["limitReached"])
        self.assertEqual(report["sources"], ["log"])
        self.assertEqual(report["diagnostics"][0]["file"], "BunnyHttpsNative.c")

    def test_secrets_and_unexpected_operands_are_not_forwarded(self):
        fake_secret = "fixture-secret-0000"
        self.log.write_text(
            f"export EXPO_PUBLIC_TOKEN={fake_secret}\n"
            f"error: URL https://fixture.invalid/{fake_secret}\n"
            f"error: Cannot find '{fake_secret}' in scope (in target '{fake_secret}' from project 'Pods')\n"
            f"/private/{fake_secret}.swift:8:1: error: expected expression {fake_secret}\n"
            "error: \x1b[31mno space left on device\n"
        )
        structured = {"errors": [{"message": f"Duplicate symbol '{fake_secret}'",
                                  "sourceURL": f"file:///home/{fake_secret}.swift?token={fake_secret}"}]}
        (self.root / "build.xcresult").mkdir()
        with patch.object(collector, "read_structured", return_value=structured):
            report = self.collect()
        output = json.dumps(report)
        self.assertEqual(len(report["diagnostics"]), 3)
        for text in (fake_secret, "fixture.invalid", "/private", "EXPO_PUBLIC", "\\u001b"):
            self.assertNotIn(text, output)

    def test_unpublishable_result_stays_not_run(self):
        self.log.write_text("** BUILD FAILED **\nerror: unrecognized credential fixture-only\n")
        self.assertEqual(self.collect()["verdict"], "NOT_RUN")
        self.assertEqual(self.collect()["diagnostics"], [])
        self.assertEqual(self.collect()["quality"], "unknown")
        self.exit_code.write_text("65\nfixture-token")
        self.assertIsNone(self.collect()["xcodeExitCode"])

    def test_first_technical_error_in_phase_in_middle_of_large_log(self):
        filler = (b"x" * 1023 + b"\n") * 1100
        self.log.write_bytes(filler + (fixtures / "bundle-phase.txt").read_bytes() + filler)
        report = self.collect()
        self.assertEqual(report["logStatus"], "complete")
        self.assertEqual(report["quality"], "technical-error")
        technical, phase = report["diagnostics"]
        self.assertEqual(technical["category"], "bundling")
        self.assertEqual(technical["code"], "metro-package-entry")
        self.assertEqual(technical["component"], "@bunny-talks/crypto-engine")
        for item in (technical, phase):
            self.assertEqual(item["phase"], "Bundle React Native code and images")
            self.assertEqual(item["target"], "BunnyTalks")
        self.assertNotIn("fixture-secret", json.dumps(report))

    def test_generic_extraction_can_succeed_with_an_unknown_phase_or_target(self):
        for name in ("generic-summary", "unknown-phase"):
            with self.subTest(name=name):
                self.log.write_bytes((fixtures / f"{name}.txt").read_bytes())
                report = self.collect()
                self.assertEqual((report["verdict"], report["quality"]), ("PASS", "generic"))
                diagnostic, = report["diagnostics"]
                self.assertEqual(diagnostic["code"], "script-failed")
                self.assertNotIn("phase", diagnostic)
                self.assertEqual(diagnostic.get("target"), "BunnyTalks" if name == "generic-summary" else None)
                self.assertNotIn("fixture-secret", json.dumps(report))

    def test_phase_name_from_failed_summary_without_technical_error(self):
        summary = (fixtures / "bundle-phase.txt").read_text().split("The following build commands failed:")[1]
        self.log.write_text("The following build commands failed:" + summary)
        report = self.collect()
        self.assertEqual(report["quality"], "phase-only")
        self.assertEqual(report["diagnostics"][0]["phase"], "Bundle React Native code and images")

    def test_generic_structured_error_needs_log_for_technical_cause(self):
        (self.root / "build.xcresult").mkdir()
        self.log.write_text(
            "PhaseScriptExecution [Expo]\\ Configure\\ project /private/Script-0.sh "
            "(in target 'BunnyTalks' from project 'BunnyTalks')\n"
            "/private/Script-0.sh: line 16: /private/fixture-secret: No such file or directory\n"
            "› sortie ignorée\n"
            "Command PhaseScriptExecution failed with a nonzero exit code\n"
        )
        issue = {"errors": [{"message": "Command PhaseScriptExecution failed with a nonzero exit code"}]}
        with patch.object(collector, "read_structured", return_value=issue):
            report = self.collect()
        self.assertEqual(report["xcresultStatus"], "recognized-errors")
        self.assertEqual(report["logUsage"], "fallback")
        self.assertEqual(report["quality"], "technical-error")
        self.assertEqual(report["sources"], ["xcresult", "log"])
        cause = report["diagnostics"][1]
        self.assertEqual((cause["category"], cause["code"], cause["phase"], cause["target"]),
                         ("configuration", "script-command-unavailable", "[Expo] Configure project", "BunnyTalks"))
        self.assertNotIn("fixture-secret", json.dumps(report))

    def test_task_boundary_drops_pending_script_errors(self):
        self.log.write_bytes((fixtures / "separate-tasks.txt").read_bytes())
        native, script = self.collect()["diagnostics"]
        self.assertEqual((native["code"], native["target"]), ("header-not-found", "ApplicationHttps"))
        self.assertNotIn("phase", native)
        self.assertEqual((script["code"], script["phase"]), ("script-failed", "[CP] Copy Pods Resources"))
        self.assertNotIn("fixture-secret", json.dumps([native, script]))

    def test_byte_line_and_time_limits_never_parse_partial_records(self):
        self.log.write_bytes(b"x" * (collector.MAX_LINE + 2) + b"error: no space left on device\n"
                             + b"error: no space left on device and trailing text\n")
        with patch.object(collector, "MAX_LOG_BYTES", self.log.stat().st_size - 5):
            report = self.collect()
            self.assertEqual(report["logStatus"], "byte-limit")
            self.assertTrue(report["limitReached"])
            self.assertEqual(report["diagnostics"], [])
        with patch.object(collector, "LOG_SECONDS", 0):
            self.assertEqual(self.collect()["logStatus"], "time-limit")

    def test_workflow_preserves_exit_and_fail_even_if_diagnostics_pass(self):
        scratch = self.root / "bunny-ios-standard"
        scratch.mkdir()
        proof = self.root / "bunny-ios-proof"
        proof.mkdir()
        tools = self.root / "tools"
        tools.mkdir()
        fake_xcode = tools / "xcodebuild"
        fake_xcode.write_text("#!/bin/sh\nprintf '%s\\n' \"error: no such module 'BunnyHttpsNative'\"\nexit 65\n")
        fake_xcode.chmod(0o700)
        env = dict(os.environ, RUNNER_TEMP=str(self.root), PATH=f"{tools}{os.pathsep}{os.environ['PATH']}",
                   BUILD_OUTCOME="failure", GITHUB_SHA="a" * 40, ARTIFACT="success", PREFLIGHT="success",
                   PODS="success", BUILD="failure", INSPECTION="skipped")
        build = run_workflow_shell("Compile the standard arm64 simulator Release", env)
        self.assertEqual(build.returncode, 65)
        self.assertEqual(build.stdout + build.stderr, "")
        diagnostics = run_workflow_shell("Collect sanitized Xcode diagnostics", env)
        self.assertEqual(diagnostics.returncode, 0, diagnostics.stderr)
        (proof / "release.json").write_text('{"verdict":"PASS"}')
        summary = run_workflow_shell("Record compilation and inspection results", env)
        self.assertEqual(summary.returncode, 0, summary.stderr)
        result = json.loads((proof / "report.json").read_bytes())
        self.assertEqual(
            [result[key] for key in ("verdict", "compilation", "diagnostics", "inspection", "runtime")],
            ["FAIL", "FAIL", "PASS", "NOT_RUN", "NOT_RUN"],
        )
        self.assertEqual(result["xcodeExitCode"], 65)
        self.assertEqual(result["diagnosticQuality"], "technical-error")
        (scratch / "xcodebuild.log").write_bytes((fixtures / "generic-summary.txt").read_bytes())
        for step in ("Collect sanitized Xcode diagnostics", "Record compilation and inspection results"):
            self.assertEqual(run_workflow_shell(step, env).returncode, 0)
        result = json.loads((proof / "report.json").read_bytes())
        self.assertEqual([result[key] for key in ("xcodeExitCode", "compilation", "diagnostics", "diagnosticQuality",
                                                  "inspection", "runtime")],
                         [65, "FAIL", "PASS", "generic", "NOT_RUN", "NOT_RUN"])


if __name__ == "__main__":
    unittest.main()
