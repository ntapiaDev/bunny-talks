import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  buildXCFrameworks,
  packageFiles,
  profile,
  selectSDKs,
  verifyArchives,
  verifyXCFrameworks,
} from './build.mjs';

const toolEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', COPYFILE_DISABLE: '1' };

function download(url, path) {
  execFileSync(
    '/usr/bin/curl',
    [
      '-q',
      '--fail',
      '--location',
      '--proto',
      '=https',
      '--proto-redir',
      '=https',
      '--silent',
      '--show-error',
      '--connect-timeout',
      '15',
      '--max-time',
      '100',
      '--retry',
      '2',
      '--retry-max-time',
      '120',
      '--output',
      path,
      url,
    ],
    { env: toolEnv, stdio: 'pipe', timeout: 130_000 },
  );
}

function pack(directory, path) {
  execFileSync('/usr/bin/tar', ['--format=ustar', '-cf', path, '-C', directory, ...packageFiles], {
    env: toolEnv,
    stdio: 'pipe',
    timeout: 60_000,
  });
}

const operations = {
  download,
  pack,
  selectSDKs,
  verifyArchives,
  buildXCFrameworks,
  verifyXCFrameworks,
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function packageDigests(hashes) {
  const paths = Object.keys(hashes).sort();
  const staticArchives = Object.fromEntries(
    paths.filter((path) => path.endsWith('.a')).map((path) => [path, hashes[path]]),
  );
  const xcframeworks = Object.fromEntries(
    packageFiles
      .filter((name) => name.endsWith('.xcframework'))
      .map((name) => {
        const entries = paths.filter((path) => path.startsWith(name + '/'));
        const inventory = entries.map((path) => `${hashes[path]}  ${path}\n`).join('');
        return [name, sha256(inventory)];
      }),
  );
  return { staticArchives, xcframeworks };
}

export function runQualification(root, dispatchRevision, checkedOutRevision, overrides = {}) {
  const ops = { ...operations, ...overrides };
  const proof = join(root, 'proof');
  const workRoot = join(root, 'scratch');
  const reportPath = join(proof, 'report.json');
  const report = {
    scope: 'xcframework-build-inspection-link',
    revision: null,
    verdict: 'NOT_RUN',
    reason: 'control-incomplete',
  };
  const save = () => {
    const pending = reportPath + '.pending';
    writeFileSync(pending, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    renameSync(pending, reportPath);
  };
  let operation = 'preparation';
  const check = (stage, control, detail = {}) => {
    report.check = { operation, stage, control, ...detail };
    save();
  };

  try {
    check('preparation', 'checked-out-revision');
    assert.match(dispatchRevision, /^[a-f0-9]{40}$/);
    assert.equal(checkedOutRevision, dispatchRevision);
    report.revision = checkedOutRevision;

    check('toolchain', 'node-version');
    assert.match(process.versions.node, /^24\.\d+\.\d+$/);
    const sdks = ops.selectSDKs(check);
    report.toolchain = {
      node: process.versions.node,
      architecture: profile.architecture,
      xcode: profile.xcode,
      sdks: sdks.map(({ sdk, sdkBuild }) => ({
        sdk,
        build: sdkBuild,
        version: profile.sdkVersion,
      })),
    };
    const paths = profile.upstream.map(({ archive, url }) => {
      check('archives', 'download', { archive });
      const path = join(workRoot, archive);
      ops.download(url, path);
      return path;
    });
    ops.verifyArchives(paths, check);
    report.sourceArchives = Object.fromEntries(
      profile.upstream.map(({ archive, sha256 }) => [archive, sha256]),
    );

    operation = 'build';
    check('workspace', 'start-build');
    const directory = ops.buildXCFrameworks(paths, { workRoot, check });
    operation = 'verify';
    check('manifest', 'preserve-build-manifest');
    const manifest = join(directory, 'manifest.json');
    copyFileSync(manifest, join(proof, 'manifest.json'));
    report.manifestSha256 = sha256(readFileSync(manifest));
    const verified = ops.verifyXCFrameworks(directory, { workRoot, check });
    check('manifest', 'match-preserved-manifest');
    assert.equal(verified.sha256, report.manifestSha256);
    report.packageVerified = true;

    operation = 'delivery';
    check('packaging', 'archive-verified-package');
    const pending = join(workRoot, 'xcframeworks.tar');
    ops.pack(directory, pending);
    check('packaging', 'artifact-fingerprints');
    report.artifacts = {
      tarSha256: sha256(readFileSync(pending)),
      ...packageDigests(verified.manifest.sha256),
    };
    check('packaging', 'stage-archive');
    renameSync(pending, join(root, 'delivery', 'xcframeworks.tar'));
    report.verdict = 'PASS';
    report.reason = 'build-inspection-and-link-verified';
    delete report.check;
    save();
    return true;
  } catch {
    const { stage, control } = report.check ?? { stage: 'packaging', control: 'write-report' };
    report.verdict = operation === 'preparation' || stage === 'toolchain' ? 'NOT_RUN' : 'FAIL';
    report.reason = `${stage}/${control}`;
    save();
    return false;
  }
}

if (import.meta.main) {
  try {
    const ok = runQualification(
      process.argv[2],
      process.env.GITHUB_SHA,
      process.env.CHECKED_OUT_SHA,
    );
    if (!ok) process.exitCode = 1;
  } catch {
    process.stderr.write('XCFramework qualification could not write its report.\n');
    process.exitCode = 1;
  }
}
