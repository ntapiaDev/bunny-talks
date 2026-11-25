"""Exercise campaign-specific gates without an Apple runner."""

import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import Mock, patch


script = Path(__file__).resolve().parents[1] / "scripts/run-ios-https-campaign.py"
spec = importlib.util.spec_from_file_location("campaign", script)
campaign = importlib.util.module_from_spec(spec)
spec.loader.exec_module(campaign)


class CampaignTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.run = campaign.Campaign(self.root / "report.json", {})

    def test_commands_come_from_executed_target_tasks(self):
        log = self.root / "xcodebuild.log"
        log.write_text(
            "ScanDependencies test (in target 'ApplicationHttps' from project 'Pods')\n"
            "    /x/clang -c /src/BunnyHttpsNative.c -DWRONG\n"
            "CompileC test (in target 'ApplicationHttps' from project 'Pods')\n"
            "    cd /src\n"
            "    /my\\ toolchain/clang -c '/my source/BunnyHttpsNative.c' @/args\n"
            "SwiftDriver ApplicationHttps normal arm64 (in target 'ApplicationHttps' from project 'Pods')\n"
            "    builtin-SwiftDriver -- /x/swiftc -module-name ApplicationHttps @/args\n"
            "SwiftCompile normal arm64 (in target 'ApplicationHttps' from project 'Pods')\n"
            '    "/my toolchain/swift-frontend" -c /src/ApplicationHttpsModule.swift\n'
            "SwiftDriver Other normal arm64 (in target 'Other' from project 'Pods')\n"
            "    builtin-SwiftDriver -- /x/swiftc -module-name Other\n"
        )
        commands = campaign.collect_commands(log)
        self.assertEqual(commands["c"], [["/my toolchain/clang", "-c", "/my source/BunnyHttpsNative.c", "@/args"]])
        self.assertEqual(commands["swift"], [["/x/swiftc", "-module-name", "ApplicationHttps", "@/args"],
                                             ["/my toolchain/swift-frontend", "-c", "/src/ApplicationHttpsModule.swift"]])
        log.write_text("    CONFIGURATION = Release\n")
        with self.assertRaises(campaign.c2.StageError) as error:
            campaign.collect_commands(log)
        self.assertEqual(error.exception.record["verdict"], "NOT_RUN")
        log.write_text("SwiftDriver ApplicationHttps normal arm64 (in target 'ApplicationHttps' from project 'Pods')\n"
                       "    builtin-SwiftDriver -- /private/fixture-secret/swiftc 'unterminated\n")
        with self.assertRaises(campaign.c2.StageError) as error:
            campaign.collect_commands(log)
        structure = error.exception.record["commandCollection"]
        self.assertEqual(structure["point"], "SwiftDriver-argument-parsing")
        self.assertEqual(structure["tasks"]["SwiftDriver"], {
            "headers": 1, "invocationLines": 1, "acceptedInvocations": 0,
        })
        self.assertEqual(structure["missingLanguages"], ["c", "swift"])
        self.assertNotIn("fixture-secret", json.dumps(error.exception.record))

    def test_failed_build_collects_before_cleanup_without_masking_xcode_error(self):
        log = Path(__file__).parent / "fixtures/ios-build-diagnostics/bundle-phase.txt"
        for collector_failure in (None, "failed", "interrupted"):
            with self.subTest(collector_failure=collector_failure):
                run = campaign.Campaign(self.root / "report.json", {})
                run.scratch = self.root / "scratch"
                run.work = run.scratch / "work"
                run.work.mkdir(parents=True)
                run.inputs = {"builds": {}}
                for name in ("revision", "source", "archive", "toolchain", "simulator", "start_fixture", "prebuild"):
                    setattr(run, name, Mock(return_value={}))
                run.space = Mock(return_value=10)
                run.install = Mock()
                run.prelaunch = Mock()
                run.runtime = Mock()
                calls = []

                def command(args, **kwargs):
                    if args[:2] == ("xcodebuild", "build"):
                        out = kwargs["output"]
                        name = out.parent.name.removesuffix("-build")
                        calls.append(name)
                        out.write_bytes(log.read_bytes())
                        return campaign.c1.CommandResult(65)
                    elif args[:3] == ("python3", "-IB", "scripts/collect-ios-build-diagnostics.py"):
                        build_dir = Path(args[3])
                        self.assertEqual(build_dir.name, "candidate-build")
                        self.assertEqual((build_dir / "xcodebuild.exit").read_text(), "65\n")
                        self.assertEqual(kwargs["timeout"], 50)
                        calls.append("diagnostics")
                        if collector_failure == "failed":
                            return campaign.c1.CommandResult(9, "fixture-secret")
                        if collector_failure == "interrupted":
                            raise campaign.c1.Interrupted
                        return run.isolated_command(args, **kwargs)
                    elif "-showBuildSettings" in args:
                        kwargs["output"].write_text("[]")
                    return campaign.c1.CommandResult(0)

                runner = campaign.c1.RuntimeRun(run.scratch, run.report_path, {}, command=command)
                with (patch.object(campaign.c2, "simulator", return_value=runner),
                      patch.object(campaign.c2, "load_receipt",
                                   return_value={"qualificationScope": campaign.c2.CANDIDATE_SCOPE}),
                      patch.object(campaign.c2, "verify_lab_ready"),
                      patch.object(campaign.c2.inspection, "check_generated"),
                      patch.object(campaign.c2.inspection, "check_pod_settings")):
                    self.assertEqual(run.run(), 1)
                report = json.loads(run.report_path.read_text())
                stage = report["stages"]["candidateBuild"]
                self.assertEqual((stage["verdict"], stage["code"], stage["exitCode"]), ("FAIL", "xcodebuild-failed", 65))
                diagnostics = stage["buildDiagnostics"]
                if collector_failure:
                    reason = "interrupted" if collector_failure == "interrupted" else "build-diagnostics-unavailable"
                    self.assertEqual(diagnostics, {"verdict": "NOT_RUN", "reason": reason})
                else:
                    self.assertEqual(diagnostics["verdict"], "PASS")
                    self.assertEqual(diagnostics["xcodeExitCode"], 65)
                    self.assertTrue(diagnostics["diagnostics"])
                self.assertNotIn("fixture-secret", json.dumps(report))
                self.assertEqual(calls, ["candidate", "diagnostics"])
                run.prelaunch.assert_not_called()
                run.install.assert_not_called()
                run.runtime.assert_not_called()
                self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")
                self.assertFalse(run.scratch.exists())

    def test_socket_attribution_and_abort(self):
        for peer, outside in (("127.0.0.1:29443", False), ("[::1]:29443", False),
                              ("[::ffff:127.0.0.1]:29443", False), ("192.0.2.1:443", True),
                              ("[2001:db8::1]:443", True), ("unresolved:443", False)):
            with self.subTest(peer=peer):
                fields = f"p42\nf3\nn127.0.0.1:53000->{peer}\n"
                self.assertEqual(campaign.external_peer(fields, 42), outside)
                self.assertFalse(campaign.external_peer(fields, 12))
        self.run.installed = self.root
        with (patch.object(campaign.c1, "process_path", return_value=self.root / campaign.c1.EXECUTABLE),
              patch.object(self.run, "command", side_effect=campaign.c2.StageError("command-failed"))):
            self.run.sample(42)
        self.assertEqual(self.run.report["networkObservation"]["verdict"], "NOT_RUN")
        with (patch.object(campaign.c1, "process_path", return_value=self.root / campaign.c1.EXECUTABLE),
              patch.object(self.run, "command", return_value=fields.replace("unresolved:443", "192.0.2.1:443"))):
            with self.assertRaises(campaign.c2.StageError):
                self.run.sample(42)
        self.assertEqual(self.run.report["networkObservation"]["verdict"], "FAIL")

    def test_missing_provenance_stops_single_build_campaign_before_install_and_cleans(self):
        early = ("revision", "source", "archive", "toolchain", "simulator", "start_fixture", "prebuild", "build")
        for name in early:
            setattr(self.run, name, Mock(return_value={}))
        self.run.prelaunch = Mock(side_effect=campaign.c2.StageError("compile-evidence-incomplete", verdict="NOT_RUN"))
        self.run.install = Mock()
        self.run.runtime = Mock()
        self.run.cleanup = Mock(return_value={})
        self.assertEqual(self.run.run(), 1)
        self.run.build.assert_called_once_with()
        self.assertEqual(self.run.report["stages"]["candidateBuild"]["verdict"], "PASS")
        self.assertEqual(self.run.report["stages"]["candidateProvenance"]["verdict"], "NOT_RUN")
        self.run.install.assert_not_called()
        self.run.runtime.assert_not_called()
        self.run.cleanup.assert_called_once()
        self.assertEqual(self.run.report["nativeEquivalence"], "NOT_RUN")

    def test_first_phase_must_finish_before_trust_and_second_phase(self):
        calls = []
        self.run.work = self.root
        with (patch.object(self.run, "phase", side_effect=lambda name: calls.append(name)),
              patch.object(self.run, "command", side_effect=lambda args: calls.append(args[-3])),
              patch.object(campaign.c2, "get_launch"),
              patch.object(campaign.c2, "verify_phases", return_value=({}, [])),
              patch.object(campaign.c2, "read_runtime", return_value={"verdict": "PASS"})):
            self.run.runtime()
        self.assertEqual(calls, ["before", "trust", "after"])
        with (patch.object(self.run, "phase", side_effect=campaign.c2.StageError("outside-destination-observed")),
              patch.object(self.run, "command") as trust, self.assertRaises(campaign.c2.StageError)):
            self.run.runtime()
        trust.assert_not_called()

    def test_launch_pid_is_returned_by_private_simctl_and_ambiguity_is_rejected(self):
        bundle = campaign.c2.APP_IDS["candidate"]
        runner = campaign.c1.RuntimeRun(self.root, self.run.report_path, {}, bundle_id=bundle)
        runner.device = "device"
        launch_args = ("-BunnyC2Launch", f"before:{'a' * 32}:{'b' * 32}")
        for output, code in ((f"{bundle}: 42", None), ("unrecognized", "launch-pid-unavailable"),
                             (f"{bundle}: 42\n{bundle}: 43", "launch-pid-ambiguous")):
            with self.subTest(code=code), patch.object(
                runner, "sim", return_value=campaign.c1.CommandResult(0, output)
            ) as launch:
                if code:
                    with self.assertRaisesRegex(campaign.c2.StageError, code):
                        runner.launch_pid(*launch_args)
                else:
                    self.assertEqual(runner.launch_pid(*launch_args), 42)
                launch.assert_called_once_with("launch", "device", bundle, *launch_args, code="launch-refused", capture=True)

    def test_candidate_process_status_and_bundle_correlated_crash(self):
        bundle = campaign.c2.APP_IDS["candidate"]
        runner = campaign.c1.RuntimeRun(self.root, self.run.report_path, {}, bundle_id=bundle)
        runner.pid, runner.device, runner.installed = 42, "simulator", self.root / "BunnyTalks.app"
        with (patch.object(runner, "call", return_value=campaign.c1.CommandResult(0, "S")),
              patch.object(campaign.c1, "process_path", return_value=self.root / "other")):
            with self.assertRaisesRegex(campaign.c2.StageError, "installed-process-mismatch"):
                runner.check_alive(explicit_identity=True)
        with patch.object(runner, "call", return_value=campaign.c1.CommandResult(1)), patch.object(
            campaign.time, "sleep"
        ):
            with self.assertRaisesRegex(campaign.c2.StageError, "process-exited-unexpectedly"):
                runner.check_alive(explicit_identity=True)
            reports = runner.device_set / runner.device / "data/Library/Logs/CrashReporter"
            reports.mkdir(parents=True)
            (reports / "BunnyTalks-fixture.ips").write_text(json.dumps({"bug_type": "309"}) + "\n" + json.dumps({
                "pid": 42, "bundleInfo": {"CFBundleIdentifier": bundle},
                "procPath": str(runner.installed / campaign.c1.EXECUTABLE), "exception": {"signal": "SIGABRT"},
            }))
            with self.assertRaisesRegex(campaign.c2.StageError, "correlated-crash"):
                runner.check_alive(explicit_identity=True)
            self.assertEqual(runner.evidence["crashSignal"], "SIGABRT")

    def test_startup_reports_missing_markers_and_rejects_stale_parameters(self):
        runner, reader = Mock(pid=42), Mock()
        reader.poll.return_value = None
        stream = self.root / "phase.ndjson"
        bound = campaign.RUN_MARKER + "fixture before"
        js = campaign.STARTUP + "READY js"
        accepted = campaign.STARTUP + "PASS parameters"
        for messages, code in (
            ([], "candidate-js-marker-missing"),
            ([js, campaign.STARTUP + "FAIL parameters-missing"], "candidate-parameters-unavailable"),
            ([js], "candidate-parameters-unavailable"),
            ([js, accepted], "candidate-scenario-marker-missing"),
            ([js, campaign.STARTUP + "FAIL parameters-invalid"], "candidate-parameters-invalid"),
            ([js, accepted, campaign.RUN_MARKER + "stale after"], "candidate-parameters-mismatch"),
        ):
            with (self.subTest(code=code), patch.object(campaign, "phase_messages", return_value=messages),
                  patch.object(campaign.time, "monotonic", side_effect=[0, 1, 21]),
                  patch.object(campaign.time, "sleep"), patch.object(self.run, "sample")):
                with self.assertRaisesRegex(campaign.c2.StageError, code):
                    self.run.await_startup(runner, reader, stream, bound)

    def test_both_phases_pass_launch_arguments_and_preserve_pid_fixture_binding(self):
        run = self.run
        run.work = self.root
        run.installed = self.root / "BunnyTalks.app"
        run.context = {"runId": "a" * 32}
        launch = {"fixtureId": "b" * 32, "device": "device"}
        binding = {"fixtureId": launch["fixtureId"]}
        stopped = self.root / "stopped-before.json"
        stopped.write_text("{}")
        runner, reader = Mock(device="device", evidence={}), Mock(pid=123)
        reader.poll.return_value = None
        runner.launch_pid.side_effect = [41, 42]
        run.await_startup = Mock()
        with (patch.object(run, "runner", return_value=runner), patch.object(campaign.subprocess, "Popen", return_value=reader),
              patch.object(campaign.os, "killpg"), patch.object(campaign.time, "sleep"),
              patch.object(campaign.time, "monotonic", side_effect=range(50)),
              patch.object(campaign.c2, "get_launch", return_value=launch),
              patch.object(campaign.c2, "load_receipt", return_value={"pid": 41, "binding": binding}),
              patch.object(campaign.c2, "verify_trust_transition") as trust,
              patch.object(campaign.c2, "phase_wire", return_value={"stoppedSha256": campaign.c1.digest(stopped)}),
              patch.object(run, "sample"),
              patch.object(campaign.c2, "observe_installed", side_effect=lambda r, phase, pid, receipt: {"pid": pid}) as installed,
              patch.object(campaign.c2, "phase_binding", return_value=binding),
              patch.object(campaign.c2, "save_receipt") as save, patch.object(campaign.c2, "stop_phase") as stop,
              patch.object(campaign, "phase_messages", return_value=[campaign.MARKER + "DONE"]),
              patch.object(run, "command")):
            for phase, pid in (("before", 41), ("after", 42)):
                run.phase(phase)
                installed.assert_called_with(runner, phase, pid, launch)
                save.assert_called_with(run.work, "installed-" + phase, run.context, binding=binding, pid=pid)
                stop.assert_called_with(runner, run.work, run.context, launch, phase)
                runner.launch_pid.assert_called_with("-BunnyC2Launch",
                                                      f"{phase}:{run.context['runId']}:{launch['fixtureId']}")
                run.await_startup.assert_called_with(runner, reader, run.work / (phase + ".ndjson"),
                                                      f"{campaign.RUN_MARKER}{run.context['runId']} {launch['fixtureId']} {phase}")
            runner.sim.assert_not_called()
            trust.assert_called_once_with(run.work, run.context, binding)
            with self.assertRaisesRegex(campaign.c2.StageError, "candidate-phase-restart-refused"):
                run.phase("after")
            self.assertEqual(runner.launch_pid.call_count, 2)
            # Exercise PID reuse independently of the already-tested receipt replay guard.
            (run.work / "after.ndjson").unlink()
            runner.launch_pid.side_effect = None
            runner.launch_pid.return_value = 41
            with self.assertRaisesRegex(campaign.c2.StageError, "installed-process-mismatch"):
                run.phase("after")
            self.assertEqual(installed.call_count, 2)
        self.assertEqual(run.report["phaseStops"], {"before": "PASS", "after": "PASS"})

    def test_refuses_after_without_stop_trust_or_matching_wire_and_before_after_trust(self):
        run = self.run
        run.work = self.root
        stopped = self.root / "stopped-before.json"
        stopped.write_text("{}")
        with (patch.object(run, "runner") as runner, patch.object(campaign.c2, "get_launch"),
              patch.object(campaign.c2, "phase_binding", return_value={"fixtureId": "fixture"}) as binding,
              patch.object(campaign.c2, "load_receipt", side_effect=campaign.c2.StageError("evidence-unavailable")) as stop,
              patch.object(campaign.c2, "verify_trust_transition",
                           side_effect=campaign.c2.StageError("trust-transition-mismatch")) as trust,
              patch.object(campaign.c2, "phase_wire", return_value={"stoppedSha256": "wrong"})):
            with self.assertRaisesRegex(campaign.c2.StageError, "evidence-unavailable"):
                run.phase("after")
            stop.side_effect = None
            stop.return_value = {"pid": 41, "binding": binding.return_value}
            with self.assertRaisesRegex(campaign.c2.StageError, "trust-transition-mismatch"):
                run.phase("after")
            trust.side_effect = None
            with self.assertRaisesRegex(campaign.c2.StageError, "evidence-phase-mismatch"):
                run.phase("after")
            (self.root / "trust.json").touch()
            with self.assertRaisesRegex(campaign.c2.StageError, "trust-phase-mismatch"):
                run.phase("before")
            runner.assert_not_called()

    def test_unavailable_simulator_command_reports_only_family_operation_and_errno(self):
        fail = Mock(side_effect=FileNotFoundError(2, "private-fixture", "/private/secret/xcrun"))
        runner = campaign.c1.RuntimeRun(self.root, self.run.report_path, {}, command=fail)
        with self.assertRaises(campaign.c2.StageError) as error:
            runner.call("/private/secret/xcrun", "simctl", "boot", code="simulator-boot-failed")
        self.assertEqual(error.exception.record, {
            "verdict": "NOT_RUN", "code": "command-unavailable",
            "command": {"family": "xcrun", "operation": "simulator-boot-failed", "errno": 2},
        })

    def test_cleanup_reports_absence_and_stop_failure_without_skipping_lab(self):
        for state, error in (("absent", None), ("matching", None), ("matching", 3), ("pid-unconfirmed", None)):
            with self.subTest(state=state, error=error):
                run = campaign.Campaign(self.root / "report.json", {})
                run.active, run.phase_pid = True, None if state == "pid-unconfirmed" else 42
                run.scratch, run.context = self.root / "scratch", {}
                run.work = run.scratch / "work"
                (run.work / "simulators").mkdir(parents=True)
                run.fixture = Mock(returncode=0)
                runner = Mock()
                runner.process_status.side_effect = [state, "absent"]
                if error:
                    runner.stop.side_effect = campaign.c2.StageError("stop-refused", exit_code=error)
                with (patch.object(run, "runner", return_value=runner) as attached,
                      patch.object(campaign.c2, "cleanup_simulator") as remove):
                    if error:
                        with self.assertRaises(campaign.c2.StageError) as failure:
                            run.cleanup()
                        record = failure.exception.record
                        self.assertEqual(record["candidateStop"], {
                            "verdict": "FAIL", "state": "absent", "code": "stop-refused", "exitCode": 3,
                        })
                    else:
                        record = run.cleanup()
                        self.assertEqual(record["candidateStop"]["state"],
                                         {"absent": "already-absent", "matching": "explicit-stop",
                                          "pid-unconfirmed": "pid-unconfirmed"}[state])
                    if state == "pid-unconfirmed":
                        attached.assert_not_called()
                    remove.assert_called_once()
                self.assertEqual(runner.stop.call_count, int(state == "matching"))
                self.assertEqual([record[key] for key in ("fixtureStopped", "simulatorRemoved", "workspaceRemoved")],
                                 ["PASS", "PASS", "PASS"])
                self.assertFalse(run.scratch.exists())

    def test_cleanup_failure_preserves_original_runtime_verdict(self):
        run = self.run
        for name, action in run.steps():
            if name != "candidateRuntime":
                setattr(run, action.__name__, Mock(return_value={}))
        run.runtime = Mock(side_effect=campaign.c2.StageError("candidate-js-marker-missing", verdict="NOT_RUN"))
        run.cleanup_candidate = Mock(return_value={"verdict": "FAIL", "code": "stop-refused", "exitCode": 3})
        self.assertEqual(run.run(), 1)
        report = json.loads(run.report_path.read_text())
        self.assertEqual(report["candidateRuntime"], "NOT_RUN")
        self.assertEqual(report["stages"]["candidateRuntime"]["code"], "candidate-js-marker-missing")
        self.assertEqual(report["stages"]["cleanup"]["candidateStop"]["exitCode"], 3)

    def test_candidate_provenance_refusal_crosses_gate_without_installation(self):
        run = self.run
        run.scratch = self.root / "scratch"
        output = run.scratch / "candidate-build"
        output.mkdir(parents=True)
        run.work = run.scratch / "work"
        run.context = {"revision": "a" * 40, "treeSha256": "b" * 64}
        run.inputs = {}
        for name in ("revision", "source", "archive", "toolchain", "simulator", "start_fixture", "prebuild", "build"):
            setattr(run, name, Mock(return_value={}))
        run.install = Mock()
        run.runtime = Mock()

        def inspect(*args, output, **kwargs):
            self.assertIn("--candidate-only", args)
            output.write_text(json.dumps({"verdict": "FAIL", "code": "standard-inspection-rejected"}))
            return campaign.c1.CommandResult(1)

        runner = Mock()
        runner.call.side_effect = inspect
        with (patch.object(campaign.c2, "simulator", return_value=runner),
              patch.object(campaign.c2, "cleanup_simulator"),
              patch.object(campaign, "collect_commands", return_value={})):
            self.assertEqual(run.run(), 1)
        report = json.loads(run.report_path.read_text())
        failure = report["stages"]["candidateProvenance"]
        self.assertEqual((failure["verdict"], failure["code"]), ("FAIL", "standard-inspection-rejected"))
        run.install.assert_not_called()
        run.runtime.assert_not_called()
        self.assertEqual(report["stages"]["cleanup"]["verdict"], "PASS")
        self.assertFalse(run.scratch.exists())

    def test_install_requires_provenance_and_matching_built_and_installed_bytes(self):
        run = self.run
        run.scratch = self.root
        built = self.root / "candidate-build/DerivedData/Build/Products/Release-iphonesimulator/BunnyTalks.app"
        built.mkdir(parents=True)
        runner = Mock()
        runner.device_set = self.root / "simulators"
        runner.device = "fixture"
        installed = runner.device_set / runner.device / "BunnyTalks.app"
        runner.sim.return_value.output = str(installed)
        identity = {"bundleId": campaign.c2.APP_IDS["candidate"], "executableSha256": "a" * 64,
                    "hermesBundleSha256": "b" * 64}
        launch = {"qualificationScope": campaign.c2.CANDIDATE_SCOPE, "builds": {"candidate": identity}}
        with (patch.object(campaign.c2, "get_launch", return_value=launch),
              patch.object(run, "runner", return_value=runner)):
            with self.assertRaisesRegex(campaign.c2.StageError, "candidate-provenance-unavailable"):
                run.install()
            runner.sim.assert_not_called()
            launch["provenance"] = {"ats": "default"}
            with self.assertRaisesRegex(campaign.c2.StageError, "candidate-provenance-unavailable"):
                run.install()
            runner.sim.assert_not_called()
            launch["provenance"].update(dict.fromkeys(
                (*campaign.c2.CANDIDATE_RELEASE_KEYS, "nativeSources", "targetedSymbols",
                 "transportLinkSelectionSha256"), "fixture"))
            runner.app_hashes.return_value = identity | {"hermesBundleSha256": "c" * 64}
            with self.assertRaisesRegex(campaign.c2.StageError, "candidate-build-mismatch"):
                run.install()
            runner.sim.assert_not_called()
            runner.app_hashes.side_effect = [identity, identity | {"executableSha256": "d" * 64}]
            with self.assertRaisesRegex(campaign.c2.StageError, "installed-app-mismatch"):
                run.install()
            self.assertIsNone(run.installed)
            runner.app_hashes.side_effect = [identity, identity]
            self.assertEqual(run.install(), identity)

    def test_success_report_only_qualifies_candidate(self):
        run = self.run
        for _, action in run.steps():
            setattr(run, action.__name__, Mock(return_value={}))
        run.cleanup = Mock(return_value={})
        self.assertEqual(run.run(), 0)
        run.build.assert_called_once_with()
        report = json.loads(run.report_path.read_text())
        self.assertEqual(report["scope"], campaign.c2.CANDIDATE_SCOPE)
        self.assertEqual(report["verdict"], "PASS")
        self.assertEqual(report["candidateRuntime"], "PASS")
        self.assertEqual(report["nativeEquivalence"], "NOT_RUN")
        self.assertEqual(report["standardHttpsRuntime"], "NOT_RUN")
        self.assertEqual(report["fullConfinement"], "NOT_RUN")
        self.assertNotIn("standardBuild", report["stages"])

    def test_object_diagnostics_publish_digests_without_bytes(self):
        object_path = self.root / "BunnyHttpsNative.o"
        data_offset = 32 + 72 + 80
        object_path.write_bytes(
            struct.pack("<8I", 0xFEEDFACF, 0x0100000C, 0, 1, 1, 152, 0, 0)
            + struct.pack("<II16s4Q4I", 0x19, 152, b"", 0, 0, 0, 0, 0, 0, 1, 0)
            + struct.pack("<16s16s2Q8I", b"__text", b"__TEXT", 0, 4, data_offset, 0, 0, 0, 0, 0, 0, 0)
            + b"test"
        )
        sections = campaign.c2.object_fingerprints(object_path)
        self.assertEqual(sections["__TEXT/__text"]["size"], 4)
        self.assertEqual(len(sections["__TEXT/__text"]["bytesSha256"]), 64)


if __name__ == "__main__":
    unittest.main()
