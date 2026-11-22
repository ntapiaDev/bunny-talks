"""Project private Xcode errors into a small, allowlisted diagnostic report."""

import argparse
import json
import os
import re
import selectors
import stat
import subprocess
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit


MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_LOG_BYTES = 64 * 1024 * 1024
LOG_SECONDS = 15
XCRESULT_SECONDS = 30
MAX_LINE = 4096
MAX_DIAGNOSTICS = 12
TARGETS = frozenset({
    "ApplicationHttps", "BunnyTalks", "Expo", "ExpoModulesCore", "ExpoSQLite",
    "ExpoSecureStore", "ExpoArgon2", "hermes-engine", "Pods-BunnyTalks", "React-Core",
    "React-Core-prebuilt", "React-Fabric", "ReactCodegen", "ReactAppDependencyProvider",
    "expo-dev-client", "expo-dev-launcher", "expo-dev-menu",
})
FILES = frozenset({
    "AppDelegate.swift", "ExpoModulesProvider.swift", "ApplicationHttpsModule.swift",
    "CurlHttpsTransport.swift", "BunnyHttpsNative.c", "BunnyHttpsNative.h",
    "module.modulemap", "sqlite3.c", "sqlite3.h", "Podfile", "index.ts",
})
COMPONENTS = TARGETS | FILES | frozenset({
    "@bunny-talks/crypto-core", "@bunny-talks/crypto-backup", "@bunny-talks/crypto-engine", "@expo/cli",
    "BunnyHttpsNative", "ExpoModulesCore", "Foundation", "React", "Security", "UIKit",
    "curl/curl.h", "openssl/ssl.h", "zlib.h", "libcurl", "libssl", "libcrypto", "libopenssl",
    "_curl_multi_perform", "_curl_version_info", "_OPENSSL_init_ssl",
    "_bunny_https_perform", "_sqlite3_open", "_sqlite3_key", "arm64", "x86_64",
})

