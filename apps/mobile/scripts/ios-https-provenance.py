"""Shared provenance primitives for the active HTTPS qualification workflows."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import shutil
import subprocess
import tarfile
import tempfile


OVERRIDES = {
    "BUNNY_HTTPS_QUALIFICATION", "BUNNY_IOS_HTTPS_QUALIFICATION", "XCODE_XCCONFIG_FILE",
    "ENTRY_FILE", "EXTRA_PACKAGER_ARGS", "BUNDLE_COMMAND", "SKIP_BUNDLING",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "OPENSSL_CONF", "OPENSSL_MODULES", "SSLKEYLOGFILE",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
}


def hex_value(value, length=64):
    return isinstance(value, str) and re.fullmatch(rf"[a-f0-9]{{{length}}}", value) is not None


def tree_digest(entries):
    return hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def evidence_digest(value):
    payload = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True).encode()
    return hashlib.sha256(payload).hexdigest()


def validate_revision(revision, approved, require):
    require(hex_value(revision, 40) and revision == approved, "reviewed-sha-mismatch")


def check_environment(env, overrides, require):
    require(not any(name in overrides or name.startswith(("EXPO_PUBLIC_", "DYLD_", "SIMCTL_CHILD_"))
                    for name in env), "environment-overrides")


def check_active_environment(env, require):
    check_environment(env, OVERRIDES, require)


def manifest(root, *, digest, require, excluded):
    require(root.is_dir() and not root.is_symlink(), "invalid-source-tree")
    result = {}
    for directory, dirs, files in os.walk(root):
        for name in dirs + files:
            path = Path(directory) / name
            relative = path.relative_to(root)
            require(not path.is_symlink() and name not in {".git", "node_modules", "__pycache__"}
                    and (not name.startswith(".env") or name == ".env.example")
                    and relative not in excluded, "unexpected-source-entry")
            if name in files:
                require(path.is_file(), "unexpected-source-entry")
                result[relative.as_posix()] = [digest(path), path.stat().st_mode & 0o777]
    return result


def export_source(archive, destination, *, require):
    """Extract only ordinary files and directories from a SHA-addressed tarball."""
    destination.mkdir(mode=0o700)
    with tarfile.open(archive, "r:gz") as source:
        members = source.getmembers()
        require(0 < len(members) <= 50000, "source-archive-invalid")
        root = None
        seen = set()
        total = 0
        for member in members:
            parts = PurePosixPath(member.name).parts
            require(parts and all(part not in (".", "..") for part in parts)
                    and not member.name.startswith("/"), "source-archive-invalid")
            root = root or parts[0]
            require(parts[0] == root and (member.isdir() or member.isfile()), "source-archive-invalid")
            if len(parts) == 1:
                require(member.isdir(), "source-archive-invalid")
                continue
            relative = PurePosixPath(*parts[1:])
            require(relative not in seen, "source-archive-invalid")
            seen.add(relative)
            target = destination.joinpath(*relative.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                total += member.size
                require(member.size <= 100_000_000 and total <= 500_000_000, "source-archive-invalid")
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as stream, target.open("xb") as out:
                    shutil.copyfileobj(stream, out)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)


def checkout_inventory(root, *, digest, require):
    require(root.is_dir() and not root.is_symlink(), "checkout-invalid")
    entries = {}
    for directory, dirs, files in os.walk(root):
        if Path(directory) == root and ".git" in dirs:
            dirs.remove(".git")
        for name in dirs + files:
            path = Path(directory) / name
            require(not path.is_symlink(), "checkout-invalid")
            if name in files:
                require(path.is_file(), "checkout-invalid")
                entries[path.relative_to(root).as_posix()] = [digest(path), path.stat().st_mode & 0o777]
    return entries


class HostedQualification:
    """Shared reviewed-source orchestration for hosted Apple qualifications."""

    def __init__(self, report_path, env, *, runtime, require, manifest_fn, tree_digest_fn,
                 environment_check):
        self.report_path, self.env = report_path, env
        self.runtime_support, self.require = runtime, require
        self.manifest_fn, self.tree_digest_fn = manifest_fn, tree_digest_fn
        self.environment_check = environment_check
        self.process_env = {name: env[name] for name in
                            ("HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL",
                             "DEVELOPER_DIR") if name in env}
        self.scratch = None
        self.work = None
        self.context = None
        self.fixture = None
        self.report = {"schemaVersion": 1, "scope": "ios-hosted-qualification",
                       "revision": None, "run": None, "verdict": "NOT_RUN", "complete": False,
                       "stages": {name: {"verdict": "NOT_RUN"} for name, _ in self.steps()},
                       **{name: "NOT_RUN" for name in
                          ("fullConfinement", "nativeEquivalence", "candidateRuntime", "standardHttpsRuntime")}}

    def steps(self):
        raise NotImplementedError

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
        except self.runtime_support.Interrupted:
            raise
        except self.runtime_support.StageError as error:
            self.report["stages"][name] = error.record
            raise
        except Exception:
            self.report["stages"][name] = {"verdict": "FAIL", "code": name + "-unavailable"}
            raise
        finally:
            self.save()

    def isolated_command(self, args, **kwargs):
        return self.runtime_support.run_command(args, env=self.process_env, **kwargs)

    def command(self, args, timeout=30, output=None, capture=False, *, github=False):
        try:
            env = self.process_env
            if github:
                self.require(bool(self.env.get("GH_TOKEN")), "github-token-unavailable")
                env = {**env, "GH_TOKEN": self.env["GH_TOKEN"]}
            result = self.runtime_support.run_command(args, cwd=self.scratch, timeout=timeout, output=output,
                                                      capture=capture, env=env)
        except subprocess.TimeoutExpired:
            raise self.runtime_support.StageError("command-timeout") from None
        self.require(result.exit_code == 0, "command-failed")
        return result.output

    def revision(self):
        sha = self.env.get("GITHUB_SHA", "")
        validate_revision(sha, self.env.get("REVIEWED_SHA"), self.require)
        self.require(sha == self.env.get("CHECKED_OUT_SHA"), "checkout-sha-mismatch")
        tree = self.env.get("REVIEWED_TREE_SHA256", "")
        self.require(hex_value(tree), "reviewed-tree-invalid")
        self.require(self.env.get("GITHUB_REPOSITORY") == "ntapiaDev/bunny-talks"
                     and self.env.get("RUNNER_ENVIRONMENT") == "github-hosted"
                     and self.env.get("GITHUB_RUN_ATTEMPT") == "1", "runner-not-approved")
        self.environment_check(self.env)
        self.require(not any(name in self.env for name in ("NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV")),
                     "environment-overrides")
        self.report["revision"] = sha
        run = self.env.get("GITHUB_RUN_ID", "")
        self.report["run"] = int(run) if re.fullmatch(r"[0-9]{1,20}", run) else None
        self.scratch = Path(tempfile.mkdtemp(prefix="bunny-ios-hosted-", dir="/tmp")).resolve()
        self.work = self.scratch / "work"
        return {"reviewedTreeSha256": tree}

    def source(self):
        archive = self.scratch / "source.tar.gz"
        self.command(("gh", "api", "repos/ntapiaDev/bunny-talks/tarball/" + self.report["revision"]),
                     timeout=120, output=archive, github=True)
        export_source(archive, self.scratch / "source", require=self.require)
        entries = self.manifest_fn(self.scratch / "source")
        tree = self.tree_digest_fn(entries)
        self.require(tree == self.env["REVIEWED_TREE_SHA256"], "reviewed-tree-mismatch")
        checkout = Path(self.env["GITHUB_WORKSPACE"])
        current = checkout_inventory(checkout, digest=self.runtime_support.digest, require=self.require)
        self.require(current == entries, "checkout-source-mismatch")
        return {"treeSha256": tree, "origin": "github-sha-tarball", "checkoutMatches": True}

    def run(self):
        self.save()
        interrupted = False
        try:
            for name, action in self.steps():
                self.stage(name, action)
        except self.runtime_support.Interrupted:
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
        self.report["verdict"] = ("FAIL" if "FAIL" in states else
                                   "PASS" if all(value == "PASS" for value in states) else "NOT_RUN")
        self.save()
        return 0 if self.report["verdict"] == "PASS" else 1


def inventory_main():
    parser = argparse.ArgumentParser(description="Hash the reviewed HTTPS source inventory.")
    parser.add_argument("source_tree", type=Path, help="Clean SHA tarball export root")
    args = parser.parse_args()

    def require(condition, reason):
        if not condition:
            raise ValueError(reason)

    def digest(path):
        with path.open("rb") as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest()

    exclusions = {Path("apps/mobile/ios"), Path("apps/mobile/modules/application-https/ios/vendor")}
    entries = manifest(args.source_tree.resolve(), digest=digest, require=require, excluded=exclusions)
    print(json.dumps({"treeSha256": tree_digest(entries), "files": len(entries)}, sort_keys=True))


if __name__ == "__main__":
    inventory_main()
