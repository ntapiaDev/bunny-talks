"""Build and exercise a single laboratory Release of the standard iOS HTTPS module."""

import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location("candidate", Path(__file__).with_name("run-ios-urlsession-campaign.py"))
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)
c1, require = candidate.c1, candidate.require
provenance = candidate.provenance
inspection = candidate.inspection

BUNDLE = "fr.bunnytalks.mobile.httpslab"
ORIGIN_KEY = "BunnyApplicationHttpsOrigin"
ORIGIN = "https://localhost:29443"
ENTRY = "qualification/ios-standard-https-lab-entry.tsx"
ORACLE = "qualification/verify-ios-standard-https-lab.ts"
MARKER = "[BunnyIosStandardHttpsLab] "
SCOPE = "ios-standard-https-laboratory-release"
PHASES = ("before-trust", "wrong-name", "refusals", "nominal", "loss")
NATIVE_FILES = ("ApplicationHttpsModule.swift", "UrlSessionHttpsTransport.swift", "ApplicationHttps.podspec")
POD_KEYS = (
    "ARCHS", "CONFIGURATION", "DEFINES_MODULE", "ENABLE_TESTABILITY", "FRAMEWORK_SEARCH_PATHS",
    "GCC_PREPROCESSOR_DEFINITIONS", "HEADER_SEARCH_PATHS", "IPHONEOS_DEPLOYMENT_TARGET",
    "LIBRARY_SEARCH_PATHS", "MACH_O_TYPE", "MODULEMAP_FILE", "OTHER_CFLAGS", "OTHER_CPLUSPLUSFLAGS",
    "OTHER_LDFLAGS", "OTHER_SWIFT_FLAGS", "PRODUCT_MODULE_NAME", "SDKROOT",
    "SWIFT_ACTIVE_COMPILATION_CONDITIONS", "SWIFT_COMPILATION_MODE", "SWIFT_OPTIMIZATION_LEVEL",
    "SWIFT_VERSION",
)
MACRO = "BUNNY_HTTPS_URLSESSION_QUALIFICATION"


def configure(mobile):
    app_path, package_path = (mobile / name for name in ("app.json", "package.json"))
    app, package = (c1.read_json(path) for path in (app_path, package_path))
    ios = app["expo"]["ios"]
    require(ios["bundleIdentifier"] == inspection.BUNDLE_ID and package["main"] == "index.ts",
            "standard-source-identity")
    require(ORIGIN_KEY not in ios["infoPlist"], "standard-origin-already-set")
    ios["bundleIdentifier"] = BUNDLE
    ios["infoPlist"][ORIGIN_KEY] = ORIGIN
    package["main"] = ENTRY
    for path, data in ((app_path, app), (package_path, package)):
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def pod_settings(path):
    rows = c1.read_json(path)
    inspection.check_pod_settings(rows, urlsession=True)
    https = next(row["buildSettings"] for row in rows if row["target"] == "ApplicationHttps")
    require(https.get("PRODUCT_MODULE_NAME") == "ApplicationHttps"
            and https.get("IPHONEOS_DEPLOYMENT_TARGET") in ("16.4", "16.4.0")
            and https.get("SWIFT_OPTIMIZATION_LEVEL") in ("-O", "-Osize"),
            "transport-release-settings-unconfirmed")
    return {key: https.get(key) for key in POD_KEYS}


