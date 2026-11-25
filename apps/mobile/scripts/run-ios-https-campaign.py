"""Build and qualify one candidate Release on the hosted lab."""

import argparse
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time


MOBILE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("hosted_lab", MOBILE / "scripts/run-ios-hosted-feasibility.py")
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)
c2, c1 = lab.c2, lab.c1
require = c2.require
DRIVER = MOBILE / "scripts/prepare-ios-standard-https.py"
PILOT = MOBILE / "qualification/run-ios-libcurl-runtime.mjs"
GIB = 1024**3
MARKER = "[BunnyIosStandardHttps] "
STARTUP = "[BunnyIosCandidateStartup] "
RUN_MARKER = "[BunnyIosStandardHttpsRun] "
COMPILE_TASKS = ("CompileC", "SwiftDriver", "SwiftCompile")


def collect_commands(log):
    """Read invocations from executed Xcode tasks. Never use showBuildSettings as argv."""
    commands = {"c": [], "swift": []}
    tasks = {name: {"headers": 0, "invocationLines": 0, "acceptedInvocations": 0}
             for name in COMPILE_TASKS}

    def unavailable(code, point):
        error = c2.StageError(code, verdict="NOT_RUN")
        error.record["commandCollection"] = {
            "point": point, "tasks": tasks, "missingLanguages": [name for name, rows in commands.items() if not rows],
        }
        return error

    try:
        if log.stat().st_size > 64 * 1024**2:
            raise unavailable("build-transcript-too-large", "transcript-size")
        rows = log.open(encoding="utf-8", errors="replace")
    except OSError:
        raise unavailable("build-transcript-unavailable", "transcript-open") from None
    with rows:
        task = None
        for line in rows:
            if line and not line[0].isspace():
                task = None
                if "(in target 'ApplicationHttps' from project 'Pods')" in line:
                    task = line.split(maxsplit=1)[0]
                    if task in tasks:
                        tasks[task]["headers"] += 1
                continue
            row = line.strip()
            if task not in tasks or not re.match(
                r"""(?:/(?:\\.|[^\s\\])*/(?:clang|clang-cc|swiftc|swift-frontend)|["']/[^"'\r\n]+/"""
                r"""(?:clang|clang-cc|swiftc|swift-frontend)["']|builtin-(?:SwiftDriver|swiftTaskExecution))\s""", row,
            ):
                continue
            tasks[task]["invocationLines"] += 1
            try:
                argv = shlex.split(row)
            except ValueError:
                raise unavailable("compile-transcript-unreadable", task + "-argument-parsing") from None
            if argv[0] in ("builtin-SwiftDriver", "builtin-swiftTaskExecution") and "--" in argv:
                argv = argv[argv.index("--") + 1:]
            if not argv or not Path(argv[0]).is_absolute():
                continue
            tool = Path(argv[0]).name
            if (task == "CompileC" and tool in ("clang", "clang-cc") and "-c" in argv
                    and any(arg.endswith("/BunnyHttpsNative.c") for arg in argv)):
                commands["c"].append(argv)
                tasks[task]["acceptedInvocations"] += 1
            if ((task == "SwiftDriver" and tool == "swiftc") or
                    (task == "SwiftCompile" and tool == "swift-frontend" and "-c" in argv)):
                commands["swift"].append(argv)
                tasks[task]["acceptedInvocations"] += 1
    if not all(commands.values()):
        raise unavailable("compile-evidence-incomplete", "missing-invocations")
    return commands


def external_peer(fields, pid):
    rows = fields.splitlines()
    if not rows or [row for row in rows if row.startswith("p")] != [f"p{pid}"]:
        return False
    for row in rows:
        if not row.startswith("n") or "->" not in row:
            continue
        host, _, port = row.split("->", 1)[1].rpartition(":")
        if not port.isdecimal():
            continue
        try:
            address = ipaddress.ip_address(host.strip("[]").split("%", 1)[0])
        except ValueError:
            continue
        if not (getattr(address, "ipv4_mapped", None) or address).is_loopback:
            return True
    return False


def phase_messages(path, pid):
    require(path.stat().st_size <= 1024**2, "phase-log-too-large", verdict="NOT_RUN")
    messages = []
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            if not line.endswith("\n"):
                break
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict) and row.get("processID") == pid:
                messages.append(row.get("eventMessage"))
    return messages


