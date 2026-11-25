"""Local failure and cleanup checks for the hosted feasibility driver."""

import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import tarfile
import tempfile
import unittest
from unittest.mock import patch


script = Path(__file__).resolve().parents[1] / 'scripts/run-ios-hosted-feasibility.py'
spec = importlib.util.spec_from_file_location('feasibility', script)
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)
SHA = 'a' * 40
TREE = 'b' * 64


class FeasibilityTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.env = {name: os.environ[name] for name in ('HOME', 'PATH', 'TMPDIR', 'USER') if name in os.environ}
        self.env.update({'GITHUB_SHA': SHA, 'REVIEWED_SHA': SHA, 'CHECKED_OUT_SHA': SHA,
                    'REVIEWED_TREE_SHA256': TREE, 'GITHUB_REPOSITORY': 'ntapiaDev/bunny-talks',
                    'RUNNER_ENVIRONMENT': 'github-hosted', 'GITHUB_RUN_ATTEMPT': '1'})
        self.run = f.Feasibility(self.root / 'report.json', self.env)

    def archive(self, name, entries):
        path = self.root / name
        with tarfile.open(path, 'w:gz') as out:
            for filename, data, kind in entries:
                info = tarfile.TarInfo(filename)
                info.mode = 0o755 if filename.endswith('.sh') else 0o644
                info.type = kind
                info.size = len(data) if kind == tarfile.REGTYPE else 0
                out.addfile(info, io.BytesIO(data) if info.size else None)
        return path

    def test_export_inventory_and_unsafe_entries(self):
        archive = self.archive('source.tar.gz', [('source/a.sh', b'hello', tarfile.REGTYPE)])
        f.export_source(archive, self.root / 'export')
        entries = f.c2.manifest(self.root / 'export')
        self.assertEqual(entries['a.sh'][1], 0o755)
        self.assertEqual(len(f.c2.tree_digest(entries)), 64)
        for index, filename, kind in [(0, 'source/../escape', tarfile.REGTYPE),
                                      (1, 'source/link', tarfile.SYMTYPE),
                                      (2, '/absolute', tarfile.REGTYPE)]:
            archive = self.archive(f'bad{index}.tar.gz', [(filename, b'x', kind)])
            with self.assertRaises(f.c2.StageError):
                f.export_source(archive, self.root / f'bad{index}')

    def test_bad_sha_and_archive_refused(self):
        for key, value in [('REVIEWED_SHA', 'c' * 40), ('CHECKED_OUT_SHA', 'd' * 40),
                           ('REVIEWED_TREE_SHA256', 'bad'), ('NODE_OPTIONS', '--inspect')]:
            with self.subTest(key=key), patch.dict(self.env, {key: value}), self.assertRaises(f.c2.StageError):
                self.run.revision()
        archive = self.root / 'bad.zip'
        archive.write_bytes(b'not an approved archive')
        with self.assertRaises(f.c2.StageError):
            f.c2.verify_archive(archive)

    def test_checkout_inventory_detects_extra_or_changed_sources(self):
        checkout = self.root / 'checkout'
        checkout.mkdir()
        (checkout / '.git').mkdir()
        source = checkout / 'source'
        source.write_text('reviewed')
        before = f.checkout_inventory(checkout)
        self.assertEqual(list(before), ['source'])
        source.write_text('changed')
        self.assertNotEqual(before, f.checkout_inventory(checkout))
        (checkout / 'link').symlink_to(source)
        with self.assertRaises(f.c2.StageError):
            f.checkout_inventory(checkout)

    def test_fixture_exit_before_readiness_is_failure(self):
        self.run.scratch = self.root
        self.run.work = self.root / 'work'
        self.run.work.mkdir()

        class DeadFixture:
            def poll(self):
                return 2

        with patch.object(self.run, 'command', side_effect=['OpenSSL 3.5.0', '']), \
             patch.object(f.subprocess, 'Popen', return_value=DeadFixture()):
            with self.assertRaises(f.c2.StageError) as error:
                self.run.start_fixture()
        self.assertEqual(error.exception.record['code'], 'fixture-start-failed')

    def test_openssl_four_falls_back_to_homebrew_three(self):
        self.run.scratch = self.root
        self.run.work = self.root / 'work'
        binary = self.root / 'openssl@3/bin/openssl'
        binary.parent.mkdir(parents=True)
        binary.touch()
        with patch.object(self.run, 'command',
                          side_effect=['OpenSSL 4.0.0', str(binary.parent.parent), 'OpenSSL 3.5.0', '']) as command, \
             patch.object(f.subprocess, 'Popen', side_effect=OSError):
            with self.assertRaises(OSError):
                self.run.start_fixture()
        self.assertEqual(command.call_args_list[1].args[0], ('brew', '--prefix', 'openssl@3'))
        self.assertEqual(command.call_args_list[2].args[0], ('openssl', 'version'))
        self.assertEqual(command.call_args_list[3].args[0][0], 'bash')
        self.assertEqual(self.run.process_env['PATH'].split(os.pathsep)[0], str(binary.parent))

    @unittest.skipUnless(shutil.which('node') and shutil.which('lsof') and shutil.which('openssl'),
                         'local fixture prerequisites unavailable')
    def test_real_loopback_fixture_and_control_with_simulated_platform(self):
        try:
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
        except PermissionError:
            self.skipTest('local sandbox disallows loopback listeners')
        preload = self.root / 'platform.cjs'
        preload.write_text("Object.defineProperty(process, 'platform', {value: 'darwin'});\n")
        self.run.scratch = self.root / 'scratch'
        self.run.work = self.run.scratch / 'work'
        self.run.work.mkdir(parents=True)
        self.run.context = {'runId': 'f' * 32, 'revision': SHA, 'treeSha256': TREE,
                            'zipSha256': f.c2.vendor.ZIP_SHA256}
        (self.run.work / '.c2-owner.json').write_text(json.dumps(self.run.context))
        f.c2.save_receipt(self.run.work, 'environment', self.run.context,
                          device='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', target='hosted-observed')
        with patch.dict(self.run.process_env, {'NODE_OPTIONS': '--require=' + str(preload)}), \
             patch.object(f.c2, 'cleanup_simulator'):
            try:
                result = self.run.start_fixture()
                self.assertEqual(result, {'loopbackListeners': 7, 'controlResponse': 'PASS'})
            finally:
                self.run.cleanup()

    def test_github_credential_is_only_passed_to_provisioning(self):
        self.env.update({'GH_TOKEN': 'dummy-provisioning-token', 'GITHUB_TOKEN': 'dummy-other-token',
                         'ACTIONS_RUNTIME_TOKEN': 'dummy-runtime-token', 'OTHER_SECRET': 'dummy-secret'})
        self.run = f.Feasibility(self.root / 'report.json', self.env)
        self.run.scratch = self.root
        self.run.work = self.root / 'work'
        self.run.work.mkdir()
        commands = []

        def command(args, **kwargs):
            commands.append((args, dict(kwargs['env'])))
            return f.c1.CommandResult(0, 'OpenSSL 3.5.0' if args == ('openssl', 'version') else '')

        class DeadFixture:
            def poll(self):
                return 2

        with patch.object(f.c1, 'run_command', side_effect=command), \
             patch.object(f.subprocess, 'Popen', return_value=DeadFixture()) as fixture:
            self.run.command(('gh', 'api', 'fixture'), github=True)
            self.run.isolated_command(('xcrun', 'simctl'), cwd=self.root, timeout=1)
            with self.assertRaises(f.c2.StageError):
                self.run.start_fixture()
        self.assertEqual(commands[0][1].get('GH_TOKEN'), 'dummy-provisioning-token')
        for env in [entry[1] for entry in commands[1:]] + [fixture.call_args.kwargs['env']]:
            self.assertFalse({'GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'OTHER_SECRET'} & env.keys())
        self.assertTrue({'PATH', 'HOME'} <= fixture.call_args.kwargs['env'].keys())

    def test_failure_and_interruption_always_cleanup_and_never_claim_runtime(self):
        for stage in ('simulator', 'start_fixture'):
            for exception in (f.c2.StageError('injected-failure'), f.c1.Interrupted()):
                with self.subTest(stage=stage, exception=type(exception).__name__):
                    worker = f.Feasibility(self.root / 'report.json', self.env)
                    patches = [patch.object(worker, name, return_value={}) for name in
                               ('revision', 'source', 'archive', 'toolchain', 'simulator', 'start_fixture', 'network', 'cleanup')]
                    for p in patches:
                        p.start()
                        self.addCleanup(p.stop)
                    with patch.object(worker, stage, side_effect=exception), patch.object(worker, 'cleanup', return_value={}) as cleanup:
                        self.assertEqual(worker.run(), 1)
                        cleanup.assert_called_once()
                    report = json.loads(worker.report_path.read_text())
                    self.assertNotEqual(report['verdict'], 'PASS')
                    self.assertTrue(all(report[name] == 'NOT_RUN' for name in f.OUT_OF_SCOPE))
                    self.assertNotIn(str(self.root), json.dumps(report))
                    for p in reversed(patches):
                        p.stop()

    def test_success_report_keeps_out_of_scope_results_not_run(self):
        worker = f.Feasibility(self.root / 'report.json', self.env)
        patches = [patch.object(worker, name, return_value={}) for name in
                   ('revision', 'source', 'archive', 'toolchain', 'simulator', 'start_fixture', 'network', 'cleanup')]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.assertEqual(worker.run(), 0)
        report = json.loads(worker.report_path.read_text())
        self.assertEqual(report['verdict'], 'PASS')
        self.assertTrue(all(report[name] == 'NOT_RUN' for name in f.OUT_OF_SCOPE))

    def test_simulator_cleanup_and_workspace_removed_even_if_cleanup_fails(self):
        self.run.scratch = self.root / 'scratch'
        self.run.scratch.mkdir()
        self.run.work = self.run.scratch / 'work'
        self.run.context = {'runId': 'f' * 32}
        with patch.object(f.c2, 'cleanup_simulator', side_effect=f.c2.StageError('failure')) as cleanup:
            with self.assertRaises(f.c2.StageError):
                self.run.cleanup()
            cleanup.assert_called_once()
        self.assertFalse(self.run.scratch.exists())

    def test_fixture_failure_is_reaped(self):
        class DeadFixture:
            pid = 123
            returncode = 2
            def poll(self):
                return self.returncode
            def wait(self, timeout):
                return self.returncode
        self.run.scratch = self.root / 'scratch'
        self.run.scratch.mkdir()
        self.run.work = self.run.scratch / 'work'
        self.run.work.mkdir()
        self.run.fixture = DeadFixture()
        with self.assertRaises(f.c2.StageError):
            self.run.cleanup()
        self.assertFalse(self.run.scratch.exists())

    def test_live_fixture_is_stopped_before_simulator_and_workspace(self):
        events = []

        class LiveFixture:
            pid = 123
            returncode = 0
            def poll(self):
                return None
            def wait(self, timeout):
                events.append('wait')
                return 0

        self.run.scratch = self.root / 'scratch'
        self.run.work = self.run.scratch / 'work'
        (self.run.work / 'simulators').mkdir(parents=True)
        (self.run.work / 'fixture-start.json').write_text('{}')
        self.run.context = {'runId': 'f' * 32}
        self.run.fixture = LiveFixture()
        with patch.object(f.os, 'killpg', side_effect=lambda *args: events.append('signal')), \
             patch.object(f.c2, 'load_receipt', return_value={'closed': True, 'fixtureId': 'a' * 32}), \
             patch.object(f.c2, 'cleanup_simulator', side_effect=lambda *args, **kwargs: events.append('simulator')):
            result = self.run.cleanup()
        self.assertEqual(events, ['signal', 'wait', 'simulator'])
        self.assertEqual(result['workspaceRemoved'], 'PASS')
        self.assertFalse(self.run.scratch.exists())


if __name__ == '__main__':
    unittest.main()
