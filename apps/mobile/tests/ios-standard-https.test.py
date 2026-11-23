"""Exercise the C2 preparation and evidence gates without Apple tools or network."""

import copy
import importlib.util
import json
import os
import plistlib
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


script = Path(__file__).resolve().parents[1] / "scripts/prepare-ios-standard-https.py"
spec = importlib.util.spec_from_file_location("standard_https", script)
c2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c2)
REVISION = "a" * 40
DIGEST = "b" * 64


class StandardHttpsTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()

    def test_reviewed_revision_and_environment_gate(self):
        c2.validate_revision(REVISION, REVISION)
        for revision in ("a" * 39, "c" * 40, "invalid"):
            with self.subTest(revision=revision):
                with self.assertRaises(c2.StageError) as error:
                    c2.validate_revision(revision, REVISION)
                self.assertEqual(error.exception.record["code"], "reviewed-sha-mismatch")
        for name in ("BUNNY_HTTPS_QUALIFICATION", "BUNNY_IOS_HTTPS_QUALIFICATION",
                     "SIMCTL_CHILD_SSL_CERT_FILE", "SSL_CERT_FILE", "EXPO_PUBLIC_USE_RN_FETCH"):
            with self.subTest(name=name), self.assertRaises(c2.StageError):
                c2.check_environment({name: "0"})

    def test_zip_missing_or_divergent_rejected(self):
        archive = self.root / "input.zip"
        for exists in (False, True):
            if exists:
                archive.write_bytes(b"wrong bytes")
            with self.assertRaises(c2.StageError) as error:
                c2.verify_archive(archive)
            self.assertEqual(error.exception.record["code"], "archive-rejected")

    def make_source(self):
        source = self.root / "export"
        mobile = source / c2.MOBILE_RELATIVE
        (mobile / "src").mkdir(parents=True)
        for name in ("app.json", "package.json", "metro.config.js", "index.ts", "qualification"):
            if name == "qualification":
                (mobile / name).mkdir()
                continue
            shutil.copy2(c2.MOBILE / name, mobile / name)
        for name in (c2.inspection.CANDIDATE_ENTRY, "qualification/ios-libcurl-scenarios.ts"):
            shutil.copy2(c2.MOBILE / name, mobile / name)
        native = mobile / c2.NATIVE
        (native / "Native").mkdir(parents=True)
        for path in c2.SOURCES:
            shutil.copy2(c2.MOBILE / c2.NATIVE / path, native / path)
        return source

    def test_exact_delta_and_workspace_ownership(self):
        source = self.make_source()
        work = self.root / "run"
        reviewed = c2.manifest(source)
        pin = c2.tree_digest(reviewed)
        with patch.object(c2.vendor, "install_zip") as install:
            proof = c2.stage_pair(source, work, pin, b"vendor fixture", REVISION)
        self.assertEqual(install.call_count, 2)
        self.assertEqual(c2.manifest(work / "standard"), reviewed)
        self.assertEqual(c2.changed_files(reviewed, c2.manifest(work / "candidate")), c2.CHANGES)
        self.assertEqual(c2.c1.read_json(work / "candidate" / c2.CONFIG)["expo"]["ios"]["bundleIdentifier"],
                         c2.APP_IDS["candidate"])
        self.assertEqual(c2.c1.read_json(work / "candidate" / c2.PACKAGE)["main"],
                         c2.inspection.CANDIDATE_ENTRY)
        with self.assertRaises(c2.StageError):
            c2.remove_workspace(work, self.context(proof) | {"runId": "0" * 32})
        self.assertTrue(work.is_dir())
        self.assertTrue(c2.remove_workspace(work, self.context(proof)))
        self.assertTrue(source.is_dir())

    def test_unreviewed_native_file_and_certificate_refused(self):
        source = self.make_source()
        work = self.root / "run"
        pin = c2.tree_digest(c2.manifest(source))
        transport = source / c2.MOBILE_RELATIVE / c2.NATIVE / "CurlHttpsTransport.swift"
        transport.write_text(transport.read_text() + "\n// changed")
        with self.assertRaises(c2.StageError) as error:
            c2.stage_pair(source, work, pin, b"fixture", REVISION)
        self.assertEqual(error.exception.record["code"], "reviewed-tree-mismatch")
        entry = source / c2.MOBILE_RELATIVE / c2.inspection.CANDIDATE_ENTRY
        entry.write_bytes(b"-----BEGIN CERTIFICATE-----\n" + b"A" * 40)
        updated = c2.tree_digest(c2.manifest(source))
        with self.assertRaisesRegex(c2.inspection.CheckFailed, "certificate-or-key-payload"):
            c2.stage_pair(source, work, updated, b"fixture", REVISION)
        self.assertFalse(work.exists())

    @unittest.skipUnless(os.environ.get("BUNNY_IOS_XCFRAMEWORK_ZIP"), "approved ZIP not supplied")
    def test_original_zip_can_stage_both_apps(self):
        source = self.make_source()
        work = self.root / "run"
        raw, proof = c2.verify_archive(Path(os.environ["BUNNY_IOS_XCFRAMEWORK_ZIP"]))
        self.assertEqual(proof["zipSha256"], c2.vendor.ZIP_SHA256)
        tree = c2.tree_digest(c2.manifest(source))
        result = c2.stage_pair(source, work, tree, raw, REVISION)
        for name in c2.APP_IDS:
            self.assertEqual(c2.c1.digest(work / name / c2.MOBILE_RELATIVE / c2.NATIVE /
                                         "vendor/xcframeworks.zip"), proof["zipSha256"])
        self.assertTrue(c2.remove_workspace(work, self.context(result)))

    def test_effective_compile_arguments_and_response_files(self):
        def record(root):
            root.mkdir()
            derived = root / "out"
            derived.mkdir()
            response = derived / "c.rsp"
            response.write_text("-DCURL_STATICLIB=1 -I " + str(root / "Headers"))
            args = ["-target", "arm64-apple-ios16.4-simulator",
                    "-isysroot", "/Xcode/iPhoneSimulator.sdk", "-O"]
            commands = {
                "c": [["clang", *args, "@" + str(response), str(root / "BunnyHttpsNative.c")]],
                "swift": [["swiftc", *args, str(root / "ApplicationHttpsModule.swift"),
                           str(root / "CurlHttpsTransport.swift")]],
            }
            return c2.compile_commands(commands, root, derived), commands, derived, response

        left, *_ = record(self.root / "standard")
        right, commands, derived, response = record(self.root / "candidate")
        self.assertEqual(left, right)
        response.write_text(response.read_text() + " -DBUNNY_HTTPS_QUALIFICATION=0")
        with self.assertRaises(c2.StageError) as error:
            c2.compile_commands(commands, derived.parent, derived)
        self.assertEqual(error.exception.record["code"], "qualification-flags")

    def compiled(self, name):
        return {
            "release": {"bundleId": c2.APP_IDS[name], "verdict": "PASS",
                        "transportLinkSelection": [["libcurl.a", "object.o"]],
                        "linkedArchiveSha256": {"libcurl.a": DIGEST}, **dict.fromkeys(c2.BUILD_KEYS, DIGEST)},
            "nativeSources": {source: DIGEST for source in c2.SOURCES},
            "commands": {"swift": [["swiftc", "-O"]], "c": [["clang", "-Os"]]},
            "objects": dict.fromkeys(c2.OBJECTS, DIGEST),
        }

    def test_equivalence_distinguishes_relevant_delta_and_insufficient_proof(self):
        std, candidate = self.compiled("standard"), self.compiled("candidate")
        candidate["release"]["executableSha256"] = "d" * 64
        self.assertEqual(c2.compare_builds(std, candidate)["candidate"]["executableSha256"], "d" * 64)
        for key, value, verdict in (("objects", {c2.OBJECTS[0]: DIGEST}, "NOT_RUN"),
                                    ("objects", dict.fromkeys(c2.OBJECTS, "e" * 64), "NOT_RUN"),
                                    ("commands", {"swift": [["swiftc", "-Onone"]]}, "FAIL")):
            changed = copy.deepcopy(candidate)
            changed[key] = value
            with self.subTest(key=key, verdict=verdict), self.assertRaises(c2.StageError) as error:
                c2.compare_builds(std, changed)
            self.assertEqual(error.exception.record["verdict"], verdict)
        candidate["release"]["bundleId"] = c2.APP_IDS["standard"]
        with self.assertRaises(c2.StageError) as error:
            c2.compare_builds(std, candidate)
        self.assertEqual(error.exception.record["code"], "release-identity")

    @staticmethod
    def context(proof):
        return {key: proof[key] for key in ("runId", "treeSha256", "revision", "zipSha256")}

    def test_installed_executable_and_pid_are_checked_against_prelaunch(self):
        device_set = self.root / "simulators"
        device = "12345678-1234-1234-1234-123456789abc"
        app = device_set / device / "BunnyTalks.app"
        app.mkdir(parents=True)
        executable = app / c2.c1.EXECUTABLE
        bundle = app / "main.jsbundle"
        executable.write_bytes(b"simulated executable")
        bundle.write_bytes(b"simulated Hermes")
        bundle_id = c2.APP_IDS["candidate"]
        (app / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": bundle_id, "CFBundleExecutable": c2.c1.EXECUTABLE,
        }))
        receipt = {"builds": {"candidate": {
            "bundleId": bundle_id, "executableSha256": c2.c1.digest(executable),
            "hermesBundleSha256": c2.c1.digest(bundle),
        }}}
        def command(args, **_):
            self.assertEqual(args[:4], ("xcrun", "simctl", "--set", str(device_set)))
            self.assertEqual(args[4:], ("get_app_container", device, bundle_id, "app"))
            return c2.c1.CommandResult(0, str(app))
        runner = c2.simulator(self.root, {"runId": "a" * 32}, command=command)
        runner.device = device
        with patch.object(c2.c1, "process_path", return_value=executable):
            self.assertEqual(c2.observe_installed(runner, "before", 42, receipt)["pid"], 42)
            bundle.write_bytes(b"altered")
            with self.assertRaises(c2.StageError) as error:
                c2.observe_installed(runner, "before", 42, receipt)
            self.assertEqual(error.exception.record["code"], "installed-app-mismatch")
        bundle.write_bytes(b"simulated Hermes")
        for path, expected in ((None, "NOT_RUN"), (app / "other", "FAIL")):
            with patch.object(c2.c1, "process_path", return_value=path), self.assertRaises(c2.StageError) as error:
                c2.observe_installed(runner, "before", 42, receipt)
            self.assertEqual(error.exception.record["verdict"], expected)

    def network(self, work, context, window, **overrides):
        observations = {}
        for name in ("boundary", "interfaces", "ipv4", "ipv6", "packetObservation"):
            raw = work / (window + "-" + name + ".txt")
            raw.write_text("simulated " + name)
            observations[name] = {"path": raw.name, "sha256": c2.c1.digest(raw)}
        return {"scope": "network-" + window, "context": context, "profile": "full", "method": "physical",
                "reviewed": True, "outsideReachable": False, "outsidePackets": 0,
                "observations": observations, **overrides}

    def test_network_observation_never_confers_full_confinement(self):
        context = {"runId": "a" * 32}
        controls = self.network(self.root, context, "before-build")
        judge = lambda data: c2.verify_confinement(data, self.root, context, window="before-build")
        self.assertEqual(judge(controls)["fullConfinement"], "PASS")
        limited = judge(controls | {"profile": "hosted-observed"})
        self.assertEqual(limited["fullConfinement"], "NOT_RUN")
        with self.assertRaises(c2.StageError) as error:
            c2.require_full(limited)
        self.assertEqual(error.exception.record["verdict"], "NOT_RUN")
        for change, expected in (({"outsidePackets": 1}, "FAIL"), ({"outsideReachable": True}, "FAIL"),
                                 ({"reviewed": False}, "NOT_RUN"), ({"observations": {}}, "NOT_RUN"),
                                 ({"context": {"runId": "b" * 32}}, "FAIL")):
            with self.subTest(change=change), self.assertRaises(c2.StageError) as error:
                judge(controls | change)
            self.assertEqual(error.exception.record["verdict"], expected)

    def test_orchestration_interruptions_partial_and_cleanup(self):
        for stage, failure, cleaned, expected in (
            (None, None, True, "PASS"),
            ("archive", KeyboardInterrupt, True, "NOT_RUN"),
            ("candidateRuntime", KeyboardInterrupt, True, "NOT_RUN"),
            ("confinement", c2.StageError("confinement-violation"), True, "FAIL"),
            ("nativeEquivalence", c2.StageError("native-objects-unavailable", verdict="NOT_RUN"), True, "NOT_RUN"),
            (None, None, False, "FAIL"),
        ):
            called = []

            def act(name):
                def action(_report):
                    called.append(name)
                    if name == stage:
                        raise failure
                    return {}
                return action

            def cleanup():
                called.append("cleanup")
                return cleaned

            with self.subTest(stage=stage, cleaned=cleaned):
                actions = {name: act(name) for name in c2.STAGES[1:-1]}
                result = c2.run_protocol(actions, REVISION, REVISION, cleanup)
                self.assertEqual(result["verdict"], expected)
                self.assertEqual(result["standardHttpsRuntime"], "NOT_RUN")
                self.assertEqual(called[-1], "cleanup")
                if stage == "archive":
                    self.assertNotIn("staging", called)
                if stage == "confinement":
                    self.assertNotIn("installation", called)
                if stage == "candidateRuntime":
                    self.assertIn("stop", called)

    def test_prebuild_gates_both_expensive_builds_and_rejects_stale_receipts(self):
        source, work = self.make_source(), self.root / "run"
        tree = c2.tree_digest(c2.manifest(source))
        def install(vendor, archive):
            vendor.mkdir()
            (vendor / "xcframeworks.zip").write_bytes(archive)
        with patch.object(c2.vendor, "install_zip", side_effect=install):
            context = self.context(c2.stage_pair(source, work, tree, b"fixture zip", REVISION))
        device = "12345678-1234-1234-1234-123456789abc"
        environment = c2.save_receipt(work, "environment", context, device=device, target="full",
                                      toolchain={}, simulator={}, freeBytes=1000)
        payload = {"reviewedSource": str(source), "workspace": str(work), "context": context,
                   "archive": "private.zip", "confinement": self.network(work, context, "before-build"),
                   "finalConfinement": self.network(work, context, "through-stop")}
        payload["builds"] = {name: dict.fromkeys(("derived", "sourceMap", "podSettings", "compileCommands"), "private")
                             for name in c2.APP_IDS}
        input_path = work / "private.json"
        input_path.write_text(json.dumps(payload))
        args = SimpleNamespace(mode="prelaunch", input=input_path, reviewed_revision=REVISION,
                               reviewed_tree_sha256=tree)

        def digest(path):
            return c2.vendor.ZIP_SHA256 if path.name == "xcframeworks.zip" else original_digest(path)

        original_digest = c2.c1.digest
        with (patch.object(c2.c1, "digest", side_effect=digest),
              patch.object(c2, "verify_archive", return_value=(b"fixture zip", {"zipSha256": c2.vendor.ZIP_SHA256})),
              patch.object(c2, "verify_lab_ready") as live,
              patch.object(c2, "inspect_build", side_effect=lambda *args, name: self.compiled(name)) as inspect):
            with self.assertRaises(c2.StageError) as error:
                c2.review(args)
            self.assertEqual(error.exception.record["verdict"], "NOT_RUN")
            args.mode = "prebuild"
            with self.assertRaises(c2.StageError):
                c2.review(args)
            self.assertEqual(inspect.call_count, 0)

            fixture = {"scope": "fixture", "context": context, "environmentDevice": device,
                       "environmentSha256": digest(work / "environment.json"), "fixtureId": "f" * 32,
                       "bindings": [{"address": "127.0.0.1", "port": port} for port in c2.PORTS],
                       "leafSha256": DIGEST, "rootSha256": DIGEST,
                       "initialCounters": {"connections": 0, "requests": 0}}
            fixture_file = work / "fixture.json"
            for change, reason in (({"context": context | {"runId": "c" * 32}}, "evidence-run-mismatch"),
                                   ({"bindings": []}, "fixture-nonconforming")):
                fixture_file.write_text(json.dumps(fixture | change))
                with self.assertRaises(c2.StageError) as error:
                    c2.review(args)
                self.assertEqual(error.exception.record["code"], reason)
            environment_file = work / "environment.json"
            environment_file.write_text(json.dumps(environment | {"target": "hosted-observed"}))
            fixture_file.write_text(json.dumps(fixture | {"environmentSha256": digest(environment_file)}))
            with self.assertRaises(c2.StageError) as error:
                c2.review(args)
            self.assertEqual(error.exception.record["code"], "hosted-feasibility-only")
            live.assert_not_called()

            environment_file.write_text(json.dumps(environment))
            fixture_file.write_text(json.dumps(fixture | {"environmentSha256": digest(environment_file)}))
            live.side_effect = c2.StageError("fixture-readiness-unconfirmed", verdict="NOT_RUN")
            with self.assertRaises(c2.StageError):
                c2.review(args)
            self.assertEqual(inspect.call_count, 0)
            live.side_effect = None
            live.reset_mock()
            gate = c2.review(args)
            self.assertEqual(gate["scope"], "prebuild")
            args.mode = "prelaunch"
            launch = c2.review(args)
            self.assertEqual(launch["scope"], "prelaunch")
            self.assertEqual(inspect.call_count, 2)
            self.assertEqual(live.call_count, 2)

    def test_boot_failure_uses_c1_owned_cleanup(self):
        context = {"runId": "a" * 32}
        runner = c2.simulator(self.root, context)
        with (patch.object(c2, "simulator", return_value=runner),
              patch.object(runner, "verify_toolchain"), patch.object(runner, "find_runtime"),
              patch.object(runner, "boot", side_effect=c2.c1.Interrupted) as boot,
              patch.object(runner, "cleanup_device", return_value=None) as cleanup):
            with self.assertRaises(c2.StageError):
                c2.boot_environment(self.root, context, None)
            boot.assert_not_called()
            with self.assertRaises(c2.c1.Interrupted):
                c2.boot_environment(self.root, context, None, hosted_feasibility=True)
        cleanup.assert_called_once()
        self.assertFalse((self.root / "environment.json").exists())

    def test_tls_phases_bind_stopped_process_logs_and_fixture_to_prelaunch(self):
        context = {"runId": "a" * 32}
        fixture = "b" * 32
        release = {"bundleId": c2.APP_IDS["candidate"], **dict.fromkeys(c2.BUILD_KEYS[:2], DIGEST)}
        launch = c2.save_receipt(self.root, "prelaunch", context, fixtureId=fixture,
                                 device="device", builds={"candidate": release})
        binding = c2.phase_binding(self.root, launch)
        c2.save_receipt(self.root, "fixture", context, fixtureId=fixture, rootSha256=DIGEST)
        for pid, phase in enumerate(c2.PHASES, start=42):
            name = "installed-" + phase
            c2.save_receipt(self.root, name, context, binding=binding, device="device", phase=phase,
                            pid=pid, **release)
            stopped = "stopped-" + phase
            c2.save_receipt(self.root, stopped, context, pid=pid, binding=binding,
                            installedSha256=c2.c1.digest(self.root / (name + ".json")))
            log = self.root / (phase + ".log")
            log.write_text(f"[BunnyIosStandardHttpsRun] {context['runId']} {fixture} {phase}\n")
            c2.save_receipt(self.root, phase + "-wire", context, binding=binding, fixtureId=fixture,
                            stoppedSha256=c2.c1.digest(self.root / (stopped + ".json")),
                            logSha256=c2.c1.digest(log))
        c2.save_receipt(self.root, "trust", context, binding=binding, rootSha256=DIGEST,
                        beforeWireSha256=c2.c1.digest(self.root / "before-wire.json"))
        self.assertEqual(c2.verify_phases(self.root, context, launch)[0]["after"]["pid"], 43)
        wire = self.root / "after-wire.json"
        wire.write_text(json.dumps(c2.c1.read_json(wire) | {"context": {"runId": "c" * 32}}))
        with self.assertRaises(c2.StageError) as error:
            c2.verify_phases(self.root, context, launch)
        self.assertEqual(error.exception.record["code"], "evidence-run-mismatch")

if __name__ == "__main__":
    unittest.main()