# Publish fixed messages. Only operands explicitly listed above can be interpolated.
RULES = (
    (r"^While trying to resolve module `([^`]+)` from file .+ specifies a `main` module field that could not be resolved",
     "bundling", "metro-package-entry", "Metro could not resolve a package entry point"),
    (r"^Unable to resolve (?:module )?[`'\" ]?([^\s`'\"]+)[`'\"]? from\b",
     "bundling", "metro-module-resolution", "Metro could not resolve a JavaScript import"),
    (r"^Can't find the '[^']+' binary to build the React Native bundle",
     "configuration", "node-unavailable", "React Native could not find the Node executable"),
    (r'^Could not find "node" executable while running an Xcode build script',
     "configuration", "expo-node-unavailable", "Expo could not find the Node executable"),
    (r"^Cannot find module '([^']+)'", "configuration", "node-module-missing", "Node could not load a required module"),
    (r"^Hermes is enabled but the hermesc binary could not be found",
     "configuration", "hermes-compiler-missing", "React Native could not find the Hermes compiler"),
    (r"^The sandbox is not in sync with the Podfile\.lock",
     "configuration", "pods-manifest-mismatch", "The installed pods do not match the lockfile"),
    (r"\bno such module '([^']+)'", "compilation", "module-not-found", "Swift module not found"),
    (r"\bcannot find '([^']+)' in scope", "compilation", "name-not-in-scope", "Swift name is not in scope"),
    (r"\b(?:use of undeclared identifier|call to undeclared function) '([^']+)'",
     "compilation", "undeclared-identifier", "C identifier or function is undeclared"),
    (r"""['<]([^'<>]+)['>] file not found""", "compilation", "header-not-found", "Header not found"),
    (r"\b(?:could not build (?:Objective-C )?module|failed to build module) '([^']+)'",
     "compilation", "module-build-failed", "Could not build compiler module"),
    (r"\b(?:cannot convert value of type|cannot assign value of type|incompatible (?:pointer|integer) conversion)\b",
     "compilation", "type-mismatch", "Compiler rejected a type conversion or assignment"),
    (r"\b(?:has no member|no member named)\b", "compilation", "member-not-found", "Compiler could not resolve a member"),
    (r"^expected (?:[\x27\x22]|expression|identifier|declaration|type)",
     "compilation", "syntax-error", "Compiler expected a different token, expression or declaration"),
    (r"\b(?:non-sendable type|actor-isolated .{1,120} cannot be)\b",
     "compilation", "concurrency-check", "Swift rejected an isolation or Sendable constraint"),
    (r"\b(?:module map file|module map).*\bnot found\b", "compilation", "module-map-not-found", "Module map not found"),
    (r"\b(?:undefined symbols? for architecture|undefined symbol:|symbol\(s\) not found for architecture)\s*['\"]?([A-Za-z0-9_.]+)?",
     "linkage", "undefined-symbols", "Linker reported undefined symbols"),
    (r"\bduplicate symbol\s+['\"]?([A-Za-z0-9_.]+)", "linkage", "duplicate-symbol", "Linker reported a duplicate symbol"),
    (r"""\b(?:library|framework) (?:(?:not found for -l)([A-Za-z0-9_.-]+)|['\"]([A-Za-z0-9_.-]+)['\"] not found\b)""",
     "linkage", "link-input-not-found", "Linker could not find a library or framework"),
    (r"\b(?:building for .{1,100}, but linking in|incompatible architecture|ignoring file .{1,512}missing required architecture)\b",
     "linkage", "architecture-mismatch", "Linker reported an incompatible architecture or platform"),
    (r"\blink(?:er command failed with exit code|er failed)\b", "linkage", "linker-failed", "Linker command failed"),
    (r"\b(?:unable to find (?:a )?destination|unable to find (?:the )?sdk|sdk .{1,100} cannot be located|iOS \d+(?:\.\d+)* is not installed)\b",
     "configuration", "sdk-or-destination-unavailable", "Xcode could not resolve the SDK or build destination"),
    (r"\b(?:no space left on device|disk quota exceeded)\b",
     "configuration", "disk-space", "Build host ran out of disk space or quota"),
    (r"\b(?:Sandbox: .{1,300}\bdeny\(|operation not permitted|permission denied)",
     "configuration", "access-denied", "Build operation was denied by file permissions or sandboxing"),
    (r"\b(?:build input file cannot be found|unable to open (?:base )?configuration|unable to load contents of file list)\b",
     "configuration", "build-input-unavailable", "Xcode could not load a build input or configuration file"),
    (r"\b(?:result bundle .{1,300} already exists|existing file at -resultBundlePath)\b",
     "configuration", "result-bundle-path", "Xcode could not create a new result bundle at the requested path"),
    (r"\b(?:no provisioning profiles|requires a development team|code signing is required|no signing certificate)\b",
     "configuration", "signing-configuration", "Xcode reported a signing configuration error"),
    (r"\bCommand PhaseScriptExecution failed with a nonzero exit code\b",
     "build-step", "script-failed", "An Xcode build script exited with an error"),
)
CLASSIFIERS = [(re.compile(pattern, re.I), category, code, message) for pattern, category, code, message in RULES]
LOCATED_ERROR = re.compile(r"^([^:\r\n]+):(\d{1,6})(?::(\d{1,6}))?: (?:fatal )?error: (.+)$")
TARGET_CONTEXT = re.compile(r" \(in target '([^']+)' from project '[^']+'\)$")
UNDEFINED_SYMBOL = re.compile(r'^\s*["\']([A-Za-z0-9_.]+)["\'], referenced from:$')
SUMMARY_COMMANDS = {
    "SwiftCompile": ("compilation", "swift-command-failed", "Swift compilation command failed"),
    "SwiftEmitModule": ("compilation", "swift-module-command-failed", "Swift module emission command failed"),
    "CompileC": ("compilation", "clang-command-failed", "Clang compilation command failed"),
    "Ld": ("linkage", "link-command-failed", "Xcode link command failed"),
    "PhaseScriptExecution": ("build-step", "script-failed", "An Xcode build script exited with an error"),
}
GENERIC_CODES = {entry[1] for entry in SUMMARY_COMMANDS.values()} | {"linker-failed", "metro-bundling-failed"}
PHASES = frozenset({
    "Bundle React Native code and images", "[Expo] Configure project", "[CP] Check Pods Manifest.lock",
    "[CP] Embed Pods Frameworks", "[CP] Copy Pods Resources", "[CP] Copy XCFrameworks",
    "[CP-User] [Hermes] Replace Hermes for the right configuration, if needed",
})
TASK_PREFIX = re.compile(rb"^[A-Z][A-Za-z0-9_-]* ")
MISSING_SCRIPT_COMMAND = re.compile(
    r"^(?:/[^:\r\n]+\.sh|/bin/(?:ba)?sh): (?:line [0-9]{1,6}: )?"
    r"(?:[^:\r\n]{0,1024}): (?:command not found|No such file or directory)$"
)