def swift_driver(log, source_root, build_root, *, planned=False):
    rows = set()
    active = False
    for line in log.read_text(errors="replace").splitlines():
        if line and not line[0].isspace():
            active = line.startswith("SwiftDriver ApplicationHttps normal arm64 ") and "from project 'Pods'" in line
        if active and line.lstrip().startswith("builtin-SwiftDriver -- "):
            rows.add(tuple(shlex.split(line.strip())[2:]))
    require(len(rows) == 1, "swift-driver-command-unavailable", verdict="NOT_RUN")
    args = list(rows.pop())
    require(Path(args[0]).name == "swiftc" and "-module-name" in args
            and args[args.index("-module-name") + 1] == "ApplicationHttps",
            "swift-driver-target-mismatch")
    require(any(re.fullmatch(r"arm64-apple-ios16\.4(?:\.0)?-simulator", arg) for arg in args)
            and "-sdk" in args and "iPhoneSimulator" in args[args.index("-sdk") + 1]
            and any(arg in ("-O", "-Osize") for arg in args), "swift-driver-release-mismatch")
    require(not any(MACRO in arg or arg in ("-DDEBUG", "DEBUG") for arg in args),
            "swift-driver-qualification-flags")
    if not planned:
        files = [arg for arg in args if arg.endswith(".swift")]
        for arg in args:
            if arg.startswith("@"):
                path = Path(arg[1:]).resolve()
                require(path.is_relative_to(build_root.resolve()) and path.is_file()
                        and path.stat().st_size < 2 * 1024 * 1024,
                        "swift-driver-file-list-unavailable", verdict="NOT_RUN")
                content = path.read_text()
                require(MACRO not in content, "swift-driver-qualification-flags")
                files.extend(line for line in shlex.split(content) if line.endswith(".swift"))
        expected = {(source_root / "apps/mobile/modules/application-https/ios" / name).resolve()
                    for name in NATIVE_FILES if name.endswith(".swift")}
        require({Path(value).resolve() for value in files} == expected, "swift-driver-sources-mismatch")

    def normalize(arg):
        for root, label in ((build_root, "{build}"), (source_root, "{source}")):
            for spelling in {str(root), str(root.resolve()), str(root).removeprefix("/private")}:
                arg = arg.replace(spelling + "/", label + "/")
        return arg

    return tuple(map(normalize, args))


