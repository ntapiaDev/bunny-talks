"""Exercise the C1 workflow and worker without invoking Apple tooling."""

import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
from textwrap import dedent
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/run-ios-standard-runtime.py"
spec = importlib.util.spec_from_file_location("standard_runtime", SCRIPT)
runtime = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runtime
spec.loader.exec_module(runtime)
WORKFLOW = (SCRIPT.parents[3] / ".github/workflows/ios-standard-runtime.yml").read_text()
REVISION = "a" * 40
DEVICE = "12345678-0000-0000-0000-123456789ABC"
PID = 2468
SECRET = "fixture-token-private-abcdef"
BINARY = b"synthetic Mach-O"
BUNDLE = b"synthetic Hermes bundle"


def workflow_shell(name):
    step = WORKFLOW.split(f"      - name: {name}\n", 1)[1].split("\n      - name: ", 1)[0]
    return dedent(step.split("\n        run: |\n", 1)[1])


class FakeTools:
    def __init__(self, scratch, home, fault):
        self.scratch = scratch
        self.home = home
        self.fault = fault
        self.device_set = scratch / "simulators"
        self.built_app = scratch / "DerivedData/Build/Products/Release-iphonesimulator/BunnyTalks.app"
        self.installed_app = (self.device_set / DEVICE /
                              "data/Containers/Bundle/Application/example/BunnyTalks.app")
        self.calls = []
        self.device_state = None
        self.inventory_calls = 0
        self.running = False
        self.captures = 0
        self.process_queries = 0

    def app_fixture(self, path, *, bundle_id=runtime.BUNDLE_ID, binary=BINARY, bundle=BUNDLE):
        path.mkdir(parents=True)
        (path / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": bundle_id, "CFBundleExecutable": runtime.EXECUTABLE,
        }))
        (path / runtime.EXECUTABLE).write_bytes(binary)
        (path / "main.jsbundle").write_bytes(bundle)

    def process_path(self, pid):
        if pid != PID:
            return Path(sys.executable)
        if self.fault == "process-identity-unavailable":
            return None
        return self.installed_app / runtime.EXECUTABLE

    def __call__(self, args, **kwargs):
        self.calls.append(args)
        result = runtime.CommandResult
        fixed_versions = {
            ("uname", "-m"): "arm64",
            ("xcodebuild", "-version"): "Xcode 26.6\nBuild version 17F113",
            ("xcrun", "--sdk", "iphonesimulator", "--show-sdk-version"): "26.5",
            ("xcrun", "--sdk", "iphonesimulator", "--show-sdk-build-version"): "23F81a",
            ("node", "--version"): "v24.22.3",
            ("sw_vers", "-productVersion"): "26.7.2",
            ("sw_vers", "-buildVersion"): "25G332",
            ("pnpm", "--version"): "10.34.9",
            ("pod", "--version"): "1.17.0",
        }
        if args in fixed_versions:
            return result(0, fixed_versions[args])
        if args[:3] == ("xcrun", "simctl", "list"):
            if self.fault == "runtime-inventory-timeout":
                raise subprocess.TimeoutExpired(args, kwargs["timeout"], output=SECRET)
            rows = [{
                "identifier": runtime.RUNTIME, "version": "26.5", "buildversion": "23F77",
                "isAvailable": self.fault != "runtime-unavailable", "untrusted": SECRET,
            }] if args[3] == "runtimes" else ([] if self.fault == "device-type-unavailable" else [
                {"identifier": runtime.DEVICE_TYPE},
            ])
            return result(0, json.dumps({args[3]: rows}))
        if args[:3] == ("xcrun", "simctl", "--set"):
            if args[3] != str(self.device_set):
                raise AssertionError("Expected the run's private device set")
            return self.simulator(args[4:], kwargs["timeout"])
        if args[:2] == ("xcrun", "swift"):
            if self.fault == "bad-ocr-output":
                return result(0, f"MATCH\n{SECRET}")
            if self.fault == "ocr-unavailable":
                return result(2, SECRET)
            matched = self.fault == "baseline-match" or (
                self.captures > 1 and self.fault != "no-render"
            )
            return result(0, "MATCH" if matched else "NO_MATCH")
        if args[0] == "/bin/ps":
            self.process_queries += 1
            if not self.running:
                return result(1)
            return result(0, "S")
        if args[:2] == ("xcodebuild", "build"):
            kwargs["output"].write_text(SECRET)
            if self.fault in ("build-rejected", "build-diagnostics-interrupted"):
                return result(65, SECRET)
            if self.fault == "build-interrupted":
                raise runtime.Interrupted
            if self.fault != "app-missing":
                self.app_fixture(self.built_app, bundle_id=(
                    "fr.bunnytalks.other" if self.fault == "bundle-id-mismatch" else runtime.BUNDLE_ID))
            return result(0)
        if args[:4] == ("python3", "-IB", "scripts/inspect-ios-standard.py", "release"):
            if self.fault == "static-inspection-unavailable":
                kwargs["output"].write_text(json.dumps({"verdict": "NOT_RUN", "reason": SECRET}))
                return result(1)
            kwargs["output"].write_text(json.dumps({
                "verdict": "PASS", "bundleId": runtime.BUNDLE_ID, "untrusted": SECRET,
                "configuration": "Release", "platform": "IOSSIMULATOR",
                "architecture": "arm64", "minimumOS": "16.4",
                "executableSha256": runtime.digest(self.built_app / runtime.EXECUTABLE),
                "hermesBundleSha256": runtime.digest(self.built_app / "main.jsbundle"),
                "podfileLockSha256": "b" * 64,
            }))
            return result(0)
        if args[:3] == ("python3", "-IB", "scripts/collect-ios-build-diagnostics.py"):
            if self.fault == "build-diagnostics-interrupted":
                raise runtime.Interrupted
            return result(0, json.dumps({"verdict": "PASS", "quality": "technical-error", "untrusted": SECRET}))
        if args[:4] == ("python3", "-IB", "modules/application-https/ios/verify_xcframeworks.py", "archive"):
            if self.fault == "archive-different":
                return runtime.run_command(args, **kwargs)
            kwargs["output"].write_text("{}")
            return result(0)
        if args[0] in ("corepack", "pnpm", "bash", "python3", "pod", "xcodebuild"):
            return result(0)
        raise AssertionError("Unexpected command")

    def simulator(self, args, timeout):
        result = runtime.CommandResult
        match args[0]:
            case "list":
                self.inventory_calls += 1
                if (self.fault, self.inventory_calls) in (
                    ("initial-inventory-timeout", 1), ("final-inventory-timeout", 2),
                    ("cleanup-inventory-timeout", 3),
                ):
                    raise subprocess.TimeoutExpired(args, timeout, output=SECRET)
                rows = [] if self.device_state is None else [{
                    "udid": DEVICE, "state": self.device_state, "name": runtime.DEVICE_NAME,
                    "untrusted": SECRET,
                }]
                return result(0, json.dumps({"devices": {runtime.RUNTIME: rows}}))
            case "create":
                self.device_state = "Shutdown"
                if self.fault == "create-timeout":
                    raise subprocess.TimeoutExpired(args, timeout, output=SECRET)
                if self.fault == "interrupted-after-create":
                    raise runtime.Interrupted
                return result(0, DEVICE)
            case "boot":
                if self.fault == "boot-refused":
                    return result(11, SECRET)
                self.device_state = "Booting"
                if self.fault == "boot-timeout":
                    raise subprocess.TimeoutExpired(args, timeout, output=SECRET)
            case "bootstatus":
                if self.fault == "interrupted-during-boot":
                    raise runtime.Interrupted
                if self.fault == "bootstatus-timeout-booting":
                    raise subprocess.TimeoutExpired(args, timeout, output=SECRET)
                if self.fault == "bootstatus-refused":
                    return result(19, SECRET)
                if self.fault != "booting-after-readiness":
                    self.device_state = SECRET if self.fault == "unknown-state" else "Booted"
                if self.fault == "bootstatus-timeout-booted":
                    raise subprocess.TimeoutExpired(args, timeout, output=SECRET)
            case "install":
                if self.fault == "installation-refused":
                    return result(42, SECRET)
                if self.fault != "installed-app-missing":
                    self.app_fixture(
                        self.installed_app,
                        bundle_id=SECRET if self.fault == "installed-bundle-id-mismatch" else runtime.BUNDLE_ID,
                        binary=b"divergent" if self.fault == "installed-executable-mismatch" else BINARY,
                        bundle=b"divergent" if self.fault == "installed-bundle-mismatch" else BUNDLE,
                    )
            case "get_app_container":
                return result(0, str(self.installed_app))
            case "io":
                self.captures += 1
                Path(args[-1]).write_text(SECRET)
            case "launch":
                if self.fault == "launch-refused":
                    return result(17, SECRET)
                self.running = self.fault not in ("crash", "exit-without-crash-report")
                if self.fault in ("crash", "exit-without-crash-report"):
                    directory = self.home / "Library/Logs/DiagnosticReports"
                    directory.mkdir(parents=True)
                    path = (self.installed_app if self.fault == "crash" else self.home) / runtime.EXECUTABLE
                    (directory / "BunnyTalks-example.ips").write_text(
                        '{"bug_type":"309"}\n' + json.dumps({
                            "pid": PID, "bundleInfo": {"CFBundleIdentifier": runtime.BUNDLE_ID},
                            "procPath": str(path), "exception": {"signal": "SIGABRT"}, "untrusted": SECRET,
                        }))
                return result(0, f"{runtime.BUNDLE_ID}: {PID}")
            case "terminate":
                if self.fault == "stop-refused":
                    return result(3, SECRET)
                self.running = False
            case "shutdown":
                if self.fault == "shutdown-refused":
                    return result(6, SECRET)
                self.device_state = "Shutdown"
            case "delete":
                if self.fault == "delete-refused":
                    return result(5, SECRET)
                if self.fault != "delete-without-proof":
                    self.device_state = None
            case _:
                raise AssertionError("Unexpected simulator command")
        return result(0)


class RuntimeTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def execute(self, fault=None):
        scratch = self.root / "bunny-ios-c1"
        proof = self.root / "report.json"
        home = self.root / "fixture-home"
        scratch.mkdir()
        if fault != "archive-missing":
            (scratch / "xcframeworks.zip").write_bytes(b"synthetic ZIP for mocked verifier")
        env = {
            "GITHUB_SHA": REVISION, "REVIEWED_SHA": REVISION, "CHECKED_OUT_SHA": REVISION,
            "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_REPOSITORY": "ntapiaDev/bunny-talks",
            "GITHUB_RUN_ATTEMPT": "1", "GITHUB_RUN_ID": "1234", "EXPO_NO_DOTENV": "1", "EXPO_OFFLINE": "1",
            "EXAMPLE_SECRET": SECRET,
        }
        if fault == "bad-sha":
            env["REVIEWED_SHA"] = SECRET
        if fault == "checkout-sha-mismatch":
            env["CHECKED_OUT_SHA"] = "b" * 40
        if fault == "qualification-override":
            env["BUNNY_IOS_HTTPS_QUALIFICATION"] = ""
        tools = FakeTools(scratch, home, fault)
        # Advance observation without sleeping while still exercising both end checks.
        ticks = iter((0, 0, runtime.STABILITY_SECONDS))
        with patch.object(runtime.Path, "home", return_value=home), \
             patch.object(runtime, "process_path", side_effect=tools.process_path), \
             patch.object(runtime.time, "monotonic", side_effect=lambda: next(ticks)), \
             patch.object(runtime.time, "sleep"):
            code = runtime.RuntimeRun(scratch, proof, env, tools).run()
        report = json.loads(proof.read_text())
        for stage in runtime.OUT_OF_SCOPE:
            self.assertEqual(report["stages"][stage], {"verdict": "NOT_RUN"})
        for private in (SECRET, str(self.root), DEVICE):
            self.assertNotIn(private, proof.read_text())
        return code, report, tools

    def test_wrong_approved_sha_runs_no_external_command(self):
        code, report, tools = self.execute("bad-sha")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["revision"]["code"], "reviewed-sha-mismatch")
        self.assertEqual(report["stages"]["build"]["verdict"], "NOT_RUN")
        self.assertEqual(tools.calls, [])

    def test_wrong_checkout_sha_runs_no_external_command(self):
        code, report, tools = self.execute("checkout-sha-mismatch")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["revision"]["code"], "checkout-sha-mismatch")
        self.assertEqual(tools.calls, [])

    def test_qualification_override_is_blocked_before_tools(self):
        code, report, tools = self.execute("qualification-override")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["toolchain"]["code"], "runtime-environment-overrides")
        self.assertEqual(tools.calls, [])

    def test_missing_zip(self):
        code, report, tools = self.execute("archive-missing")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["archive"]["code"], "archive-missing")
        self.assertEqual(report["stages"]["build"]["verdict"], "NOT_RUN")

    def test_different_zip_is_rejected_by_real_pinned_verifier(self):
        code, report, tools = self.execute("archive-different")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["archive"],
                         {"verdict": "FAIL", "code": "archive-rejected", "exitCode": 1})
        self.assertEqual(report["stages"]["build"]["verdict"], "NOT_RUN")

    def test_runtime_unavailable_stops_before_build(self):
        code, report, tools = self.execute("runtime-unavailable")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["simulatorAvailability"]["code"], "runtime-unavailable")
        self.assert_build_not_started(report, tools)
        self.assertIsNone(tools.device_state)

    def test_device_type_unavailable_stops_before_build(self):
        code, report, tools = self.execute("device-type-unavailable")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["simulatorAvailability"]["code"], "device-type-unavailable")
        self.assert_build_not_started(report, tools)

    def test_runtime_inventory_timeout_stops_before_private_simulator_and_build(self):
        code, report, tools = self.execute("runtime-inventory-timeout")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["simulatorAvailability"],
                         {"verdict": "FAIL", "code": "simulator-inventory-timeout"})
        self.assertEqual(report["stages"]["simulatorPreparation"]["verdict"], "NOT_RUN")
        self.assert_build_not_started(report, tools)
        self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")
        self.assertEqual(tools.inventory_calls, 0)

    def test_build_failure_preserves_exit_code_and_cleans_prepared_simulator(self):
        code, report, tools = self.execute("build-rejected")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["build"],
                         {"verdict": "FAIL", "code": "xcodebuild-failed", "exitCode": 65})
        self.assertEqual(report["evidence"]["buildDiagnosticQuality"], "technical-error")
        self.assertEqual(report["stages"]["staticInspection"]["verdict"], "NOT_RUN")
        self.assertEqual(report["stages"]["simulatorPreparation"]["verdict"], "PASS")
        self.assertEqual(report["stages"]["installation"]["verdict"], "NOT_RUN")
        self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")
        self.assertTrue(report["evidence"]["simulatorRemoved"])
        self.assertIsNone(tools.device_state)
        self.assertFalse(tools.scratch.exists())

    def test_built_app_missing(self):
        code, report, tools = self.execute("app-missing")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["build"]["verdict"], "PASS")
        self.assertEqual(report["stages"]["staticInspection"]["code"], "built-app-missing-or-ambiguous")
        self.assertEqual(report["stages"]["simulatorPreparation"]["verdict"], "PASS")
        self.assertEqual(report["stages"]["installation"]["verdict"], "NOT_RUN")
        self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")

    def test_built_bundle_identifier_must_be_standard(self):
        code, report, tools = self.execute("bundle-id-mismatch")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["staticInspection"]["code"], "bundle-id-mismatch")
        self.assertEqual(report["stages"]["installation"]["verdict"], "NOT_RUN")

    def test_static_inspection_requires_affirmative_evidence(self):
        code, report, tools = self.execute("static-inspection-unavailable")
        self.assertEqual(code, 2)
        self.assertEqual(report["stages"]["staticInspection"],
                         {"verdict": "NOT_RUN", "code": "static-inspection-unavailable"})
        self.assertEqual(report["stages"]["simulatorPreparation"]["verdict"], "PASS")
        self.assertEqual(report["stages"]["installation"]["verdict"], "NOT_RUN")
        self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")

    def test_installed_app_missing(self):
        code, report, tools = self.execute("installed-app-missing")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["installedExecutable"]["code"], "app-missing")
        self.assertEqual(report["stages"]["launch"]["verdict"], "NOT_RUN")

    def test_installed_wrong_bundle_identifier(self):
        code, report, tools = self.execute("installed-bundle-id-mismatch")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["installedExecutable"]["code"], "bundle-id-mismatch")
        self.assertEqual(report["stages"]["launch"]["verdict"], "NOT_RUN")

    def test_installed_executable_divergence_blocks_launch(self):
        code, report, tools = self.execute("installed-executable-mismatch")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["installedExecutable"]["code"], "installed-app-mismatch")
        self.assertEqual(report["stages"]["launch"]["verdict"], "NOT_RUN")

    def test_installed_bundle_divergence_blocks_launch(self):
        code, report, tools = self.execute("installed-bundle-mismatch")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["installedExecutable"]["code"], "installed-app-mismatch")
        self.assertEqual(report["stages"]["launch"]["verdict"], "NOT_RUN")

    def test_installation_refused_keeps_only_code_and_exit_status(self):
        code, report, tools = self.execute("installation-refused")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["installation"],
                         {"verdict": "FAIL", "code": "installation-refused", "exitCode": 42})
        self.assertEqual(report["stages"]["launch"]["verdict"], "NOT_RUN")
        self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")

    def test_launch_refused_keeps_only_code_and_exit_status(self):
        code, report, tools = self.execute("launch-refused")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["launch"],
                         {"verdict": "FAIL", "code": "launch-refused", "exitCode": 17})
        self.assertEqual(report["stages"]["reactNativeRendering"]["verdict"], "NOT_RUN")
        self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")

    def test_launch_then_correlated_crash(self):
        code, report, tools = self.execute("crash")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["launch"]["verdict"], "PASS")
        self.assertEqual(report["stages"]["processStability"]["code"], "correlated-crash")
        self.assertEqual(report["evidence"]["crashSignal"], "SIGABRT")
        self.assertEqual(report["stages"]["reactNativeRendering"]["verdict"], "NOT_RUN")
        self.assertEqual(report["stages"]["stop"]["verdict"], "NOT_RUN")
        self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")

    def test_unrelated_crash_report_does_not_explain_exit(self):
        code, report, tools = self.execute("exit-without-crash-report")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["processStability"]["code"], "process-exited-unexpectedly")
        self.assertNotIn("crashSignal", report["evidence"])

    def test_render_missing_with_stable_process_is_not_run(self):
        code, report, tools = self.execute("no-render")
        self.assertEqual(code, 2)
        self.assertEqual(report["stages"]["reactNativeRendering"],
                         {"verdict": "NOT_RUN", "code": "screen-markers-missing"})
        self.assertEqual(report["stages"]["processStability"]["verdict"], "PASS")
        self.assertEqual(report["stages"]["stop"]["verdict"], "PASS")

    def test_baseline_match_prevents_render_attestation(self):
        code, report, tools = self.execute("baseline-match")
        self.assertEqual(code, 2)
        self.assertEqual(report["stages"]["reactNativeRendering"]["code"], "negative-render-control-unavailable")
        self.assertEqual(tools.captures, 1)

    def test_ocr_output_must_match_a_fixed_value(self):
        code, report, tools = self.execute("bad-ocr-output")
        self.assertEqual(code, 2)
        self.assertEqual(report["stages"]["reactNativeRendering"]["verdict"], "NOT_RUN")

    def test_ocr_unavailable_leaves_render_not_run(self):
        code, report, tools = self.execute("ocr-unavailable")
        self.assertEqual(code, 2)
        self.assertEqual(report["stages"]["reactNativeRendering"]["code"], "negative-render-control-unavailable")
        self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")

    def test_process_identity_without_path_is_not_run(self):
        code, report, tools = self.execute("process-identity-unavailable")
        self.assertEqual(code, 2)
        self.assertEqual(report["stages"]["processStability"],
                         {"verdict": "NOT_RUN", "code": "process-identity-unavailable"})
        self.assertEqual(report["stages"]["reactNativeRendering"]["verdict"], "NOT_RUN")

    def test_attested_render_stop_and_cleanup_pass_in_one_build(self):
        code, report, tools = self.execute()
        self.assertEqual(code, 0)
        self.assertTrue(report["complete"])
        self.assertEqual(report["verdict"], "PASS")
        self.assertEqual(report["run"], 1234)
        self.assertEqual(report["evidence"]["inspectedApp"], report["evidence"]["installedApp"])
        self.assertEqual(report["evidence"]["simulator"]["iOSBuild"], "23F77")
        self.assertEqual(report["evidence"]["simulatorBootExitCode"], 0)
        self.assertEqual(report["evidence"]["simulatorBootstatusExitCode"], 0)
        self.assertEqual(report["evidence"]["simulatorState"], "Booted")
        self.assertEqual(sum(args[:2] == ("xcodebuild", "build") for args in tools.calls), 1)
        private_calls = [args[4:] for args in tools.calls if args[:3] == ("xcrun", "simctl", "--set")]
        self.assertEqual([args[0] for args in private_calls],
                         ["list", "create", "boot", "bootstatus", "list", "install",
                          "get_app_container", "io", "launch", "io", "terminate", "list",
                          "shutdown", "delete", "list"])
        self.assertTrue(all(args[1] == DEVICE for args in private_calls
                            if args[0] not in ("list", "create")))
        sim = ("xcrun", "simctl", "--set", str(tools.device_set))
        readiness_index = tools.calls.index(sim + ("bootstatus", DEVICE, "-b"))
        self.assertEqual(tools.calls[readiness_index + 1], sim + ("list", "devices", "--json"))
        self.assertLess(readiness_index + 1, tools.calls.index(("corepack", "enable")))
        compile_index = next(i for i, args in enumerate(tools.calls) if args[:2] == ("xcodebuild", "build"))
        self.assertLess(compile_index, tools.calls.index(sim + ("install", DEVICE, str(tools.built_app))))
        self.assertEqual(tools.captures, 2)
        self.assertGreaterEqual(tools.process_queries, 4)
        self.assertIsNone(tools.device_state)
        self.assertFalse(tools.scratch.exists())

    def test_stop_failure_remains_visible_after_device_removal(self):
        code, report, tools = self.execute("stop-refused")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["reactNativeRendering"]["verdict"], "PASS")
        self.assertEqual(report["stages"]["stop"]["code"], "stop-refused")
        self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")

    def test_cleanup_failure_remains_visible_after_successful_launch(self):
        code, report, tools = self.execute("delete-refused")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["stop"]["verdict"], "PASS")
        self.assertEqual(report["stages"]["cleanup"],
                         {"verdict": "FAIL", "code": "simulator-delete-failed", "exitCode": 5})
        self.assertEqual(tools.device_state, "Shutdown")

    def test_cleanup_requires_empty_inventory_after_delete(self):
        code, report, tools = self.execute("delete-without-proof")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["cleanup"]["code"], "simulator-still-present")

    def test_shutdown_refusal_stays_visible_after_successful_delete(self):
        code, report, tools = self.execute("shutdown-refused")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["cleanup"]["code"], "simulator-shutdown-failed")
        self.assertIsNone(tools.device_state)
        self.assertFalse(tools.scratch.exists())

    def test_interruption_during_create_recovers_uuid_from_private_inventory(self):
        code, report, tools = self.execute("interrupted-after-create")
        self.assertEqual(code, 2)
        self.assertFalse(report["complete"])
        self.assertEqual(report["stages"]["simulatorPreparation"]["code"], "interrupted")
        self.assertEqual(report["stages"]["installation"]["verdict"], "NOT_RUN")
        self.assert_build_not_started(report, tools)
        self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")
        self.assertIsNone(tools.device_state)

    def test_interruption_after_boot_leaves_downstream_stages_not_run(self):
        code, report, tools = self.execute("interrupted-during-boot")
        self.assertEqual(code, 2)
        self.assertFalse(report["complete"])
        self.assertEqual(report["stages"]["simulatorPreparation"]["code"], "interrupted")
        self.assertEqual(report["evidence"]["simulatorBootExitCode"], 0)
        self.assert_build_not_started(report, tools)
        self.assertEqual(report["stages"]["launch"]["verdict"], "NOT_RUN")
        self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")
        self.assertIsNone(tools.device_state)

    def test_interruption_during_build_preserves_simulator_preparation_and_cleans_device(self):
        code, report, tools = self.execute("build-interrupted")
        self.assertEqual(code, 2)
        self.assertFalse(report["complete"])
        self.assertEqual(report["stages"]["simulatorPreparation"]["verdict"], "PASS")
        self.assertEqual(report["stages"]["build"], {"verdict": "NOT_RUN", "code": "interrupted"})
        self.assertEqual(report["stages"]["staticInspection"]["verdict"], "NOT_RUN")
        self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")
        self.assertIsNone(tools.device_state)

    def test_interrupted_diagnostics_preserve_known_build_failure_and_clean_device(self):
        code, report, tools = self.execute("build-diagnostics-interrupted")
        self.assertEqual(code, 1)
        self.assertFalse(report["complete"])
        self.assertEqual(report["stages"]["simulatorPreparation"]["verdict"], "PASS")
        self.assertEqual(report["stages"]["build"],
                         {"verdict": "FAIL", "code": "xcodebuild-failed", "exitCode": 65})
        self.assertEqual(report["stages"]["staticInspection"]["verdict"], "NOT_RUN")
        self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")
        self.assertIsNone(tools.device_state)

    def assert_build_not_started(self, report, tools):
        for name in ("dependencies", "project", "build", "staticInspection", "installation",
                     "installedExecutable", "launch", "reactNativeRendering", "processStability", "stop"):
            self.assertEqual(report["stages"][name], {"verdict": "NOT_RUN"}, name)
        self.assertEqual([args for args in tools.calls if args[0] == "xcodebuild"],
                         [("xcodebuild", "-version")])
        self.assertFalse(any(args[0] in ("corepack", "pnpm", "pod") for args in tools.calls))

    def test_simulator_timeouts_remain_failures_even_with_a_later_booted_state(self):
        for fault, error, state, boot_exit, readiness_exit in (
            ("create-timeout", "simulator-create-timeout", "Shutdown", None, None),
            ("boot-timeout", "simulator-boot-timeout", "Booting", None, None),
            ("bootstatus-timeout-booting", "simulator-bootstatus-timeout", "Booting", 0, None),
            ("bootstatus-timeout-booted", "simulator-bootstatus-timeout", "Booted", 0, None),
            ("initial-inventory-timeout", "simulator-inventory-timeout", None, None, None),
            ("final-inventory-timeout", "simulator-inventory-timeout", "Booted", 0, 0),
        ):
            with self.subTest(fault=fault):
                code, report, tools = self.execute(fault)
                self.assertEqual(code, 1)
                self.assertEqual(report["stages"]["simulatorPreparation"], {"verdict": "FAIL", "code": error})
                self.assertEqual(report["evidence"].get("simulatorStateAfterFailure"), state)
                self.assertEqual(report["evidence"].get("simulatorBootExitCode"), boot_exit)
                self.assertEqual(report["evidence"].get("simulatorBootstatusExitCode"), readiness_exit)
                self.assertNotIn("simulatorBooted", report["evidence"])
                self.assert_build_not_started(report, tools)
                self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")
                self.assertIsNone(tools.device_state)
                self.assertFalse(tools.scratch.exists())
                self.assertEqual(report["evidence"].get("simulatorRemoved"), True if state else None)

    def test_readiness_requires_booted_inventory_and_redacts_unrecognized_states(self):
        for fault, state in (("booting-after-readiness", "Booting"), ("unknown-state", "unknown")):
            with self.subTest(fault=fault):
                code, report, tools = self.execute(fault)
                self.assertEqual(code, 1)
                self.assertEqual(report["stages"]["simulatorPreparation"]["code"], "simulator-boot-incomplete")
                self.assertEqual(report["evidence"]["simulatorBootstatusExitCode"], 0)
                self.assertEqual(report["evidence"]["simulatorState"], state)
                self.assertEqual(report["evidence"]["simulatorStateAfterFailure"], state)
                self.assert_build_not_started(report, tools)
                self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")
                self.assertIsNone(tools.device_state)

    def test_boot_and_bootstatus_refusals_preserve_exact_exit_codes(self):
        for fault, error, exit_code, boot_exit in (
            ("boot-refused", "simulator-boot-failed", 11, None),
            ("bootstatus-refused", "simulator-bootstatus-failed", 19, 0),
        ):
            with self.subTest(fault=fault):
                code, report, tools = self.execute(fault)
                self.assertEqual(code, 1)
                self.assertEqual(report["stages"]["simulatorPreparation"],
                                 {"verdict": "FAIL", "code": error, "exitCode": exit_code})
                self.assertEqual(report["evidence"].get("simulatorBootExitCode"), boot_exit)
                self.assert_build_not_started(report, tools)
                self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")

    def test_cleanup_inventory_timeout_preserves_prior_success_and_is_visible(self):
        code, report, tools = self.execute("cleanup-inventory-timeout")
        self.assertEqual(code, 1)
        self.assertEqual(report["stages"]["simulatorPreparation"]["verdict"], "PASS")
        self.assertEqual(report["stages"]["stop"]["verdict"], "PASS")
        self.assertEqual(report["stages"]["cleanup"],
                         {"verdict": "FAIL", "code": "simulator-inventory-timeout"})
        self.assertNotIn("simulatorRemoved", report["evidence"])

    def test_shell_gate_and_fallback_match_worker_report_schema(self):
        env = dict(os.environ, RUNNER_TEMP=str(self.root), GITHUB_SHA=REVISION, REVIEWED_SHA=SECRET)
        gate = subprocess.run(["bash", "-eo", "pipefail", "-c", workflow_shell("Gate the reviewed revision")],
                              env=env, text=True, capture_output=True)
        self.assertEqual(gate.returncode, 1)
        self.assertNotIn(SECRET, gate.stdout + gate.stderr)
        fallback = subprocess.run([
            "bash", "-eo", "pipefail", "-c",
            workflow_shell("Preserve a sanitized report when the worker never starts"),
        ], env=dict(env, APPROVAL="failure"), text=True, capture_output=True)
        self.assertEqual(fallback.returncode, 0, fallback.stderr)
        proof = (self.root / "bunny-ios-c1-proof/report.json").read_text()
        report = json.loads(proof)
        self.assertEqual(set(report["stages"]), set(runtime.REQUIRED_STAGES + runtime.OUT_OF_SCOPE))
        self.assertEqual(report["stages"]["revision"]["verdict"], "FAIL")
        self.assertEqual(report["stages"]["build"]["verdict"], "NOT_RUN")
        self.assertNotIn(SECRET, proof)

    def test_command_wrapper_keeps_raw_streams_out_of_public_output(self):
        output = self.root / "private.json"
        result = runtime.run_command((
            sys.executable, "-c", f"import sys; print('{{}}'); print('{SECRET}', file=sys.stderr)",
        ), cwd=self.root, timeout=5, output=output, capture=True)
        self.assertEqual(result, runtime.CommandResult(0, "{}"))
        self.assertEqual(output.read_text(), "{}\n")

    def test_command_wrapper_times_out_a_blocked_local_process(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            runtime.run_command((sys.executable, "-c", "import time; time.sleep(4)"),
                                cwd=self.root, timeout=0.05, capture=True)


if __name__ == "__main__":
    unittest.main()