def location(source, line=None):
    if not isinstance(source, str) or len(source) > MAX_LINE:
        return {}
    if source.startswith("file:"):
        try:
            url = urlsplit(source)
        except ValueError:
            return {}
        if url.scheme != "file" or url.netloc or url.query:
            return {}
        source = unquote(url.path)
        match = re.search(r"(?:^|&)StartingLineNumber=(\d{1,6})(?:&|$)", url.fragment)
        line = int(match[1]) if match else None
    leaf = source.rsplit("/", 1)[-1]
    if leaf not in FILES:
        return {}
    result = {"file": leaf}
    if type(line) is int and 0 < line <= 999999:
        result["line"] = line
    return result


def project_message(text, target=None, source=None, line=None):
    if not isinstance(text, str) or not 0 < len(text) <= MAX_LINE:
        return None
    if any(not row.isascii() or not re.fullmatch(r"[\t -~]*", row) for row in text.split("\n")):
        return None
    text = text.removeprefix("Error: ")
    for matcher, category, code, message in CLASSIFIERS:
        match = matcher.search(text)
        if match:
            operand = match[match.lastindex] if match.lastindex else None
            return projected(category, code, message, target, source, line, operand)
    return None


def projected(category, code, message, target=None, source=None, line=None, operand=None):
    diagnostic = {"category": category, "code": code, "message": message, **location(source, line)}
    if isinstance(target, str) and target in TARGETS:
        diagnostic["target"] = target
    if operand in COMPONENTS:
        diagnostic["component"] = operand
    return diagnostic


def structured_diagnostics(result):
    if not isinstance(result, dict) or not isinstance(result.get("errors"), list):
        return
    for issue in result["errors"][:512]:
        if isinstance(issue, dict):
            yield project_message(issue.get("message"), issue.get("targetName"), issue.get("sourceURL"))


class BudgetExceeded(Exception):
    pass


def log_lines(path):
    deadline = time.monotonic() + LOG_SECONDS
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK), "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise OSError
        remaining = min(info.st_size, MAX_LOG_BYTES)
        skipping = False
        while remaining:
            if time.monotonic() >= deadline:
                raise BudgetExceeded("time-limit")
            row = stream.readline(min(MAX_LINE + 2, remaining))
            if not row:
                raise OSError
            remaining -= len(row)
            end = row.endswith(b"\n")
            if not remaining and not end and info.st_size > MAX_LOG_BYTES:
                break
            content = row.removesuffix(b"\n").removesuffix(b"\r")
            if not skipping and len(content) <= MAX_LINE and (end or not remaining):
                yield content
            elif not skipping and TASK_PREFIX.match(row):
                yield None  # An unreadable task header may have changed the active target.
            skipping = not end
        if info.st_size > MAX_LOG_BYTES:
            raise BudgetExceeded("byte-limit")