class Campaign(candidate.Campaign):
    bundle_id = BUNDLE

    def __init__(self, report_path, env):
        super().__init__(report_path, env)
        self.root_install_attempted = False
        self.report.update(scope=SCOPE, qualification={phase: {"verdict": "NOT_RUN"} for phase in PHASES},
                           laboratoryHttpsRuntime="NOT_RUN")

    def steps(self):
        return (
            ("revision", self.revision), ("source", self.source), ("staging", self.staging),
            ("toolchain", self.toolchain), ("simulator", self.simulator), ("build", self.build),
            ("provenance", self.provenance), ("swiftCommandComparison", self.compare_compilation),
            ("fixture", self.start_fixture), ("runtime", self.runtime),
        )

    def staging(self):
        source = self.scratch / "source"
        self.staged = shutil.copytree(source, self.scratch / "staged", copy_function=shutil.copy2)
        self.mobile = self.staged / "apps/mobile"
        require(candidate.manifest(self.staged) == candidate.manifest(source), "staging-source-mismatch")
        inspection.check_urlsession_sources(self.mobile)
        self.native_hashes = self.native_sources()
        return {"nativeSources": self.native_hashes, "standardSourceMatchesReviewedTree": True}

    def native_sources(self):
        module = self.mobile / "modules/application-https"
        return {name: c1.digest(module / name) for name in (
            "expo-module.config.json", *("ios/" + name for name in NATIVE_FILES),
        )}

    def prepare_project(self, output, bundle):
        ios = self.mobile / "ios"
        self.runner.call("pnpm", "exec", "expo", "prebuild", "--platform", "ios", "--no-install", "--no-clean",
                         cwd=self.mobile, timeout=180, code="expo-prebuild-failed")
        inspection.check_generated(ios, bundle_id=bundle)
        plist = inspection.read_plist(ios / "BunnyTalks/Info.plist")
        self.check_origin(plist, bundle)
        self.runner.call("pod", "install", cwd=ios, timeout=600, code="pods-install-failed")
        self.runner.call("xcodebuild", "-project", "Pods/Pods.xcodeproj", "-target", "ApplicationHttps",
                         "-target", "ExpoSQLite", "-configuration", "Release", "-sdk", "iphonesimulator",
                         "-showBuildSettings", "-json", cwd=ios, output=output, timeout=120,
                         code="pod-settings-unavailable")
        return pod_settings(output)

    def check_origin(self, plist, bundle):
        inspection.check_ats(plist)
        if bundle == BUNDLE:
            require(plist.get(ORIGIN_KEY) == ORIGIN, "laboratory-origin-mismatch")
        else:
            require(ORIGIN_KEY not in plist, "unexpected-standard-origin")

    def build(self):
        self.prepare_dependencies()
        self.runner.evidence["toolchain"]["pnpm"] = candidate.PNPM_VERSION
        pods = self.runner.call("pod", "--version", capture=True, code="pods-version-unavailable").output
        require(re.fullmatch(r"[0-9]{1,2}\.[0-9]{1,2}\.[0-9]{1,2}", pods), "pods-version-unavailable")
        self.runner.evidence["toolchain"]["cocoaPods"] = pods
        self.report["stages"]["toolchain"]["toolchain"] = self.runner.evidence["toolchain"]
        ios = self.mobile / "ios"
        self.baseline = self.scratch / "standard-plan"
        self.baseline.mkdir()
        reference = self.prepare_project(self.baseline / "pod-settings.json", inspection.BUNDLE_ID)
        standard_lock = c1.digest(ios / "Podfile.lock")
        require(self.native_sources() == self.native_hashes, "standard-native-source-mismatch")
        self.plan_error = None
        try:
            self.runner.compile_release(ios, self.baseline, verbose=True, dry_run=True)
            require(not any((self.baseline / "DerivedData").rglob("*.o")),
                    "dry-run-produced-object")
        except c1.StageError as error:
            if error.record.get("code") not in ("xcodebuild-failed", "command-timeout"):
                raise
            self.plan_error = "standard-command-plan-unavailable"

        # Only the disposable generated project is replaced between plan and compilation.
        require(ios.is_dir() and not ios.is_symlink(), "generated-project-mismatch")
        shutil.rmtree(ios)
        configure(self.mobile)

        self.output = self.scratch / "build"
        self.output.mkdir()
        self.settings = self.output / "pod-settings.json"
        observed = self.prepare_project(self.settings, BUNDLE)
        require(reference == observed and c1.digest(ios / "Podfile.lock") == standard_lock,
                "standard-pod-settings-mismatch")
        require(self.native_sources() == self.native_hashes, "laboratory-native-source-mismatch")
        try:
            self.runner.compile_release(ios, self.output, verbose=True)
        except c1.StageError as error:
            error.record["buildDiagnostics"] = self.runner.collect_build_diagnostics(
                self.output, error.record.get("exitCode"))
            raise
        self.app = self.output / "DerivedData/Build/Products/Release-iphonesimulator/BunnyTalks.app"
        return {"configuration": "Release", "architecture": "arm64", "appleBuilds": 1,
                "equalEffectivePodKeys": sorted(reference), "podfileLockSha256": standard_lock}

    def provenance(self):
        release = inspection.inspect_release(
            self.output / "DerivedData", self.output / "bundle.map", self.settings, None,
            mobile=self.mobile, bundle_id=BUNDLE, urlsession=True,
            laboratory_sources={Path(ENTRY).name, "ios-standard-https-lab-plan.ts", "standard-json-scenarios.ts"},
        )
        info = self.app / "Info.plist"
        self.check_origin(inspection.read_plist(info), BUNDLE)
        self.info_hash = c1.digest(info)
        self.hashes = self.runner.app_hashes(self.app)
        require(all(release[key] == value for key, value in self.hashes.items()), "inspected-app-mismatch")
        self.actual_command = swift_driver(self.output / "xcodebuild.log", self.staged, self.output)
        return {**release, "infoPlistSha256": self.info_hash, "laboratoryOrigin": ORIGIN,
                "actualSwiftDriverSha256": provenance.evidence_digest(self.actual_command)}

    def compare_compilation(self):
        evidence = {"laboratoryExecutedSha256": provenance.evidence_digest(self.actual_command)}
        if self.plan_error:
            return {**evidence, "verdict": "NOT_RUN", "code": self.plan_error}
        try:
            planned = swift_driver(self.baseline / "xcodebuild.log", self.staged, self.baseline, planned=True)
        except c1.StageError as error:
            return {**evidence, **error.record}
        evidence["standardPlannedSha256"] = provenance.evidence_digest(planned)
        if planned != self.actual_command:
            return {**evidence, "verdict": "FAIL", "code": "standard-swift-driver-command-mismatch"}
        return evidence

    def start_fixture(self):
        self.certs = self.prepare_certificates()
        args = ("openssl", "verify", "-CAfile", str(self.certs / "ca.pem"))
        self.command((*args, "-verify_hostname", "localhost", str(self.certs / "server.pem")))
        self.command((*args, str(self.certs / "wrong.pem")))
        wrong = self.runner.call(*args, "-verify_hostname", "localhost", str(self.certs / "wrong.pem"),
                                 allowed=(2,), code="wrong-name-control-invalid")
        require(wrong.exit_code == 2, "wrong-name-control-invalid")
        return {"rootSha256": c1.digest(self.certs / "ca.pem"),
                "matchingLeafSha256": c1.digest(self.certs / "server.pem"),
                "wrongNameLeafSha256": c1.digest(self.certs / "wrong.pem")}

    def run_phase(self, phase):
        self.fixture = subprocess.Popen(
            ("node", str(self.mobile / ORACLE), "fixture", phase, str(self.certs)),
            env=self.process_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )
        evidence = self.wait_for_fixture(require_empty_connections=True)
        filtered, collection_error = self.collect_runtime(
            self.scratch / (phase + ".log"), MARKER, "-BunnyHttpsLabPhase", phase,
        )
        # Keep the app alive while observing closures and the absence of a replay.
        time.sleep(0.7)
        if collection_error is None:
            self.runner.check_alive(explicit_identity=True)
        wire = self.scratch / (phase + "-wire.json")
        self.fixture_snapshot(wire)
        observed = self.runner.call(
            "node", str(self.mobile / ORACLE), "verify", phase, str(filtered), str(wire),
            code="oracle-failed", capture=True, allowed=(0, 1),
        )
        report = json.loads(observed.output)
        self.report["qualification"][phase].update(evidence, **report, pid=self.runner.pid)
        if collection_error:
            raise collection_error
        self.runner.stop()
        self.runner.pid = None
        if self.reader.poll() is None:
            os.killpg(self.reader.pid, signal.SIGTERM)
        self.reader.wait(timeout=15)
        self.reader = None
        os.killpg(self.fixture.pid, signal.SIGTERM)
        require(self.fixture.wait(timeout=15) == 0, "fixture-close-unconfirmed")
        self.fixture = None
        self.report["qualification"][phase]["stopped"] = True
        require((observed.exit_code == 0) == (report["verdict"] == "PASS"), "oracle-verdict-mismatch")
        return report["verdict"]

    def runtime(self):
        self.install()
        require(c1.digest(self.runner.installed / "Info.plist") == self.info_hash, "installed-plist-mismatch")
        self.report["installed"] = {**self.hashes, "infoPlistSha256": self.info_hash}
        observed = []
        for phase in PHASES:
            observed.append(self.run_phase(phase))
            if "FAIL" in observed:
                self.report["laboratoryHttpsRuntime"] = "FAIL"
            self.save()
            if phase == "before-trust":
                require(observed[-1] == "PASS", "untrusted-control-unconfirmed", verdict=observed[-1])
                self.root_install_attempted = True
                self.runner.sim("keychain", self.runner.device, "add-root-cert", str(self.certs / "ca.pem"),
                                code="ca-install-failed")
        self.report["laboratoryHttpsRuntime"] = (
            "FAIL" if "FAIL" in observed else "NOT_RUN" if "NOT_RUN" in observed else "PASS"
        )
        return {"verdict": self.report["laboratoryHttpsRuntime"],
                "installedHashesMatch": True, "phases": len(observed)}

    def cleanup(self):
        try:
            result = super().cleanup()
        finally:
            # Remove leaf and root private material even when simulator removal fails.
            if self.scratch is not None and (self.scratch / "certificates").exists():
                shutil.rmtree(self.scratch / "certificates")
        if self.root_install_attempted:
            require(self.runner.evidence.get("simulatorRemoved") is True, "ca-removal-unconfirmed")
            result["laboratoryTrustStateRemoved"] = "PASS"
        return result


if __name__ == "__main__":
    os.umask(0o077)
    destination = Path(sys.argv[1])
    destination.parent.mkdir(parents=True, exist_ok=True)
    for event in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
        signal.signal(event, c1.interrupt)
    signal.alarm(5400)
    sys.exit(Campaign(destination, os.environ).run())
