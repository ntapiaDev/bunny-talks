"""Run the restricted C2 hosted feasibility study; no application is built or installed."""

import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time


MOBILE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("c2_feasibility_support", MOBILE / "scripts/prepare-ios-standard-https.py")
c2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c2)
c1 = c2.c1
STAGES = ("revision", "source", "archive", "toolchain", "simulator", "fixture", "networkObservation", "cleanup")
OUT_OF_SCOPE = ("fullConfinement", "nativeEquivalence", "candidateRuntime", "standardHttpsRuntime")


def export_source(archive, destination):
    """Extract only ordinary files and directories from the SHA-addressed GitHub archive."""
    destination.mkdir(mode=0o700)
    with tarfile.open(archive, "r:gz") as source:
        members = source.getmembers()
        c2.require(0 < len(members) <= 50000, "source-archive-invalid")
        root = None
        seen = set()
        total = 0
        for member in members:
            parts = PurePosixPath(member.name).parts
            c2.require(parts and all(part not in (".", "..") for part in parts)
                       and not member.name.startswith("/"), "source-archive-invalid")
            root = root or parts[0]
            c2.require(parts[0] == root and (member.isdir() or member.isfile()), "source-archive-invalid")
            if len(parts) == 1:
                c2.require(member.isdir(), "source-archive-invalid")
                continue
            relative = PurePosixPath(*parts[1:])
            c2.require(relative not in seen, "source-archive-invalid")
            seen.add(relative)
            target = destination.joinpath(*relative.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                total += member.size
                c2.require(member.size <= 100_000_000 and total <= 500_000_000, "source-archive-invalid")
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as stream, target.open("xb") as out:
                    shutil.copyfileobj(stream, out)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)


def checkout_inventory(root):
    c2.require(root.is_dir() and not root.is_symlink(), "checkout-invalid")
    entries = {}
    for directory, dirs, files in os.walk(root):
        if Path(directory) == root and ".git" in dirs:
            dirs.remove(".git")
        for name in dirs + files:
            path = Path(directory) / name
            c2.require(not path.is_symlink(), "checkout-invalid")
            if name in files:
                c2.require(path.is_file(), "checkout-invalid")
                entries[path.relative_to(root).as_posix()] = [c1.digest(path), path.stat().st_mode & 0o777]
    return entries


