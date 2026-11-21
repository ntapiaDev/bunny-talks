import { deepEqual, doesNotMatch, equal } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { packageFiles, profile } from './build.mjs';
import { runQualification } from './run-github-actions.mjs';

const revision = 'a'.repeat(40);
const privateDetail = '/private/path/secret-in-compiler-output';
const digest = (input) => createHash('sha256').update(input).digest('hex');

function testWorkspace(context) {
  const root = mkdtempSync(join(tmpdir(), 'test-xcframework-ci.'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['scratch', 'proof', 'delivery']) mkdirSync(join(root, name));
  const report = () => readFileSync(join(root, 'proof', 'report.json'), 'utf8');
  return {
    root,
    report,
    tar: join(root, 'delivery', 'xcframeworks.tar'),
    preservedManifest: join(root, 'proof', 'manifest.json'),
  };
}

// Synthetic build inputs exercise the orchestration, never Apple tools.
function fakeBuild(root) {
  const directory = join(root, 'scratch', 'test-package');
  const sha256 = {};
  const manifest = { sha256 };
  const serialized = () => JSON.stringify(manifest);
  return {
    selectSDKs: () => profile.variants.map(({ sdk }) => ({ sdk, sdkBuild: '23F81a' })),
    download: (_url, destination) => writeFileSync(destination, 'synthetic download'),
    verifyArchives: () => {},
    buildXCFrameworks: () => {
      mkdirSync(directory);
      for (const name of packageFiles) {
        if (!name.endsWith('.xcframework')) {
          writeFileSync(join(directory, name), 'synthetic package file');
          continue;
        }
        for (const { id } of profile.variants) {
          const path = `${name}/${id}/${name.replace('.xcframework', '.a')}`;
          mkdirSync(join(directory, name, id), { recursive: true });
          writeFileSync(join(directory, path), path);
          sha256[path] = digest(path);
        }
      }
      writeFileSync(join(directory, 'manifest.json'), serialized());
      writeFileSync(join(root, 'scratch', 'raw.log'), privateDetail);
      return directory;
    },
    verifyXCFrameworks: () => ({ manifest, sha256: digest(serialized()) }),
  };
}

test('requires matching reviewed checkout before calling Apple tools', (context) => {
  const { root, report, tar } = testWorkspace(context);
  let calls = 0;
  const result = runQualification(root, revision, 'b'.repeat(40), {
    selectSDKs: () => calls++,
  });
  equal(result, false);
  equal(calls, 0);
  equal(existsSync(tar), false);
  deepEqual(JSON.parse(report()), {
    scope: 'xcframework-build-inspection-link',
    revision: null,
    verdict: 'NOT_RUN',
    reason: 'preparation/checked-out-revision',
    check: { operation: 'preparation', stage: 'preparation', control: 'checked-out-revision' },
  });
});

test('keeps the failed SDK check without tool output or any download', (context) => {
  const { root, report } = testWorkspace(context);
  let downloads = 0;
  equal(
    runQualification(root, revision, revision, {
      selectSDKs: (check) => {
        check('toolchain', 'sdk-version', { sdk: 'iphonesimulator' });
        throw new Error(privateDetail);
      },
      download: () => downloads++,
    }),
    false,
  );
  equal(downloads, 0);
  const result = JSON.parse(report());
  equal(result.verdict, 'NOT_RUN');
  equal(result.reason, 'toolchain/sdk-version');
  equal(result.revision, revision);
  equal(result.check.sdk, 'iphonesimulator');
  doesNotMatch(report(), /private|secret/);
});

test('a download or SHA-256 failure stops before compilation', (context) => {
  for (const control of ['download', 'sha256']) {
    const { root, report, tar } = testWorkspace(context);
    const { selectSDKs, download } = fakeBuild(root);
    let builds = 0;
    equal(
      runQualification(root, revision, revision, {
        selectSDKs,
        download:
          control === 'download'
            ? () => {
                throw new Error(privateDetail);
              }
            : download,
        buildXCFrameworks: () => builds++,
      }),
      false,
    );
    const result = JSON.parse(report());
    equal(result.verdict, 'NOT_RUN');
    equal(result.reason, `archives/${control}`);
    equal(result.check.archive, profile.upstream[0].archive);
    equal(builds, 0);
    equal(existsSync(tar), false);
    doesNotMatch(report(), /private|secret/);
  }
});

test('build failure records the precise phase and SDK and stages no binaries', (context) => {
  const { root, report, tar, preservedManifest } = testWorkspace(context);
  equal(
    runQualification(root, revision, revision, {
      ...fakeBuild(root),
      buildXCFrameworks: (_archives, { check }) => {
        check('openssl-compile', 'make', { sdk: 'iphoneos' });
        throw new Error(privateDetail);
      },
    }),
    false,
  );
  equal(JSON.parse(report()).verdict, 'FAIL');
  deepEqual(JSON.parse(report()).check, {
    operation: 'build',
    stage: 'openssl-compile',
    control: 'make',
    sdk: 'iphoneos',
  });
  equal(existsSync(preservedManifest), false);
  equal(existsSync(tar), false);
  doesNotMatch(report(), /private|secret/);
});

test('manifest mismatch keeps the generated manifest with the FAIL report only', (context) => {
  const { root, report, tar, preservedManifest } = testWorkspace(context);
  equal(
    runQualification(root, revision, revision, {
      ...fakeBuild(root),
      verifyXCFrameworks: () => ({ sha256: 'f'.repeat(64) }),
    }),
    false,
  );
  const result = JSON.parse(report());
  equal(result.verdict, 'FAIL');
  equal(result.reason, 'manifest/match-preserved-manifest');
  equal(result.manifestSha256, digest(readFileSync(preservedManifest)));
  equal(existsSync(tar), false);
});

test('a failed archive write cannot stage a partial package', (context) => {
  const { root, report, tar } = testWorkspace(context);
  equal(
    runQualification(root, revision, revision, {
      ...fakeBuild(root),
      pack: (_directory, path) => {
        writeFileSync(path, 'partial output');
        throw new Error(privateDetail);
      },
    }),
    false,
  );
  equal(JSON.parse(report()).verdict, 'FAIL');
  equal(JSON.parse(report()).reason, 'packaging/archive-verified-package');
  equal(existsSync(tar), false);
  doesNotMatch(report(), /private|secret/);
});

test('success stages the verified package and emits per-file and per-framework fingerprints', (context) => {
  const { root, report, tar } = testWorkspace(context);
  equal(
    runQualification(root, revision, revision, {
      ...fakeBuild(root),
      pack: (directory, path) => {
        equal(JSON.parse(report()).packageVerified, true);
        equal(existsSync(tar), false);
        writeFileSync(path, readFileSync(join(directory, 'manifest.json')));
      },
    }),
    true,
  );
  const result = JSON.parse(report());
  equal(result.verdict, 'PASS');
  equal(result.scope, 'xcframework-build-inspection-link');
  equal(result.artifacts.tarSha256, digest(readFileSync(tar)));
  const hashes = result.artifacts.staticArchives;
  equal(Object.keys(hashes).length, 4);
  for (const [path, sha256] of Object.entries(hashes)) equal(sha256, digest(path));
  for (const [name, sha256] of Object.entries(result.artifacts.xcframeworks)) {
    const lines = Object.keys(hashes)
      .sort()
      .filter((path) => path.startsWith(name + '/'));
    equal(sha256, digest(lines.map((path) => `${hashes[path]}  ${path}\n`).join('')));
  }
  equal(Object.keys(result.artifacts.xcframeworks).length, 2);
  doesNotMatch(readFileSync(tar, 'utf8'), /raw\.log|scratch|proof/);
});
