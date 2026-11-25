"""Build once and observe the standard Release on a disposable GitHub macOS runner."""

import argparse
from contextlib import contextmanager
import ctypes
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time


MOBILE = Path(__file__).resolve().parents[1]
BUNDLE_ID = "fr.bunnytalks.mobile"
EXECUTABLE = "BunnyTalks"
XCODE_BUILD = "17F113"
RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-26-5"
DEVICE_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17"
DEVICE_NAME = "Bunny Talks C1"
STABILITY_SECONDS = 15
BUILD_NUMBER = r"[0-9]{2}[A-Z][0-9]{1,5}[a-z]?"
SHA256 = r"[0-9a-f]{64}"
UUID = r"[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}"
REQUIRED_STAGES = (
    "revision", "toolchain", "archive", "simulatorAvailability", "simulatorPreparation",
    "dependencies", "project", "build", "staticInspection", "installation", "installedExecutable",
    "launch", "reactNativeRendering", "processStability", "stop", "cleanup",
)
OUT_OF_SCOPE = ("httpsRuntime", "runtimeMinimumIOS", "physicalDevice")


class StageError(Exception):
    def __init__(self, code, *, verdict="FAIL", exit_code=None):
        self.record = {"verdict": verdict, "code": code}
        if exit_code is not None and -255 <= exit_code <= 255:
            self.record["exitCode"] = exit_code


class Interrupted(Exception):
    pass


def require(condition, code, *, verdict="FAIL"):
    if not condition:
        raise StageError(code, verdict=verdict)


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def read_json(path):
    with path.open("rb") as handle:
        return json.loads(handle.read(2 * 1024 * 1024 + 1))


def simulator_state(value):
    return value if value in ("Shutdown", "Booting", "Booted") else "unknown"


def process_path(pid):
    try:
        query = ctypes.CDLL("/usr/lib/libproc.dylib").proc_pidpath
    except (OSError, AttributeError):
        return None
    query.argtypes = (ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32)
    query.restype = ctypes.c_int
    # Darwin's PROC_PIDPATHINFO_MAXSIZE is four times MAXPATHLEN (1024).
    buffer = ctypes.create_string_buffer(4096)
    if query(pid, buffer, len(buffer)) <= 0:
        return None
    path = Path(os.fsdecode(buffer.value))
    return path.resolve() if path.is_absolute() else None


@dataclass
class CommandResult:
    exit_code: int
    output: str = ""


def run_command(command, *, cwd, timeout, output=None, capture=False, merge_output=False, env=None):
    # Tool output stays private. A process group also contains children on cancellation.
    with (output.open("w+b") if output else tempfile.TemporaryFile()) as stream:
        with subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=stream,
                              stderr=subprocess.STDOUT if merge_output else subprocess.DEVNULL,
                              start_new_session=True, env=env) as child:
            try:
                child.wait(timeout)
            except (Interrupted, subprocess.TimeoutExpired):
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                raise
        result = CommandResult(child.returncode)
        if capture:
            stream.seek(0)
            data = stream.read(2 * 1024 * 1024 + 1)
            require(len(data) <= 2 * 1024 * 1024, "command-output-unavailable", verdict="NOT_RUN")
            result.output = data.decode("utf-8").strip()
        return result