class Campaign(lab.Feasibility):
    def __init__(self, report_path, env):
        super().__init__(report_path, env)
        self.process_env.update(CI="true", EXPO_NO_DOTENV="1", EXPO_OFFLINE="1", EXPO_NO_GIT_STATUS="1",
                                COREPACK_ENABLE_DOWNLOAD_PROMPT="0", COCOAPODS_DISABLE_STATS="true")
        self.process_env.setdefault("LANG", "en_US.UTF-8")
        self.report.update(scope=c2.CANDIDATE_SCOPE, profile="hosted-observed",
                           networkObservation={"verdict": "NOT_RUN",
                                               "method": "candidate-pid-socket-sampling", "samples": 0},
                           phaseStops={"before": "NOT_RUN", "after": "NOT_RUN"})
        self.report["stages"] = {name: {"verdict": "NOT_RUN"} for name, _ in self.steps()}
        self.report["stages"]["cleanup"] = {"verdict": "NOT_RUN"}
        self.inputs = None
        self.installed = None
        self.active = False
        self.phase_pid = None

    def steps(self):
        return (("revision", self.revision), ("source", self.source), ("archive", self.archive),
                ("toolchain", self.toolchain), ("simulator", self.simulator), ("fixture", self.start_fixture),
                ("prebuild", self.prebuild), ("candidateBuild", self.build), ("candidateProvenance", self.prelaunch),
                ("installation", self.install), ("candidateRuntime", self.runtime))

    def stage(self, name, action):
        try:
            return super().stage(name, action)
        finally:
            if name == "candidateRuntime":
                self.report[name] = self.report["stages"][name]["verdict"]
                self.save()

    def revision(self):
        require(self.env.get("HOSTED_OBSERVED") == "true", "hosted-profile-not-approved")
        return super().revision()

    def archive(self):
        return super().archive(candidate_only=True)

    def gate(self, mode):
        input_path = self.scratch / "inputs.json"
        input_path.write_text(json.dumps(self.inputs))
        output = self.scratch / (mode + "-result.json")
        runner = c2.simulator(self.work, self.context, command=self.isolated_command)
        try:
            command = runner.call(sys.executable, "-IB", str(DRIVER), mode, str(input_path),
                                  "--reviewed-revision", self.context["revision"],
                                  "--reviewed-tree-sha256", self.context["treeSha256"], "--hosted-observed", "--candidate-only",
                                  output=output, timeout=240, allowed=(0, 1, 2), code=mode + "-failed")
        except c2.StageError as error:
            if mode == "prelaunch" and error.record["code"] == "command-timeout":
                raise c2.StageError("candidate-inspection-timeout", verdict="NOT_RUN") from None
            raise
        if command.exit_code:
            record = c1.read_json(output)
            error = c2.StageError(mode + "-rejected", verdict="FAIL" if command.exit_code == 1 else "NOT_RUN")
            if re.fullmatch(r"[a-z0-9-]{1,64}", record.get("code", "")):
                error.record["code"] = record["code"]
            raise error
        return c2.load_receipt(self.work, mode, self.context)

    def space(self, minimum):
        free = shutil.disk_usage(self.scratch).free // GIB
        require(free >= minimum, "insufficient-build-space", verdict="NOT_RUN")
        return free

    def prebuild(self):
        self.inputs = {"workspace": str(self.work), "reviewedSource": str(self.scratch / "source"),
                       "archive": str(self.scratch / "xcframeworks.zip"), "context": self.context, "builds": {}}
        self.gate("prebuild")
        free = self.space(10)
        self.process_env["COREPACK_HOME"] = str(self.scratch / "corepack")
        runner = c2.simulator(self.work, self.context, command=self.isolated_command)
        runner.call("corepack", "enable", code="corepack-failed")
        require(runner.call("pnpm", "--version", capture=True, timeout=120,
                            code="pnpm-unavailable").output == "10.34.9", "pnpm-version-mismatch")
        return {"freeGiB": free, "pnpm": "10.34.9"}

    def build(self):
        gate = c2.load_receipt(self.work, "prebuild", self.context)
        require(gate.get("qualificationScope") == c2.CANDIDATE_SCOPE, "prebuild-scope-mismatch")
        environment = c2.load_receipt(self.work, "environment", self.context)
        c2.verify_lab_ready(self.work, self.context, environment, command=self.isolated_command)
        root = self.work / "candidate"
        mobile = root / c2.MOBILE_RELATIVE
        ios = mobile / "ios"
        output = self.scratch / "candidate-build"
        output.mkdir()
        runner = c2.simulator(self.work, self.context, command=self.isolated_command)
        runner.call("pnpm", "install", "--frozen-lockfile", "--store-dir", str(self.scratch / "pnpm-store"),
                    cwd=root, timeout=360, code="dependency-install-failed")
        runner.call("pnpm", "--filter", "@bunny-talks/mobile^...", "run", "--if-present", "build",
                    cwd=root, timeout=180, code="package-build-failed")
        runner.call("pnpm", "exec", "expo", "prebuild", "--platform", "ios", "--no-install", "--no-clean",
                    cwd=mobile, timeout=180, code="expo-prebuild-failed")
        c2.inspection.check_generated(ios, bundle_id=c2.APP_IDS["candidate"])
        runner.call("pod", "install", cwd=ios, timeout=600, code="pods-install-failed")
        settings = output / "pod-settings.json"
        runner.call("xcodebuild", "-project", "Pods/Pods.xcodeproj", "-target", "ApplicationHttps",
                    "-target", "ExpoSQLite", "-configuration", "Release", "-sdk", "iphonesimulator",
                    "-showBuildSettings", "-json", cwd=ios, output=settings, timeout=120, code="pod-settings-unavailable")
        c2.inspection.check_pod_settings(c1.read_json(settings))
        free = self.space(4)
        try:
            runner.compile_release(ios, output, verbose=True)
        except c2.StageError as error:
            try:
                error.record["buildDiagnostics"] = runner.collect_build_diagnostics(output, error.record.get("exitCode"))
            except c1.Interrupted:
                error.record["buildDiagnostics"] = {"verdict": "NOT_RUN", "reason": "interrupted"}
            raise
        self.inputs["builds"]["candidate"] = {"derived": str(output / "DerivedData"),
                                              "sourceMap": str(output / "bundle.map"), "podSettings": str(settings),
                                              "compileCommands": str(output / "commands.json")}
        return {"compilation": "PASS", "freeGiBBeforeCompile": free}

    def prelaunch(self):
        output = self.scratch / "candidate-build"
        commands = output / "commands.json"
        point = "transcript-read"
        try:
            captured = collect_commands(output / "xcodebuild.log")
            point = "evidence-write"
            commands.write_text(json.dumps(captured))
        except OSError:
            error = c2.StageError("command-evidence-io-failed", verdict="NOT_RUN")
            error.record["commandCollection"] = {"point": point}
            raise error from None
        launch = self.gate("prelaunch")
        return {**launch["provenance"], "identity": launch["builds"]["candidate"]}

    def runner(self):
        runner = c2.simulator(self.work, self.context, command=self.isolated_command)
        c2.attach_device(runner, c2.load_receipt(self.work, "environment", self.context))
        return runner

    def install(self):
        launch = c2.get_launch(self.work, self.context)
        require(launch.get("qualificationScope") == c2.CANDIDATE_SCOPE, "prelaunch-scope-mismatch")
        provenance = launch.get("provenance")
        require(isinstance(provenance, dict) and all(provenance.get(key) for key in (
            *c2.CANDIDATE_RELEASE_KEYS, "nativeSources", "targetedSymbols", "transportLinkSelectionSha256")),
            "candidate-provenance-unavailable", verdict="NOT_RUN")
        products = self.scratch / "candidate-build/DerivedData/Build/Products/Release-iphonesimulator"
        apps = list(products.glob("*.app"))
        require(apps, "candidate-product-unavailable", verdict="NOT_RUN")
        require(len(apps) == 1, "candidate-product-ambiguous")
        runner = self.runner()
        bundle = c2.APP_IDS["candidate"]
        expected = launch["builds"]["candidate"]
        require(expected.get("bundleId") == bundle, "candidate-build-mismatch")
        require(all(c2.hex_value(expected.get(key)) for key in c2.BUILD_KEYS[:2]),
                "candidate-fingerprints-unavailable", verdict="NOT_RUN")
        identity = {key: expected[key] for key in ("bundleId", *c2.BUILD_KEYS[:2])}
        require(runner.app_hashes(apps[0]) == identity, "candidate-build-mismatch")
        runner.sim("install", runner.device, str(apps[0]), code="candidate-install-failed", timeout=90)
        location = Path(runner.sim("get_app_container", runner.device, bundle, "app", capture=True,
                                   code="installed-app-unavailable").output)
        require(location.is_absolute() and location.resolve().is_relative_to(runner.device_set / runner.device),
                "installed-container-mismatch")
        require(runner.app_hashes(location.resolve()) == identity, "installed-app-mismatch")
        self.installed = location.resolve()
        return identity

    def await_startup(self, runner, reader, stream, bound_marker):
        deadline = time.monotonic() + 20
        ready = accepted = False
        while time.monotonic() < deadline:
            runner.check_alive(explicit_identity=True)
            require(reader.poll() is None, "phase-log-unavailable", verdict="NOT_RUN")
            messages = phase_messages(stream, runner.pid)
            require(STARTUP + "FAIL parameters-invalid" not in messages, "candidate-parameters-invalid")
            require(MARKER + "FAIL setup" not in messages, "candidate-setup-failed")
            marks = [msg for msg in messages if isinstance(msg, str) and msg.startswith(RUN_MARKER)]
            ready = STARTUP + "READY js" in messages
            accepted = STARTUP + "PASS parameters" in messages
            require(not marks or marks == [bound_marker], "candidate-parameters-mismatch")
            if ready and accepted and marks:
                return
            if STARTUP + "FAIL parameters-missing" in messages:
                raise c2.StageError("candidate-parameters-unavailable", verdict="NOT_RUN")
            self.sample(runner.pid)
            time.sleep(0.25)
        code = ("candidate-js-marker-missing" if not ready else
                "candidate-scenario-marker-missing" if accepted else "candidate-parameters-unavailable")
        raise c2.StageError(code, verdict="NOT_RUN")

    def sample(self, pid):
        if c1.process_path(pid) != self.installed / c1.EXECUTABLE:
            return
        try:
            output = self.command(("lsof", "-nP", "-a", "-p", str(pid), "-i", "-Fpn"), timeout=2, capture=True)
        except (c2.StageError, OSError):
            return
        if c1.process_path(pid) != self.installed / c1.EXECUTABLE:
            return
        observation = self.report["networkObservation"]
        observation["samples"] += 1
        if external_peer(output, pid):
            observation.update(verdict="FAIL", code="outside-destination-observed")
            raise c2.StageError("outside-destination-observed")

    def phase(self, phase):
        require(phase in c2.PHASES and not self.active, "candidate-phase-order")
        launch = c2.get_launch(self.work, self.context)
        binding = c2.phase_binding(self.work, launch)
        stream = self.work / (phase + ".ndjson")
        require(not stream.exists(), "candidate-phase-restart-refused")
        previous_pid = None
        if phase == "before":
            require(not (self.work / "trust.json").exists(), "trust-phase-mismatch")
        else:
            stopped = c2.load_receipt(self.work, "stopped-before", self.context)
            c2.verify_trust_transition(self.work, self.context, binding)
            wire = c2.phase_wire(self.work, self.context, binding, "before")
            require(stopped.get("binding") == binding and wire.get("stoppedSha256") ==
                    c1.digest(c2.private_file(self.work, "stopped-before.json")), "evidence-phase-mismatch")
            previous_pid = stopped.get("pid")
            require(type(previous_pid) is int and previous_pid > 0, "evidence-phase-mismatch")
        runner = self.runner()
        command = ("xcrun", "simctl", "--set", str(runner.device_set), "spawn", runner.device,
                   "log", "stream", "--level", "info", "--style", "ndjson", "--predicate",
                   'subsystem == "com.facebook.react.log" AND category == "javascript" '
                   'AND (eventMessage BEGINSWITH "[BunnyIosStandardHttps" '
                   'OR eventMessage BEGINSWITH "[BunnyIosCandidateStartup] ")')
        with stream.open("xb") as output:
            reader = subprocess.Popen(command, cwd=MOBILE, env=self.process_env, stdin=subprocess.DEVNULL,
                                      stdout=output, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            time.sleep(1)
            require(reader.poll() is None, "phase-log-unavailable", verdict="NOT_RUN")
            run_id, fixture_id = self.context["runId"], launch["fixtureId"]
            require(c2.hex_value(run_id, 32) and c2.hex_value(fixture_id, 32), "candidate-parameters-unconfirmed")
            self.active = True
            runner.installed = self.installed
            runner.pid = self.phase_pid = runner.launch_pid("-BunnyC2Launch", f"{phase}:{run_id}:{fixture_id}")
            pid = runner.pid
            require(pid != previous_pid, "installed-process-mismatch")
            runner.check_alive(explicit_identity=True)
            observed = c2.observe_installed(runner, phase, pid, launch)
            c2.save_receipt(self.work, "installed-" + phase, self.context, binding=binding, **observed)
            self.await_startup(runner, reader, stream, f"{RUN_MARKER}{run_id} {fixture_id} {phase}")
            deadline = time.monotonic() + 180
            settle = None
            while time.monotonic() < deadline:
                runner.check_alive(explicit_identity=True)
                self.sample(pid)
                require(reader.poll() is None, "phase-log-unavailable", verdict="NOT_RUN")
                messages = phase_messages(stream, pid)
                require(MARKER + "FAIL setup" not in messages, "candidate-setup-failed")
                if MARKER + "DONE" in messages and settle is None:
                    settle = time.monotonic() + (6 if phase == "after" else 1)
                if settle is not None and time.monotonic() >= settle:
                    break
                time.sleep(0.25)
            else:
                raise c2.StageError("candidate-phase-timeout", verdict="NOT_RUN")
            runner.check_alive(explicit_identity=True)
            c2.stop_phase(runner, self.work, self.context, launch, phase)
            self.active = False
            self.phase_pid = None
            self.report["phaseStops"][phase] = "PASS"
        except c2.StageError as error:
            error.record["phase"] = phase
            if runner.evidence.get("crashSignal"):
                error.record["crashSignal"] = runner.evidence["crashSignal"]
            raise
        finally:
            pending_error = sys.exc_info()[0] is not None
            try:
                try:
                    if reader.poll() is None:
                        try:
                            os.killpg(reader.pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                    reader.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(reader.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    reader.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                if not pending_error:
                    raise c2.StageError("phase-log-stop-unconfirmed", verdict="NOT_RUN") from None
        self.command(("node", str(PILOT), "--standard-wire", str(self.work), phase), timeout=15)

    def runtime(self):
        self.phase("before")
        # The existing gate verifies the stopped phase, wire receipt and public root hash.
        self.command((sys.executable, "-IB", str(DRIVER), "trust", str(self.work), "certificates/ca.pem"))
        self.phase("after")
        _, paths = c2.verify_phases(self.work, self.context, c2.get_launch(self.work, self.context))
        result = c2.read_runtime(paths, command=self.isolated_command)
        if result["verdict"] != "PASS":
            error = c2.StageError("runtime-evidence-not-passing", verdict=result["verdict"])
            error.record["checks"] = result
            raise error
        return {"checks": result}

    def cleanup_candidate(self):
        if not self.active:
            return {"verdict": "NOT_RUN", "state": "no-stop-pending"}
        if self.phase_pid is None:
            return {"verdict": "NOT_RUN", "state": "pid-unconfirmed"}
        runner = self.runner()
        runner.pid, runner.installed = self.phase_pid, self.installed
        state = runner.process_status()
        if state == "absent":
            return {"verdict": "PASS", "state": "already-absent"}
        if state != "matching":
            return {"verdict": "FAIL" if state == "wrong-executable" else "NOT_RUN", "state": state}
        try:
            runner.stop()
        except c2.StageError as error:
            try:
                state = runner.process_status()
            except c2.StageError:
                state = "unconfirmed"
            if error.record["code"] == "process-already-exited" and state == "absent":
                return {"verdict": "PASS", "state": "already-absent"}
            return {**error.record, "verdict": "FAIL", "state": state}
        return {"verdict": "PASS", "state": "explicit-stop"}

    def cleanup(self):
        try:
            application = self.cleanup_candidate()
        except c2.StageError as error:
            application = {**error.record, "state": "unconfirmed"}
        except Exception:
            application = {"verdict": "NOT_RUN", "state": "unconfirmed"}
        try:
            evidence = super().cleanup()
        except c2.StageError as error:
            error.record["candidateStop"] = application
            raise
        evidence["candidateStop"] = application
        if application["verdict"] == "FAIL":
            error = c2.StageError("candidate-cleanup-stop-failed")
            error.record.update(evidence)
            raise error
        return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    env = dict(os.environ)
    os.environ.pop("GH_TOKEN", None)
    args.report.parent.mkdir(mode=0o700, exist_ok=True)
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGALRM):
        signal.signal(signum, c1.interrupt)
    signal.alarm(85 * 60)
    return Campaign(args.report, env).run()


if __name__ == "__main__":
    sys.exit(main())