def phase_name(command):
    # Xcode escapes spaces and brackets in task titles. Require the whole title before the script path.
    title = command.removeprefix("PhaseScriptExecution ").split(" /", 1)[0]
    title = re.sub(r"\\([ \[\]])", r"\1", title)
    return title if title in PHASES else None


def log_message(content, target):
    error = LOCATED_ERROR.fullmatch(content)
    if error:
        return project_message(error[4], target, error[1], int(error[2]))
    for prefix in ("error: ", "Error: ", "fatal error: ", "ld: ", "clang: error: ", "xcodebuild: error: "):
        if content.startswith(prefix):
            return project_message(content[len(prefix):], target)
    if content.startswith(("Undefined symbols for architecture ", "Command PhaseScriptExecution failed", "Sandbox: ")):
        return project_message(content, target)
    return None


def log_diagnostics(path):
    summary = undefined = False
    active = first_error = None
    for row in log_lines(path):
        if row is None:
            active = first_error = None
            summary = undefined = False
            continue
        if not re.fullmatch(rb"[\t -~]*", row):
            if TASK_PREFIX.match(row):
                active = first_error = None
            undefined = False
            continue
        if not row:
            undefined = False
            continue
        content = row.decode("ascii")
        if content == "The following build commands failed:":
            summary = True
            active = first_error = None
            continue
        context = TARGET_CONTEXT.search(content)
        target = context[1] if context else None
        if context:
            content = content[:context.start()]
        if summary:
            command = content.strip().split(" ", 1)[0]
            if target and command in SUMMARY_COMMANDS:
                diagnostic = projected(*SUMMARY_COMMANDS[command], target)
                if command == "PhaseScriptExecution" and (phase := phase_name(content.strip())):
                    diagnostic["phase"] = phase
                yield diagnostic
            continue
        # Only carry a script error to its matching failure inside this Xcode task block.
        if content.startswith("PhaseScriptExecution "):
            active = (target, phase_name(content))
            first_error = None
            undefined = False
            continue
        command = content.partition(" ")[0]
        if command in SUMMARY_COMMANDS or (
            target and TASK_PREFIX.match(row) and command not in ("Command", "Undefined")
        ):
            active = first_error = None
            undefined = False
            continue
        if active and active[0] and target and target != active[0]:
            active = first_error = None
        if undefined:
            symbol = UNDEFINED_SYMBOL.fullmatch(content)
            if symbol and symbol[1] in COMPONENTS:
                yield projected("linkage", "undefined-symbol", "Linker could not resolve a symbol", operand=symbol[1])
            if not content.startswith((" ", "\t")):
                undefined = False
        if content.startswith("Undefined symbols for architecture "):
            undefined = True
        if content.startswith("ld: warning:"):
            continue
        diagnostic = log_message(content, target)
        if active:
            if diagnostic is None and MISSING_SCRIPT_COMMAND.fullmatch(content):
                diagnostic = projected("configuration", "script-command-unavailable",
                                       "The build script could not locate a command or input")
            if diagnostic and diagnostic["code"] == "script-failed":
                script_target, phase = active
                for item in (first_error, diagnostic):
                    if item:
                        if script_target in TARGETS:
                            item["target"] = script_target
                        if phase:
                            item["phase"] = phase
                        yield item
                active = first_error = None
            elif diagnostic and (not first_error or first_error["code"] in GENERIC_CODES):
                first_error = diagnostic
            elif not first_error and re.fullmatch(r"iOS Bundling failed(?: \d+ms [^\r\n]+)?", content):
                # Metro may print a more precise error after its progress line.
                first_error = projected("bundling", "metro-bundling-failed", "Metro reported a failed iOS bundle")
        elif diagnostic:
            yield diagnostic


