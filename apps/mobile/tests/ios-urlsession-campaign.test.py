"""Local orchestration regression checks, without Apple commands."""

import importlib.util
from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

path = Path(__file__).resolve().parents[1] / 'scripts/run-ios-urlsession-campaign.py'
spec = importlib.util.spec_from_file_location('urlsession_campaign', path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class CampaignTests(unittest.TestCase):
    def test_inventory_cli_matches_the_hosted_manifest_hash(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as temporary:
            root = Path(temporary)
            mobile = root / 'apps/mobile'
            mobile.mkdir(parents=True)
            (root / 'package.json').write_text('{}\n')
            (mobile / 'index.ts').write_text('export {};\n')
            expected = worker.tree_digest(worker.manifest(root))
            output = StringIO()
            with patch.object(sys, 'argv', ['ios-https-provenance.py', str(root)]), redirect_stdout(output):
                worker.provenance.inventory_main()
            self.assertEqual(json.loads(output.getvalue()), {'treeSha256': expected, 'files': 2})

    def test_fixture_requires_the_exact_loopback_listener_set(self):
        campaign = worker.Campaign(Path('/tmp/unused-report.json'), {})
        campaign.fixture = Mock(pid=42, poll=Mock(return_value=None))
        listeners = '\n'.join(f'n127.0.0.1:{port}' for port in range(29443, 29449))
        campaign.command = Mock(return_value=listeners)
        snapshot = '{"events":[],"connections":[],"overflow":false}'
        with patch.object(worker.urllib.request, 'urlopen', return_value=StringIO(snapshot)):
            self.assertEqual(campaign.wait_for_fixture(require_empty_connections=True), {'loopbackListeners': 6})
        campaign.command.return_value = listeners + '\nn*:29449'
        with patch.object(worker.urllib.request, 'urlopen', return_value=StringIO(snapshot)):
            with self.assertRaises(worker.StageError) as refusal:
                campaign.wait_for_fixture()
        self.assertEqual(refusal.exception.record['code'], 'fixture-listeners-unconfirmed')

    def test_build_selects_project_pnpm_and_shares_corepack_environment(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as temporary:
            scratch = Path(temporary)
            root = scratch / 'staged'
            mobile = root / 'apps/mobile'
            ios = mobile / 'ios'
            (ios / 'Candidate.xcworkspace').mkdir(parents=True)
            (root / 'package.json').write_text('{"packageManager":"pnpm@10.34.9"}')
            campaign = worker.Campaign(scratch / 'report.json', {})
            campaign.scratch = scratch
            campaign.staged = root
            campaign.runner = worker.c1.RuntimeRun(
                scratch, campaign.report_path, {}, command=campaign.isolated_command,
            )
            calls = []

            def command(args, *, cwd, env, **kwargs):
                calls.append((args, cwd, env['COREPACK_HOME']))
                if args == ('pnpm', '--version'):
                    manifest = json.loads((cwd / 'package.json').read_text())
                    return worker.c1.CommandResult(0, manifest['packageManager'].removeprefix('pnpm@'))
                return worker.c1.CommandResult(0)

            with patch.object(worker.c1, 'run_command', side_effect=command), \
                    patch.object(worker.c1, 'EXECUTABLE'):
                campaign.build()
            self.assertEqual(
                [(args[:2], cwd) for args, cwd, _ in calls],
                [(('corepack', 'enable'), root), (('pnpm', '--version'), root),
                 (('pnpm', 'install'), root), (('pnpm', '--filter'), root),
                 (('pnpm', 'exec'), mobile), (('pod', 'install'), ios),
                 (('xcodebuild', 'build'), ios)],
            )
            self.assertIn('--frozen-lockfile', calls[2][0])
            self.assertEqual({home for _, _, home in calls}, {str(scratch / 'corepack')})

    def test_build_reports_version_mismatch_without_exposing_arbitrary_output(self):
        campaign = worker.Campaign(Path('/tmp/unused-report.json'), {})
        campaign.scratch = Path('/tmp/scratch')
        campaign.staged = Path('/tmp/staged')
        for output, observed in [('10.35.0', '10.35.0'), ('unexpected multiline\noutput', None)]:
            with self.subTest(observed=observed):
                campaign.runner = Mock()
                campaign.runner.call.return_value.output = output
                with self.assertRaises(worker.StageError) as caught:
                    campaign.build()
                self.assertEqual(caught.exception.record, {
                    'verdict': 'FAIL', 'code': 'pnpm-version-mismatch',
                    'expectedPnpmVersion': '10.34.9', 'observedPnpmVersion': observed,
                })
                self.assertEqual(campaign.runner.call.call_count, 2)

    def test_plan_does_not_fetch_vendor_archive(self):
        campaign = worker.Campaign(Path('/tmp/unused-report.json'), {})
        stages = [name for name, _ in campaign.steps()]
        self.assertNotIn('archive', stages)
        self.assertIn('staging', stages)
        self.assertIn('provenance', stages)
        self.assertEqual(campaign.report['standardHttpsRuntime'], 'NOT_RUN')

    def test_staging_uses_foundation_only(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as temporary:
            root = Path(temporary)
            native = root / 'apps/mobile/modules/application-https/ios'
            native.mkdir(parents=True)
            for name in ('ApplicationHttpsModule.swift', 'ApplicationHttps.podspec', 'UrlSessionHttpsTransport.swift'):
                (native / name).write_text('fixture')
            campaign = worker.Campaign(root / 'report.json', {})
            campaign.scratch = root
            campaign.command = Mock(return_value=str(root))
            result = campaign.staging()
            self.assertEqual(len(result['nativeSources']), 3)
            self.assertEqual(Path(campaign.command.call_args.args[0][-1]).name, 'stage-ios-urlsession-campaign.sh')
            (native / 'vendor').mkdir()
            with self.assertRaises(worker.StageError):
                campaign.staging()

    def test_cleanup_continues_after_stop_failure(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as temporary:
            campaign = worker.Campaign(Path(temporary) / 'report.json', {})
            campaign.runner = Mock(pid=42)
            campaign.runner.stop.side_effect = worker.StageError('stop-failed')
            campaign.runner.cleanup_device.side_effect = worker.StageError('cleanup-failed')
            campaign.scratch = Path(temporary)
            with self.assertRaises(worker.StageError) as caught:
                campaign.cleanup()
            campaign.runner.cleanup_device.assert_called_once()
            self.assertEqual(caught.exception.record['simulatorRemoved'], 'FAIL')
            self.assertTrue(Path(temporary).exists())

    def test_runtime_preserves_filtered_partial_report_after_collection_timeout(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as temporary:
            scratch = Path(temporary)
            campaign = worker.Campaign(scratch / 'report.json', {})
            campaign.scratch = campaign.staged = scratch
            campaign.app = scratch / 'Candidate.app'
            campaign.hashes = {'executableSha256': 'fixture'}
            runner = campaign.runner = Mock(device_set=scratch, device='simulator')
            runner.sim.return_value.output = str(scratch / 'simulator' / 'Candidate.app')
            runner.app_hashes.return_value = campaign.hashes
            runner.launch_pid.return_value = 42
            markers = [
                f'Candidate[42:0] {worker.MARKER}PASS length-and-transfer response',
                f'Other[43:0] {worker.MARKER}PASS timeout timeout',
            ]
            qualification = {
                'verdict': 'NOT_RUN',
                'scenarios': [{'id': 'length-and-transfer', 'observed': 'response',
                               'verdict': 'NOT_RUN'}] * 31,
            }

            def collect(*args, stdout, **kwargs):
                stdout.write('\n'.join(markers).encode())
                stdout.flush()
                return Mock(poll=Mock(return_value=None))

            def verify(*args, **kwargs):
                self.assertEqual(Path(args[-2]).read_text(), markers[0])
                return worker.c1.CommandResult(1, json.dumps(qualification))

            runner.call.side_effect = verify
            with patch.object(worker.subprocess, 'Popen', side_effect=collect), \
                    patch.object(worker.time, 'monotonic', side_effect=[0, 181]), \
                    patch.object(worker.time, 'sleep'), \
                    patch.object(worker.urllib.request, 'urlopen'), \
                    patch.object(worker.json, 'load', return_value={'events': []}):
                with self.assertRaises(worker.StageError) as caught:
                    campaign.runtime()
            self.assertEqual(caught.exception.record, {'verdict': 'NOT_RUN', 'code': 'qualification-timeout'})
            self.assertEqual(campaign.report['qualification'], qualification)
            runner.launch_pid.assert_called_once()
            runner.call.assert_called_once()


if __name__ == '__main__':
    unittest.main()