class Feasibility:
    def __init__(self, report_path, env):
        self.report_path, self.env = report_path, env
        self.process_env = {name: env[name] for name in
                            ("HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL",
                             "DEVELOPER_DIR") if name in env}
        self.scratch = None
        self.work = None
        self.context = None
        self.fixture = None
        self.report = {"schemaVersion": 1, "scope": "ios-hosted-feasibility-c2-b1",
                       "revision": None, "run": None, "verdict": "NOT_RUN", "complete": False,
                       "stages": {name: {"verdict": "NOT_RUN"} for name in STAGES},
                       **{name: "NOT_RUN" for name in OUT_OF_SCOPE}}

    def save(self):
        temporary = self.report_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.report, sort_keys=True, separators=(",", ":")) + "\n")
        temporary.replace(self.report_path)

    def stage(self, name, action):
        self.report["stages"][name] = {"verdict": "NOT_RUN", "code": "interrupted"}
        self.save()
        try:
            evidence = action()
            self.report["stages"][name] = {"verdict": "PASS", **(evidence or {})}
        except c1.Interrupted:
            raise
        except c2.StageError as error:
            self.report["stages"][name] = error.record
            raise
        except Exception:
            self.report["stages"][name] = {"verdict": "FAIL", "code": name + "-unavailable"}
            raise
        finally:
            self.save()

    def isolated_command(self, args, **kwargs):
        return c1.run_command(args, env=self.process_env, **kwargs)

    def command(self, args, timeout=30, output=None, capture=False, *, github=False):
        try:
            env = self.process_env
            if github:
                c2.require(bool(self.env.get("GH_TOKEN")), "github-token-unavailable")
                env = {**env, "GH_TOKEN": self.env["GH_TOKEN"]}
            result = c1.run_command(args, cwd=self.scratch, timeout=timeout, output=output, capture=capture,
                                    env=env)
        except subprocess.TimeoutExpired:
            raise c2.StageError("command-timeout") from None
        c2.require(result.exit_code == 0, "command-failed")
        return result.output

    def revision(self):
        sha = self.env.get("GITHUB_SHA", "")
        c2.validate_revision(sha, self.env.get("REVIEWED_SHA"))
        c2.require(sha == self.env.get("CHECKED_OUT_SHA"), "checkout-sha-mismatch")
        tree = self.env.get("REVIEWED_TREE_SHA256", "")
        c2.require(c2.hex_value(tree), "reviewed-tree-invalid")
        c2.require(self.env.get("GITHUB_REPOSITORY") == "ntapiaDev/bunny-talks"
                   and self.env.get("RUNNER_ENVIRONMENT") == "github-hosted"
                   and self.env.get("GITHUB_RUN_ATTEMPT") == "1", "runner-not-approved")
        c2.check_environment(self.env)
        c2.require(not any(name in self.env for name in ("NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV")),
                   "environment-overrides")
        self.report["revision"] = sha
        run = self.env.get("GITHUB_RUN_ID", "")
        self.report["run"] = int(run) if re.fullmatch(r"[0-9]{1,20}", run) else None
        self.scratch = Path(tempfile.mkdtemp(prefix="bunny-c2-b1-", dir="/tmp")).resolve()
        self.work = self.scratch / "work"
        return {"reviewedTreeSha256": tree}

    def source(self):
        archive = self.scratch / "source.tar.gz"
        self.command(("gh", "api", "repos/ntapiaDev/bunny-talks/tarball/" + self.report["revision"]),
                     timeout=120, output=archive, github=True)
        export_source(archive, self.scratch / "source")
        entries = c2.manifest(self.scratch / "source")
        digest = c2.tree_digest(entries)
        c2.require(digest == self.env["REVIEWED_TREE_SHA256"], "reviewed-tree-mismatch")
        checkout = Path(self.env["GITHUB_WORKSPACE"])
        c2.require(checkout_inventory(checkout) == entries, "checkout-source-mismatch")
        return {"treeSha256": digest, "origin": "github-sha-tarball", "checkoutMatches": True}

    def archive(self, *, candidate_only=False):
        path = self.scratch / "xcframeworks.zip"
        self.command(("gh", "api", "repos/ntapiaDev/bunny-talks/actions/artifacts/14723035221/zip"),
                     timeout=120, output=path, github=True)
        raw, proof = c2.verify_archive(path)
        staging = c2.stage_pair(self.scratch / "source", self.work, self.env["REVIEWED_TREE_SHA256"],
                                raw, self.report["revision"], candidate_only=candidate_only)
        self.context = {key: staging[key] for key in ("runId", "treeSha256", "revision", "zipSha256")}
        c2.verify_staging(self.scratch / "source", self.work, self.context["treeSha256"], candidate_only=candidate_only)
        return {"artifactId": 14723035221, "sha256": proof["zipSha256"], "staging": "PASS"}

    def toolchain(self):
        runner = c2.simulator(self.work, self.context, command=self.isolated_command)
        runner.verify_toolchain()
        runner.find_runtime()
        return {"toolchain": runner.evidence["toolchain"], "simulator": runner.evidence["simulator"]}

    def simulator(self):
        c2.boot_environment(self.work, self.context, None, hosted_feasibility=True, command=self.isolated_command)
        return {"model": "iPhone 17", "ios": "26.5", "booted": True}

    def start_fixture(self):
        certs = self.work / "certificates"
        version = self.command(("openssl", "version"), timeout=10, capture=True)
        if not version.startswith("OpenSSL 3."):
            prefix = Path(self.command(("brew", "--prefix", "openssl@3"), timeout=20, capture=True))
            c2.require(prefix.is_absolute() and (prefix / "bin/openssl").is_file(), "openssl-unavailable")
            self.process_env["PATH"] = str(prefix / "bin") + os.pathsep + self.process_env["PATH"]
            version = self.command(("openssl", "version"), timeout=10, capture=True)
        c2.require(version.startswith("OpenSSL 3."), "openssl-unavailable")
        self.command(("bash", str(MOBILE / "qualification/certificates.sh"), str(certs)), timeout=60)
        pilot = MOBILE / "qualification/run-ios-libcurl-runtime.mjs"
        self.fixture = subprocess.Popen(("node", str(pilot), "--standard-fixture", str(self.work), str(certs)),
                                        cwd=MOBILE, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.DEVNULL, start_new_session=True, env=self.process_env)
        deadline = time.monotonic() + 30
        while not (self.work / "fixture.json").exists():
            c2.require(self.fixture.poll() is None, "fixture-start-failed")
            c2.require(time.monotonic() < deadline, "fixture-start-timeout")
            time.sleep(0.1)
        env = c2.load_receipt(self.work, "environment", self.context)
        c2.load_fixture(self.work, self.context, env)
        self.command(("node", str(pilot), "--standard-check", str(self.work)), timeout=10)
        # lsof inspects the fixture process itself, rather than trusting configuration alone.
        output = self.command(("lsof", "-nP", "-a", "-p", str(self.fixture.pid), "-iTCP", "-sTCP:LISTEN"),
                              timeout=10, capture=True)
        listeners = re.findall(r"\b127\.0\.0\.1:(\d+)\s+\(LISTEN\)", output)
        c2.require(sorted(map(int, listeners)) == list(c2.PORTS), "fixture-listeners-unconfirmed")
        return {"loopbackListeners": 7, "controlResponse": "PASS"}

    def network(self):
        capabilities = {}
        for name, command in (("interfaces", ("ifconfig", "-l")), ("routes", ("netstat", "-rn")),
                              ("sockets", ("lsof", "-nP", "-iTCP", "-sTCP:LISTEN")),
                              ("packetInterfaces", ("tcpdump", "-D"))):
            try:
                self.command(command, timeout=10)
                capabilities[name] = "AVAILABLE"
            except (c2.StageError, OSError):
                capabilities[name] = "UNAVAILABLE"
        return {"capabilities": capabilities}

    def cleanup(self):
        ok = True
        evidence = dict.fromkeys(("fixtureStopped", "simulatorRemoved", "workspaceRemoved"), "NOT_RUN")
        if self.fixture is not None:
            try:
                if self.fixture.poll() is None:
                    try:
                        os.killpg(self.fixture.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                self.fixture.wait(timeout=15)
                if (self.work / "fixture-start.json").exists():
                    started = c2.load_receipt(self.work, "fixture-start", self.context)
                    stopped = c2.load_receipt(self.work, "fixture-stopped", self.context)
                    ok = (c2.hex_value(started.get("fixtureId"), 32)
                          and stopped.get("fixtureId") == started["fixtureId"]
                          and stopped.get("closed") is True and self.fixture.returncode == 0)
                else:
                    ok = self.fixture.returncode == 0
            except (OSError, subprocess.TimeoutExpired, c2.StageError, ValueError, KeyError):
                ok = False
                try:
                    os.killpg(self.fixture.pid, signal.SIGKILL)
                    self.fixture.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    pass
            evidence["fixtureStopped"] = "PASS" if ok else "FAIL"
        if self.context is not None:
            simulator_created = (self.work / "simulators").exists()
            try:
                c2.cleanup_simulator(self.work, self.context, command=self.isolated_command)
                if simulator_created:
                    evidence["simulatorRemoved"] = "PASS"
            except Exception as error:
                ok = False
                evidence["simulatorRemoved"] = (error.record.get("simulatorRemoved", "FAIL")
                                                if isinstance(error, c2.StageError) else "FAIL")
        if self.scratch is not None:
            try:
                shutil.rmtree(self.scratch)
                evidence["workspaceRemoved"] = "FAIL" if self.scratch.exists() else "PASS"
            except OSError:
                evidence["workspaceRemoved"] = "FAIL"
        if not ok or "FAIL" in evidence.values():
            error = c2.StageError("cleanup-unconfirmed")
            error.record.update(evidence)
            raise error
        return evidence

    def steps(self):
        return (("revision", self.revision), ("source", self.source), ("archive", self.archive),
                ("toolchain", self.toolchain), ("simulator", self.simulator),
                ("fixture", self.start_fixture), ("networkObservation", self.network))

    def run(self):
        self.save()
        interrupted = False
        try:
            for name, action in self.steps():
                self.stage(name, action)
        except c1.Interrupted:
            interrupted = True
        except Exception:
            pass
        finally:
            signal.alarm(0)
            try:
                self.stage("cleanup", self.cleanup)
            except Exception:
                pass
        states = [item["verdict"] for item in self.report["stages"].values()]
        self.report["complete"] = not interrupted and all(
            item.get("code") != "interrupted" for item in self.report["stages"].values())
        self.report["verdict"] = "FAIL" if "FAIL" in states else "PASS" if all(x == "PASS" for x in states) else "NOT_RUN"
        self.save()
        return 0 if self.report["verdict"] == "PASS" else 1


def main():
    os.umask(0o077)
    report_dir = Path(os.environ["RUNNER_TEMP"]).resolve() / "bunny-ios-c2-b1-proof"
    report_dir.mkdir(mode=0o700, exist_ok=True)
    signal.signal(signal.SIGINT, c1.interrupt)
    signal.signal(signal.SIGTERM, c1.interrupt)
    signal.signal(signal.SIGALRM, c1.interrupt)
    signal.alarm(720)
    return Feasibility(report_dir / "report.json", os.environ).run()


if __name__ == "__main__":
    sys.exit(main())
