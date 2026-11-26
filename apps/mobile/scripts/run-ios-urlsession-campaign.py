"""Run the standard JSON plan using the existing hosted laboratory utilities."""

import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

spec = importlib.util.spec_from_file_location("lab", Path(__file__).with_name("run-ios-hosted-feasibility.py"))
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)
c1, c2 = lab.c1, lab.c2
require = c2.require
BUNDLE = "fr.bunnytalks.mobile.httpsqualification.urlsession"
MARKER = "[BunnyHttpsStandardJson] "
PNPM_VERSION = "10.34.9"


class Campaign(lab.Feasibility):
    def __init__(self, report_path, env):
        super().__init__(report_path, env)
        self.process_env.update(CI="true", EXPO_NO_DOTENV="1", EXPO_OFFLINE="1",
                                EXPO_NO_GIT_STATUS="1", COCOAPODS_DISABLE_STATS="true",
                                COREPACK_ENABLE_DOWNLOAD_PROMPT="0")
        self.runner = None
        self.staged = None
        self.reader = None
        self.report.update(scope="ios-urlsession-standard-json-known-length", profile="hosted-observed",
                           networkObservation="NOT_RUN",
                           standardHttpsRuntime="NOT_RUN", runtimeMinimumIOS="NOT_RUN",
                           physicalDevice="NOT_RUN", memory="NOT_RUN", energy="NOT_RUN")
        self.report["stages"] = {name: {"verdict": "NOT_RUN"} for name, _ in self.steps()}
        self.report["stages"]["cleanup"] = {"verdict": "NOT_RUN"}

    def steps(self):
        return (("revision", self.revision), ("source", self.source), ("staging", self.staging),
                ("toolchain", self.toolchain), ("simulator", self.simulator),
                ("build", self.build), ("provenance", self.provenance),
                ("fixture", self.start_fixture), ("runtime", self.runtime))

    def revision(self):
        require(self.env.get("HOSTED_OBSERVED") == "true", "hosted-profile-not-approved")
        return super().revision()

    def staging(self):
        script = self.scratch / "source/apps/mobile/qualification/prepare-ios-eas.sh"
        self.staged = Path(self.command(("bash", str(script), "--urlsession"), capture=True))
        require(self.staged.is_dir() and self.staged.resolve().parent == Path("/tmp").resolve(), "staging-invalid")
        native = self.staged / "apps/mobile/modules/application-https/ios"
        require({p.name for p in native.iterdir()} == {
            "ApplicationHttpsModule.swift", "ApplicationHttps.podspec", "UrlSessionHttpsTransport.swift"},
            "staging-native-mismatch")
        return {"nativeSources": {p.name: c1.digest(p) for p in native.iterdir()}}

    def toolchain(self):
        self.runner = c1.RuntimeRun(self.scratch, self.scratch / "unused.json", self.env,
                                    command=self.isolated_command, device_name="Bunny Talks URLSession",
                                    bundle_id=BUNDLE)
        self.runner.verify_toolchain()
        self.runner.find_runtime()
        return self.runner.evidence

    def simulator(self):
        self.runner.boot()
        self.runner.stages["simulatorPreparation"] = {"verdict": "PASS"}
        return {"booted": True}

    def build(self):
        root = self.staged
        mobile = root / "apps/mobile"
        self.process_env["COREPACK_HOME"] = str(self.scratch / "corepack")
        self.runner.call("corepack", "enable", cwd=root, code="corepack-failed")
        version = self.runner.call("pnpm", "--version", cwd=root, capture=True, timeout=120,
                                   code="pnpm-unavailable").output
        if version != PNPM_VERSION:
            error = c2.StageError("pnpm-version-mismatch")
            observed = re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?",
                                    version, flags=re.ASCII) if len(version) <= 64 else None
            error.record.update(expectedPnpmVersion=PNPM_VERSION,
                                observedPnpmVersion=observed[0] if observed else None)
            raise error
        for args, cwd, timeout in (
            (("pnpm", "install", "--frozen-lockfile", "--store-dir", str(self.scratch / "store")), root, 360),
            (("pnpm", "--filter", "@bunny-talks/mobile^...", "run", "--if-present", "build"), root, 180),
            (("pnpm", "exec", "expo", "prebuild", "--platform", "ios", "--no-install", "--no-clean"), mobile, 180),
            (("pod", "install"), mobile / "ios", 600),
        ):
            self.runner.call(*args, cwd=cwd, timeout=timeout, code="project-preparation-failed")
        ios = mobile / "ios"
        workspaces = list(ios.glob("*.xcworkspace"))
        require(len(workspaces) == 1, "workspace-ambiguous")
        self.executable = workspaces[0].stem
        output = self.scratch / "build"
        output.mkdir()
        # The C1 compiler and inspector expect the generated application name.
        c1.EXECUTABLE = self.executable
        try:
            self.runner.call("xcodebuild", "build", "-workspace", workspaces[0].name,
                             "-scheme", self.executable, "-configuration", "Release",
                             "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator",
                             "-derivedDataPath", str(output / "DerivedData"), "ARCHS=arm64",
                             "CODE_SIGNING_ALLOWED=NO", "-resultBundlePath", str(output / "build.xcresult"),
                             cwd=ios, timeout=1500, output=output / "xcodebuild.log", merge_output=True,
                             code="xcodebuild-failed")
        except c1.StageError as error:
            error.record["buildDiagnostics"] = self.runner.collect_build_diagnostics(output, error.record.get("exitCode"))
            raise
        self.app = output / "DerivedData/Build/Products/Release-iphonesimulator" / (self.executable + ".app")
        return {"configuration": "Release", "architecture": "arm64"}

    def provenance(self):
        self.hashes = self.runner.app_hashes(self.app)
        require(self.command(("xcrun", "lipo", "-archs", str(self.app / self.executable)),
                             capture=True) == "arm64", "mach-o-architecture-mismatch")
        info = plistlib.loads((self.app / "Info.plist").read_bytes())
        require(info.get("NSAppTransportSecurity", {}) in ({}, {"NSAllowsArbitraryLoads": False}), "ats-exception")
        require((self.app / "main.jsbundle").read_bytes()[:8] == bytes.fromhex("c61fbc03c103191f"),
                "hermes-bytecode-missing")
        load = self.command(("xcrun", "vtool", "-show-build", str(self.app / self.executable)), capture=True)
        require("IOSSIMULATOR" in load and re.search(r"minos\s+16\.4\b", load), "mach-o-target-mismatch")
        symbol_path = self.scratch / "symbols.txt"
        self.command(("xcrun", "nm", "-j", str(self.app / self.executable)), output=symbol_path)
        symbols = symbol_path.read_text()
        require(not re.search(r"(?m)^_(?:curl_|SSL_|OPENSSL_|bunny_https_)", symbols),
                "unexpected-linked-transport")
        pods = (self.staged / "apps/mobile/ios/Podfile.lock").read_text()
        require("ApplicationHttps" in pods and "libcurl" not in pods.lower() and "openssl" not in pods.lower(),
                "unexpected-transport-dependency")
        transcript = (self.scratch / "build/xcodebuild.log").read_text(errors="replace")
        require("UrlSessionHttpsTransport.swift" in transcript and
                "BUNNY_HTTPS_URLSESSION_QUALIFICATION" in transcript and
                "BunnyHttpsNative.c" not in transcript and "CurlHttpsTransport.swift" not in transcript,
                "transport-build-unconfirmed")
        return {**self.hashes, "podfileLockSha256": c1.digest(self.staged / "apps/mobile/ios/Podfile.lock"),
                "minimumIOS": "16.4", "hermes": True, "ats": "PASS",
                "transportSymbolInspection": "PASS"}

    def start_fixture(self):
        certs = self.scratch / "certificates"
        version = self.command(("openssl", "version"), capture=True)
        if not version.startswith("OpenSSL 3."):
            prefix = self.command(("brew", "--prefix", "openssl@3"), capture=True)
            self.process_env["PATH"] = prefix + "/bin" + os.pathsep + self.process_env["PATH"]
        mobile = self.staged / "apps/mobile"
        self.command(("bash", str(mobile / "qualification/certificates.sh"), str(certs)), timeout=60)
        self.fixture = subprocess.Popen(("node", str(mobile / "qualification/server.ts"), str(certs)),
            env={**self.process_env, "BUNNY_HTTPS_STANDARD_JSON": "1", "FIXTURE_PORT": "29443"},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(100):
            require(self.fixture.poll() is None, "fixture-exited")
            try:
                with urllib.request.urlopen("http://127.0.0.1:29448/runtime", timeout=1) as response:
                    snapshot = json.load(response)
                require(snapshot["events"] == [] and snapshot["overflow"] is False, "fixture-contaminated")
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise c2.StageError("fixture-unavailable")
        listeners = self.command(("lsof", "-nP", "-a", "-p", str(self.fixture.pid), "-iTCP", "-sTCP:LISTEN"), capture=True)
        require(all("127.0.0.1:" + str(port) in listeners for port in range(29443, 29450)), "fixture-listeners-unconfirmed")
        self.runner.sim("keychain", self.runner.device, "add-root-cert", str(certs / "ca.pem"), code="ca-install-failed")
        return {"loopbackListeners": 7}

    def runtime(self):
        runner = self.runner
        runner.sim("install", runner.device, str(self.app), code="installation-refused", timeout=90)
        runner.installed = Path(runner.sim("get_app_container", runner.device, BUNDLE, "app",
                                        code="installed-app-missing", capture=True).output).resolve()
        require(runner.installed.is_relative_to(runner.device_set / runner.device), "installed-container-mismatch")
        require(runner.app_hashes(runner.installed) == self.hashes, "installed-app-mismatch")
        log = self.scratch / "app.log"
        with log.open("wb") as output:
            self.reader = subprocess.Popen(("xcrun", "simctl", "--set", str(runner.device_set),
                "spawn", runner.device, "log", "stream", "--level", "info", "--style", "compact",
                "--predicate", 'eventMessage CONTAINS "[BunnyHttpsStandardJson]"'),
                stdout=output, stderr=subprocess.DEVNULL, env=self.process_env, start_new_session=True)
        time.sleep(1)
        runner.pid = runner.launch_pid()
        deadline = time.monotonic() + 180
        collection_error = None
        while True:
            lines = log.read_text(errors="replace").splitlines()
            # Unified logs identify the application process independently from the simulator collector.
            own = [line for line in lines if f"[{runner.pid}:" in line and MARKER in line]
            try:
                runner.check_alive(explicit_identity=True)
                require(self.reader.poll() is None, "log-reader-exited")
            except c2.StageError as error:
                collection_error = error
                break
            if any(MARKER + "DONE" in line or MARKER + "UNAVAILABLE" in line for line in own):
                break
            if time.monotonic() >= deadline:
                collection_error = c2.StageError("qualification-timeout", verdict="NOT_RUN")
                break
            time.sleep(0.2)
        filtered = self.scratch / "filtered.log"
        filtered.write_text("\n".join(own))
        with urllib.request.urlopen("http://127.0.0.1:29448/runtime", timeout=5) as response:
            snapshot = json.load(response)
        wire = self.scratch / "runtime.json"
        wire.write_text(json.dumps(snapshot))
        result = self.runner.call("node", str(self.staged / "apps/mobile/qualification/verify-standard-json.ts"),
            "ios", str(filtered), str(wire), code="oracle-failed", capture=True, allowed=(0, 1))
        qualification = json.loads(result.output)
        self.report["qualification"] = qualification
        self.report["pid"] = runner.pid
        require(bool(qualification["scenarios"]), "plan-missing")
        if collection_error:
            raise collection_error
        require(qualification["verdict"] == "PASS", "qualification-rejected",
                verdict=qualification["verdict"])
        require(result.exit_code == 0 and qualification.get("appCompleted") is True
                and all(row["verdict"] == "PASS" for row in qualification["scenarios"]), "plan-incomplete")
        return {"installedHashesMatch": True, "scenarios": len(qualification["scenarios"])}

    def cleanup(self):
        evidence = {}
        failed = False
        for name, process in (("readerStopped", self.reader), ("fixtureStopped", self.fixture)):
            if process is None:
                continue
            try:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=15)
                require(name != "fixtureStopped" or process.returncode == 0, "fixture-close-unconfirmed")
                evidence[name] = "PASS"
            except Exception:
                failed = True
                evidence[name] = "FAIL"
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
        if self.runner is not None:
            if self.runner.pid is not None:
                try:
                    self.runner.stop()
                    evidence["appStopped"] = "PASS"
                except Exception:
                    failed = True
                    evidence["appStopped"] = "FAIL"
            try:
                self.runner.cleanup_device()
                evidence["simulatorRemoved"] = "PASS"
            except Exception:
                failed = True
                evidence["simulatorRemoved"] = "FAIL"
        # Preserve owned files when simulator cleanup cannot establish removal.
        if evidence.get("simulatorRemoved") != "FAIL":
            for path in (self.staged, self.scratch):
                if path is not None:
                    shutil.rmtree(path)
            evidence["workspaceRemoved"] = "PASS"
        if failed:
            error = c2.StageError("cleanup-unconfirmed")
            error.record.update(evidence)
            raise error
        return evidence


def main():
    os.umask(0o077)
    path = Path(sys.argv[1])
    path.parent.mkdir(parents=True, exist_ok=True)
    for event in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
        signal.signal(event, c1.interrupt)
    signal.alarm(5400)
    return Campaign(path, os.environ).run()


if __name__ == "__main__":
    sys.exit(main())
