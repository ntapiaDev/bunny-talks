"""Local checks for the laboratory staging and Swift invocation evidence."""

import importlib.util
import json
from pathlib import Path
import shlex
import tempfile
import unittest

MOBILE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("https_lab", MOBILE / "scripts/run-ios-standard-https-lab.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class LaboratoryTests(unittest.TestCase):
    def test_configuration_delta_is_limited_to_the_lab_identity_origin_and_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            mobile = Path(directory)
            for name in ("app.json", "package.json"):
                (mobile / name).write_bytes((MOBILE / name).read_bytes())
            worker.configure(mobile)
            app = json.loads((mobile / "app.json").read_bytes())
            self.assertEqual(app["expo"]["ios"]["bundleIdentifier"], worker.BUNDLE)
            self.assertEqual(app["expo"]["ios"]["infoPlist"].pop(worker.ORIGIN_KEY), worker.ORIGIN)
            app["expo"]["ios"]["bundleIdentifier"] = worker.inspection.BUNDLE_ID
            self.assertEqual(app, json.loads((MOBILE / "app.json").read_bytes()))
            package = json.loads((mobile / "package.json").read_bytes())
            self.assertEqual(package["main"], worker.ENTRY)
            package["main"] = "index.ts"
            self.assertEqual(package, json.loads((MOBILE / "package.json").read_bytes()))

    def test_compares_scoped_swift_invocation_and_rejects_macro_in_response_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commands = []
            for name in ("standard", "laboratory"):
                build = root / name
                build.mkdir()
                response = build / "ApplicationHttps.SwiftFileList"
                files = [root / "apps/mobile/modules/application-https/ios" / file
                         for file in worker.NATIVE_FILES if file.endswith(".swift")]
                response.write_text("\n".join(shlex.quote(str(path)) for path in files))
                command = ("swiftc", "-module-name", "ApplicationHttps", "-target",
                           "arm64-apple-ios16.4-simulator", "-sdk", "/Xcode/iPhoneSimulator.sdk",
                           "-O", "@" + str(response))
                log = build / "xcodebuild.log"
                log.write_text("SwiftDriver ApplicationHttps normal arm64 swift (in target "
                               "'ApplicationHttps' from project 'Pods')\n"
                               "    builtin-SwiftDriver -- " + shlex.join(command) + "\n")
                commands.append(worker.swift_driver(log, root, build, planned=name == "standard"))
            self.assertEqual(*commands)
            response.write_text(response.read_text() + "\n-D " + worker.MACRO)
            with self.assertRaises(worker.c1.StageError) as error:
                worker.swift_driver(log, root, build)
            self.assertEqual(error.exception.record["code"], "swift-driver-qualification-flags")

    def test_missing_standard_plan_is_not_conclusive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / "xcodebuild.log"
            log.write_text("Build description signature: opaque\n")
            with self.assertRaises(worker.c1.StageError) as error:
                worker.swift_driver(log, root, root, planned=True)
            self.assertEqual(error.exception.record["verdict"], "NOT_RUN")


if __name__ == "__main__":
    unittest.main()