def read_structured(bundle):
    command = ["xcrun", "xcresulttool", "get", "build-results", "--path", str(bundle)]
    deadline = time.monotonic() + XCRESULT_SECONDS
    data = bytearray()
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise BudgetExceeded("time-limit")
                    block = os.read(process.stdout.fileno(), min(65536, MAX_JSON_BYTES + 1 - len(data)))
                    if not block:
                        break
                    data.extend(block)
                    if len(data) > MAX_JSON_BYTES:
                        raise BudgetExceeded("byte-limit")
            if process.wait(timeout=max(0, deadline - time.monotonic())):
                raise subprocess.CalledProcessError(process.returncode, command)
        finally:
            if process.poll() is None:
                process.kill()
    return json.loads(data)


def read_exit_code(path):
    try:
        with path.open("rb") as stream:
            value = stream.read(6)
        if re.fullmatch(rb"[0-9]{1,3}\n", value) and int(value) <= 255:
            return int(value)
    except OSError:
        pass
    return None


def collect(scratch, build_outcome):
    report = {
        "verdict": "NOT_RUN",
        "xcodeExitCode": read_exit_code(scratch / "xcodebuild.exit"),
        "sources": [],
        "diagnostics": [],
        "limitReached": False,
        "quality": "not-run",
        "xcresultStatus": "not-run",
        "logStatus": "not-run",
        "logUsage": "not-run",
    }
    if build_outcome == "success":
        return {**report, "reason": "build-succeeded"}

    def add(source, diagnostic):
        if diagnostic in report["diagnostics"]:
            return
        if len(report["diagnostics"]) >= MAX_DIAGNOSTICS:
            raise BudgetExceeded("diagnostic-limit")
        if source not in report["sources"]:
            report["sources"].append(source)
        report["diagnostics"].append(diagnostic)

    bundle = scratch / "build.xcresult"
    try:
        if bundle.is_dir():
            structured = read_structured(bundle)
            if not isinstance(structured, dict) or not isinstance(structured.get("errors"), list):
                raise ValueError
            report["xcresultStatus"] = "no-recognized-error"
            for diagnostic in structured_diagnostics(structured):
                if diagnostic:
                    report["xcresultStatus"] = "recognized-errors"
                    add("xcresult", diagnostic)
            if len(structured["errors"]) > 512:
                report["limitReached"] = True
        else:
            report["xcresultStatus"] = "bundle-absent"
    except (ValueError, RecursionError):
        report["xcresultStatus"] = "invalid-output"
    except (OSError, subprocess.CalledProcessError):
        report["xcresultStatus"] = "invocation-failed"
    except (BudgetExceeded, subprocess.TimeoutExpired) as error:
        report["xcresultStatus"] = str(error) if isinstance(error, BudgetExceeded) else "time-limit"
        report["limitReached"] = True

    def technical_error():
        return any(row["code"] not in GENERIC_CODES for row in report["diagnostics"])

    report["logUsage"] = "supplement" if technical_error() else "fallback"
    try:
        for diagnostic in log_diagnostics(scratch / "xcodebuild.log"):
            add("log", diagnostic)
        report["logStatus"] = "complete"
    except BudgetExceeded as error:
        report["logStatus"] = str(error)
        report["limitReached"] = True
    except OSError:
        report["logStatus"] = "unavailable"

    if technical_error():
        report["quality"] = "technical-error"
    elif any(row.get("phase") for row in report["diagnostics"]):
        report["quality"] = "phase-only"
    elif report["diagnostics"]:
        report["quality"] = "generic"
    else:
        return {**report, "quality": "unknown", "reason": "no-publishable-diagnostic"}
    return {**report, "verdict": "PASS", "reason": "diagnostics-collected"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("scratch", type=Path)
    parser.add_argument("build_outcome", choices=("success", "failure"))
    args = parser.parse_args()
    print(json.dumps(collect(args.scratch, args.build_outcome), indent=2, sort_keys=True))