class RuntimeRun:
    def __init__(self, scratch, report_path, env, command=run_command, *, device_name=DEVICE_NAME,
                 bundle_id=BUNDLE_ID):
        self.scratch = scratch
        self.report_path = report_path
        self.env = env
        self.command = command
        self.device_name = device_name
        self.bundle_id = bundle_id
        self.device_set = scratch / "simulators"
        self.creation_attempted = False
        self.device = None
        self.pid = None
        self.installed = None
        revision = env.get("GITHUB_SHA", "")
        run_id = env.get("GITHUB_RUN_ID", "")
        self.report = {
            "schemaVersion": 1,
            "scope": "ios-standard-runtime-c1",
            "revision": revision if re.fullmatch(r"[a-f0-9]{40}", revision) else None,
            "run": int(run_id) if re.fullmatch(r"[0-9]{1,20}", run_id) else None,
            "complete": False,
            "stages": {name: {"verdict": "NOT_RUN"} for name in REQUIRED_STAGES + OUT_OF_SCOPE},
            "evidence": {},
        }
        self.stages = self.report["stages"]
        self.evidence = self.report["evidence"]

    def checkpoint(self):
        states = [self.stages[name]["verdict"] for name in REQUIRED_STAGES]
        self.report["verdict"] = (
            "FAIL" if "FAIL" in states else
            "PASS" if self.report["complete"] and all(state == "PASS" for state in states) else
            "NOT_RUN"
        )
        temporary = self.report_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.report, sort_keys=True, indent=2) + "\n")
        temporary.replace(self.report_path)

    @contextmanager
    def stage(self, name, *, continue_on_error=False):
        self.stages[name] = {"verdict": "NOT_RUN", "code": "stage-incomplete"}
        self.checkpoint()
        try:
            yield
        except Interrupted:
            self.stages[name]["code"] = "interrupted"
            raise
        except StageError as error:
            self.stages[name] = error.record
            if not continue_on_error:
                raise
        except (OSError, ValueError, TypeError, KeyError, AttributeError, plistlib.InvalidFileException):
            verdict = "FAIL" if name in ("cleanup", "stop") else "NOT_RUN"
            self.stages[name] = {"verdict": verdict, "code": "evidence-unavailable"}
            if not continue_on_error:
                raise StageError("evidence-unavailable", verdict=verdict) from None
        else:
            self.stages[name] = {"verdict": "PASS"}
        finally:
            self.checkpoint()

    def call(self, *args, code, cwd=MOBILE, timeout=30, output=None, capture=False,
             allowed=(0,), merge_output=False, timeout_code="command-timeout"):
        try:
            result = self.command(args, cwd=cwd, timeout=timeout, output=output, capture=capture,
                                  merge_output=merge_output)
        except subprocess.TimeoutExpired:
            raise StageError(timeout_code) from None
        except OSError as failure:
            error = StageError("command-unavailable", verdict="NOT_RUN")
            executable = Path(args[0]).name
            families = ("xcrun", "xcodebuild", "node", "corepack", "pnpm", "pod", "bash", "ps",
                        "sw_vers", "uname", "lsof", "python3")
            family = executable if executable in families else "other"
            error.record["command"] = {"family": family, "operation": code,
                                       "errno": failure.errno if type(failure.errno) is int else None}
            raise error from None
        if result.exit_code not in allowed:
            raise StageError(code, exit_code=result.exit_code)
        return result

    def sim(self, *args, **kwargs):
        return self.call("xcrun", "simctl", "--set", str(self.device_set), *args, **kwargs)

    def verify_toolchain(self, *, require_hosted=True):
        require(not require_hosted or (self.env.get("RUNNER_ENVIRONMENT") == "github-hosted"
                and self.env.get("GITHUB_REPOSITORY") == "ntapiaDev/bunny-talks"
                and self.env.get("GITHUB_RUN_ATTEMPT") == "1"), "runner-not-approved")
        forbidden = {
            "BUNNY_IOS_HTTPS_QUALIFICATION", "XCODE_XCCONFIG_FILE", "ENTRY_FILE",
            "EXTRA_PACKAGER_ARGS", "BUNDLE_COMMAND", "SKIP_BUNDLING",
        }
        require(not any(name in forbidden or name.startswith(("EXPO_PUBLIC_", "SIMCTL_CHILD_"))
                        for name in self.env), "runtime-environment-overrides")
        require(self.env.get("EXPO_NO_DOTENV") == "1" and self.env.get("EXPO_OFFLINE") == "1",
                "runtime-environment-overrides")

        def output(*args):
            return self.call(*args, code="toolchain-command-failed", capture=True).output

        require(output("uname", "-m") == "arm64"
                and output("xcodebuild", "-version") == f"Xcode 26.6\nBuild version {XCODE_BUILD}"
                and output("xcrun", "--sdk", "iphonesimulator", "--show-sdk-version") == "26.5"
                and output("node", "--version") == "v24.22.3", "toolchain-mismatch")
        macos = output("sw_vers", "-productVersion")
        macos_build = output("sw_vers", "-buildVersion")
        sdk_build = output("xcrun", "--sdk", "iphonesimulator", "--show-sdk-build-version")
        require(re.fullmatch(r"26\.[0-9]{1,2}(?:\.[0-9]{1,2})?", macos)
                and re.fullmatch(BUILD_NUMBER, macos_build)
                and re.fullmatch(BUILD_NUMBER, sdk_build), "toolchain-mismatch")
        require(process_path(os.getpid()) is not None, "process-probe-unavailable", verdict="NOT_RUN")
        self.evidence["toolchain"] = {
            "architecture": "arm64", "macOS": macos, "macOSBuild": macos_build,
            "xcode": "26.6", "xcodeBuild": XCODE_BUILD, "sdk": "26.5", "sdkBuild": sdk_build,
            "node": "24.22.3",
        }

    def find_runtime(self):
        def inventory(kind):
            return json.loads(self.call("xcrun", "simctl", "list", kind, "--json",
                                        code="simulator-inventory-failed", timeout=90,
                                        timeout_code="simulator-inventory-timeout", capture=True).output)[kind]

        runtime = next((row for row in inventory("runtimes") if row["identifier"] == RUNTIME
                        and row.get("isAvailable") is True), None)
        require(runtime and runtime["version"] == "26.5", "runtime-unavailable")
        require(any(row["identifier"] == DEVICE_TYPE for row in inventory("devicetypes")),
                "device-type-unavailable")
        supported = runtime.get("supportedDeviceTypes")
        if supported is not None:
            require(any(row["identifier"] == DEVICE_TYPE for row in supported), "device-type-unavailable")
        build = runtime.get("buildversion", "")
        require(re.fullmatch(BUILD_NUMBER, build), "runtime-build-unavailable", verdict="NOT_RUN")
        self.evidence["simulator"] = {"model": "iPhone 17", "iOS": "26.5", "iOSBuild": build}

    def prepare_and_build(self):
        scratch = self.scratch
        archive = scratch / "xcframeworks.zip"
        provenance = scratch / "provenance.json"
        verifier = "modules/application-https/ios/verify_xcframeworks.py"
        inspector = "scripts/inspect-ios-standard.py"
        ios = MOBILE / "ios"
        pod_settings = scratch / "pod-settings.json"
        derived = scratch / "DerivedData"
        source_map = scratch / "bundle.map"

        with self.stage("toolchain"):
            self.verify_toolchain()
        with self.stage("archive"):
            require(archive.is_file(), "archive-missing")
            self.call("python3", "-IB", verifier, "archive", str(archive), output=provenance,
                      code="archive-rejected")
            self.evidence["archive"] = {"id": 14723035221, "sha256": digest(archive)}
        with self.stage("simulatorAvailability"):
            self.find_runtime()
        with self.stage("simulatorPreparation"):
            self.boot()
        with self.stage("dependencies"):
            self.call("corepack", "enable", code="corepack-failed")
            version = self.call("pnpm", "--version", code="pnpm-unavailable", capture=True)
            require(version.output == "10.34.9", "toolchain-mismatch")
            self.evidence["toolchain"]["pnpm"] = "10.34.9"
            self.call("pnpm", "install", "--frozen-lockfile", cwd=MOBILE.parents[1],
                      code="dependency-install-failed", timeout=360)
            self.call("pnpm", "--filter", "@bunny-talks/mobile^...", "run", "--if-present", "build",
                      cwd=MOBILE.parents[1], code="package-build-failed", timeout=180)
            self.call("bash", "scripts/preflight-ios-standard.sh", str(archive),
                      code="standard-preflight-failed", timeout=120)
            self.call("python3", "-IB", verifier, "install", str(archive), code="archive-install-failed")
        with self.stage("project"):
            pods = self.call("pod", "--version", code="pods-version-unavailable", capture=True).output
            require(re.fullmatch(r"[0-9]{1,2}\.[0-9]{1,2}\.[0-9]{1,2}", pods),
                    "pods-version-unavailable", verdict="NOT_RUN")
            self.evidence["toolchain"]["cocoaPods"] = pods
            self.call("pnpm", "exec", "expo", "prebuild", "--platform", "ios", "--no-install", "--no-clean",
                      code="expo-prebuild-failed", timeout=180)
            self.call("python3", "-IB", inspector, "generated", code="generated-project-rejected")
            self.call("pod", "install", cwd=ios, code="pods-install-failed", timeout=600)
            self.call("xcodebuild", "-project", "Pods/Pods.xcodeproj", "-target", "ApplicationHttps",
                      "-target", "ExpoSQLite", "-configuration", "Release", "-sdk", "iphonesimulator",
                      "-showBuildSettings", "-json", cwd=ios, output=pod_settings, timeout=120,
                      code="pod-settings-unavailable")
            self.call("python3", "-IB", inspector, "pods", str(pod_settings), code="pod-settings-rejected")
        try:
            with self.stage("build"):
                result = self.compile_release(ios, scratch)
                self.evidence["xcodeExitCode"] = result.exit_code
        except StageError as error:
            if "exitCode" in error.record:
                diagnostics = self.collect_build_diagnostics(scratch, error.record["exitCode"])
                quality = diagnostics.get("quality")
                if quality in ("technical-error", "phase-only", "generic", "unknown"):
                    self.evidence["buildDiagnosticQuality"] = quality
            raise
        with self.stage("staticInspection"):
            apps = list((derived / "Build/Products/Release-iphonesimulator").glob("*.app"))
            require(len(apps) == 1, "built-app-missing-or-ambiguous")
            app = apps[0]
            built = self.app_hashes(app)
            native = "modules/application-https/ios/vendor"
            self.call("python3", "-IB", verifier, "verify", f"{native}/xcframeworks.zip", f"{native}/package",
                      code="extracted-archives-rejected")
            report = scratch / "release.json"
            result = self.call("python3", "-IB", inspector, "release", str(derived), str(source_map),
                               str(pod_settings), str(provenance), output=report, timeout=120,
                               allowed=(0, 1), code="inspection-command-failed")
            static = read_json(report)
            require(static["verdict"] != "FAIL", "static-inspection-rejected")
            require(result.exit_code == 0 and static["verdict"] == "PASS", "static-inspection-unavailable",
                    verdict="NOT_RUN")
            require(all(static.get(key) == value for key, value in built.items()), "inspected-app-mismatch")
            release_config = {"configuration": "Release", "platform": "IOSSIMULATOR",
                              "architecture": "arm64", "minimumOS": "16.4"}
            require(all(static.get(key) == value for key, value in release_config.items()),
                    "static-inspection-unavailable", verdict="NOT_RUN")
            lock_hash = static.get("podfileLockSha256", "")
            require(re.fullmatch(SHA256, lock_hash), "static-inspection-unavailable", verdict="NOT_RUN")
            self.evidence["inspectedApp"] = built
            self.evidence["release"] = {**release_config, "jsEngine": "Hermes"}
            self.evidence["podfileLockSha256"] = lock_hash
        return app

    def compile_release(self, ios, output, *, verbose=False):
        return self.call(
            "xcodebuild", "build", "-workspace", "BunnyTalks.xcworkspace", "-scheme", EXECUTABLE,
            "-configuration", "Release", "-sdk", "iphonesimulator", "-destination",
            "generic/platform=iOS Simulator", "-derivedDataPath", str(output / "DerivedData"), "ARCHS=arm64",
            "CODE_SIGNING_ALLOWED=NO", "-resultBundlePath", str(output / "build.xcresult"),
            f"SOURCEMAP_FILE={output / 'bundle.map'}", "LD_GENERATE_MAP_FILE=YES",
            "LD_MAP_FILE_PATH=$(TARGET_TEMP_DIR)/$(TARGET_NAME)-LinkMap-$(CURRENT_ARCH).txt",
            *(("-verbose",) if verbose else ()),
            cwd=ios, output=output / "xcodebuild.log", merge_output=True, timeout=1500, code="xcodebuild-failed",
        )

    def collect_build_diagnostics(self, build_dir, exit_code):
        try:
            if exit_code is not None:
                (build_dir / "xcodebuild.exit").write_text(f"{exit_code}\n")
            output = self.call("python3", "-IB", "scripts/collect-ios-build-diagnostics.py",
                               str(build_dir), "failure", capture=True, timeout=50,
                               code="build-diagnostics-unavailable").output
            report = json.loads(output)
            if isinstance(report, dict) and report.get("verdict") in ("PASS", "NOT_RUN"):
                return report
        except Interrupted:
            raise
        except Exception:
            # Diagnostics are best effort and must not supersede the build error.
            pass
        return {"verdict": "NOT_RUN", "reason": "build-diagnostics-unavailable"}

    def app_hashes(self, app):
        require(app.is_dir() and not app.is_symlink(), "app-missing")
        with (app / "Info.plist").open("rb") as handle:
            info = plistlib.load(handle)
        require(info.get("CFBundleIdentifier") == self.bundle_id, "bundle-id-mismatch")
        executable = app / EXECUTABLE
        bundle = app / "main.jsbundle"
        require(info.get("CFBundleExecutable") == EXECUTABLE and executable.is_file()
                and not executable.is_symlink(), "app-executable-invalid")
        require(bundle.is_file() and not bundle.is_symlink(), "hermes-bundle-missing")
        return {"bundleId": self.bundle_id, "executableSha256": digest(executable),
                "hermesBundleSha256": digest(bundle)}

    def devices(self):
        output = self.sim("list", "devices", "--json", code="device-list-failed",
                          timeout=90,
                          timeout_code="simulator-inventory-timeout", capture=True).output
        result = json.loads(output)["devices"]
        return [row for devices in result.values() for row in devices]

    def boot(self):
        self.device_set.mkdir(mode=0o700)
        require(self.devices() == [], "device-set-not-empty")
        # Cleanup can recover a created device even if the create command never returns its UUID.
        self.creation_attempted = True
        device = self.sim("create", self.device_name, DEVICE_TYPE, RUNTIME, timeout=60,
                          code="simulator-create-failed", timeout_code="simulator-create-timeout",
                          capture=True).output
        require(re.fullmatch(UUID, device), "simulator-uuid-unavailable")
        self.device = device
        self.evidence["simulatorCreated"] = True
        boot = self.sim("boot", device, code="simulator-boot-failed",
                        timeout_code="simulator-boot-timeout", timeout=60)
        self.evidence["simulatorBootExitCode"] = boot.exit_code
        readiness = self.sim("bootstatus", device, "-b", code="simulator-bootstatus-failed",
                             timeout_code="simulator-bootstatus-timeout", timeout=180)
        self.evidence["simulatorBootstatusExitCode"] = readiness.exit_code
        state = next((row.get("state") for row in self.devices() if row["udid"] == device), None)
        self.evidence["simulatorState"] = simulator_state(state)
        require(state == "Booted", "simulator-boot-incomplete")
        self.evidence["simulatorBooted"] = True

    def screen(self):
        screenshot = self.scratch / "screen.png"
        try:
            self.sim("io", self.device, "screenshot", str(screenshot), code="screenshot-unavailable")
            result = self.call("xcrun", "swift", "scripts/observe-ios-standard-screen.swift", str(screenshot),
                               capture=True, code="ocr-unavailable")
            require(result.output in ("MATCH", "NO_MATCH"), "ocr-unavailable")
            return result.output == "MATCH"
        except StageError:
            return None
        finally:
            screenshot.unlink(missing_ok=True)

    def launch_pid(self, *launch_args):
        result = self.sim("launch", self.device, self.bundle_id, *launch_args, code="launch-refused", capture=True)
        pattern = re.escape(self.bundle_id) + r": ([1-9][0-9]{0,8})"
        match = re.fullmatch(pattern, result.output)
        require(len(re.findall(r"^" + pattern + r"$", result.output, flags=re.M)) <= 1,
                "launch-pid-ambiguous", verdict="NOT_RUN")
        require(match, "launch-pid-unavailable", verdict="NOT_RUN")
        return int(match[1])

    def process_status(self):
        process = self.call("/bin/ps", "-p", str(self.pid), "-o", "state=",
                            code="process-query-failed", allowed=(0, 1), capture=True, timeout=5)
        if process.exit_code == 1 and not process.output:
            return "absent"
        state = process.output
        require(process.exit_code == 0 and re.fullmatch(r"[A-Za-z<>+\-]{1,12}", state),
                "process-identity-unavailable", verdict="NOT_RUN")
        if state.startswith("Z") or "E" in state:
            return "absent"
        path = process_path(self.pid)
        if path is None:
            return "unconfirmed"
        return "matching" if path == self.installed / EXECUTABLE else "wrong-executable"

    def process_running(self, *, explicit_identity=False):
        state = self.process_status()
        if explicit_identity:
            require(state != "wrong-executable", "installed-process-mismatch")
        require(state in ("matching", "absent"),
                "process-identity-unavailable", verdict="NOT_RUN")
        return state == "matching"

    def crash_signal(self):
        # An Apple .ips report can arrive late. Only a correlated fatal report proves a crash.
        directories = (Path.home() / "Library/Logs/DiagnosticReports",
                       self.device_set / self.device / "data/Library/Logs/CrashReporter")
        for directory in directories:
            for path in directory.glob(f"{EXECUTABLE}*.ips"):
                try:
                    if not path.is_file() or path.stat().st_size > 2 * 1024 * 1024:
                        continue
                    with path.open("rb") as handle:
                        header = json.loads(handle.readline())
                        report = json.load(handle)
                    if (str(header.get("bug_type")) != "309" or report.get("pid") != self.pid
                            or report.get("bundleInfo", {}).get("CFBundleIdentifier") != self.bundle_id
                            or report.get("isNonFatal") is True
                            or Path(report["procPath"]).resolve() != self.installed / EXECUTABLE):
                        continue
                    value = report.get("exception", {}).get("signal")
                    return value if value in ("SIGABRT", "SIGBUS", "SIGILL", "SIGKILL",
                                               "SIGSEGV", "SIGTRAP") else "other"
                except (OSError, ValueError, TypeError, KeyError, AttributeError):
                    continue
        return None

    def check_alive(self, *, explicit_identity=False):
        if self.process_running(explicit_identity=explicit_identity):
            return
        for attempt in range(3):
            if attempt:
                time.sleep(1)
            crash_signal = self.crash_signal()
            if crash_signal is not None:
                self.evidence["crashSignal"] = crash_signal
                raise StageError("correlated-crash")
        raise StageError("process-exited-unexpectedly")

    def observe(self, app):
        with self.stage("installation"):
            self.sim("install", self.device, str(app), code="installation-refused", timeout=90)
        with self.stage("installedExecutable"):
            location = self.sim("get_app_container", self.device, BUNDLE_ID, "app",
                                code="installed-app-unavailable", capture=True).output
            self.installed = Path(location).resolve()
            require(Path(location).is_absolute()
                    and self.installed.is_relative_to(self.device_set.resolve() / self.device),
                    "installed-container-mismatch")
            installed = self.app_hashes(self.installed)
            require(installed == self.evidence["inspectedApp"], "installed-app-mismatch")
            self.evidence["installedApp"] = installed
        baseline = self.screen()
        self.evidence["renderingMethod"] = "simulator-screenshot-vision-ocr"
        self.evidence["negativeRenderControl"] = baseline is False

        with self.stage("launch"):
            self.pid = self.launch_pid()
            self.evidence["launchPid"] = self.pid

        with self.stage("processStability"):
            started = time.monotonic()
            while True:
                self.check_alive()
                if time.monotonic() - started >= STABILITY_SECONDS:
                    break
                time.sleep(1)
            rendered = None
            if baseline is False:
                rendered = self.screen()
                self.check_alive()
            with self.stage("reactNativeRendering", continue_on_error=True):
                require(baseline is False, "negative-render-control-unavailable", verdict="NOT_RUN")
                require(rendered is True,
                        "screen-markers-missing" if rendered is False else "screen-observation-unavailable",
                        verdict="NOT_RUN")
            self.check_alive()
            self.evidence["stabilityWindowSeconds"] = STABILITY_SECONDS

    def stop(self):
        if not self.process_running():
            already_observed = self.stages["processStability"]["verdict"] == "PASS"
            raise StageError("process-already-exited", verdict="FAIL" if already_observed else "NOT_RUN")
        self.sim("terminate", self.device, self.bundle_id, code="stop-refused")
        for _ in range(5):
            if not self.process_running():
                return
            time.sleep(1)
        raise StageError("process-still-running")

    def cleanup_device(self):
        shutdown_error = None
        if self.creation_attempted:
            # Reuse the bounded cleanup inventory before mutating the device.
            preparation_failed = self.stages["simulatorPreparation"]["verdict"] != "PASS"
            if preparation_failed:
                self.evidence["simulatorStateAfterFailure"] = "unknown"
            rows = self.devices()
            require(len(rows) <= 1, "device-set-ownership-unconfirmed")
            for row in rows:
                device = row["udid"]
                require(row["name"] == self.device_name and re.fullmatch(UUID, device)
                        and (self.device is None or device == self.device), "device-set-ownership-unconfirmed")
                if preparation_failed:
                    self.evidence["simulatorStateAfterFailure"] = simulator_state(row.get("state"))
                if row["state"] != "Shutdown":
                    try:
                        self.sim("shutdown", device, code="simulator-shutdown-failed", timeout=20)
                    except StageError as error:
                        shutdown_error = error
                self.sim("delete", device, code="simulator-delete-failed", timeout=30)
            require(self.devices() == [], "simulator-still-present")
            self.evidence["simulatorRemoved"] = True
        return shutdown_error

    def cleanup(self):
        shutdown_error = self.cleanup_device()
        shutil.rmtree(self.scratch)
        require(not self.scratch.exists(), "scratch-still-present")
        if shutdown_error is not None:
            raise shutdown_error

    def run(self):
        try:
            with self.stage("revision"):
                revision = self.report["revision"]
                require(revision is not None and revision == self.env.get("REVIEWED_SHA"),
                        "reviewed-sha-mismatch")
                require(revision == self.env.get("CHECKED_OUT_SHA"), "checkout-sha-mismatch")
            self.observe(self.prepare_and_build())
        except StageError:
            pass
        except Interrupted:
            self.report["interrupted"] = True
        finally:
            try:
                if self.pid is not None:
                    with self.stage("stop", continue_on_error=True):
                        self.stop()
            finally:
                with self.stage("cleanup", continue_on_error=True):
                    self.cleanup()
        self.report["complete"] = not self.report.get("interrupted") and not any(
            stage.get("code") in ("interrupted", "stage-incomplete") for stage in self.stages.values()
        )
        self.checkpoint()
        return {"PASS": 0, "FAIL": 1, "NOT_RUN": 2}[self.report["verdict"]]


def interrupt(_signal, _frame):
    # The first signal requests orderly cleanup. Runner teardown may still preempt it.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise Interrupted()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("scratch", type=Path)
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    try:
        runner_temp = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
        require(args.scratch.resolve(strict=True) == runner_temp / "bunny-ios-c1"
                and args.report.resolve() == runner_temp / "bunny-ios-c1-proof/report.json",
                "runner-paths-not-approved")
        signal.signal(signal.SIGINT, interrupt)
        signal.signal(signal.SIGTERM, interrupt)
        status = RuntimeRun(args.scratch, args.report, os.environ).run()
    except Exception:
        status = 2
    print({0: "iOS standard C1 PASS", 1: "iOS standard C1 FAIL", 2: "iOS standard C1 NOT_RUN"}[status])
    return status


if __name__ == "__main__":
    sys.exit(main())
