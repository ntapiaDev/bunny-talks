import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

const verifier = resolve('qualification/verify-ios-eas-tree.mjs');
const prepare = resolve('qualification/prepare-ios-eas.sh');
const stagedPaths = [
  'apps/mobile/modules/application-https/ios/CurlHttpsTransport.swift',
  'apps/mobile/modules/application-https/ios/ApplicationHttps.podspec',
  'apps/mobile/modules/application-https/ios/vendor/xcframeworks.zip',
  'apps/mobile/qualification/ios-libcurl-runtime-entry.tsx',
  'apps/mobile/package.json',
  'pnpm-lock.yaml',
];
let reference: string;
let workspace: string;
let inspection: string;
let archive: string;

beforeEach(() => {
  inspection = realpathSync(mkdtempSync(join(tmpdir(), 'bunny-eas-archive-test-')));
  reference = join(inspection, 'reference');
  workspace = join(inspection, 'workspace');
  archive = join(inspection, 'archive');
  for (const path of [...stagedPaths, 'apps/mobile/eas.json']) {
    const file = join(reference, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'fixture-only');
  }
  const config = { expo: { slug: 'bunny-talks-https' } };
  writeFileSync(join(reference, 'apps/mobile/app.json'), JSON.stringify(config));
  cpSync(reference, workspace, { recursive: true });
  const app = join(workspace, 'apps/mobile/app.json');
  writeFileSync(
    app,
    JSON.stringify({ expo: { ...config.expo, extra: { eas: { projectId: 'fixture' } } } }),
  );
  cpSync(workspace, archive, { recursive: true });
});

afterEach(() => {
  if (inspection) rmSync(inspection, { force: true, recursive: true });
});

function check(inspected = archive) {
  return spawnSync(process.execPath, [verifier, reference, workspace, inspected], {
    encoding: 'utf8',
  });
}

it('accepts a freshly inspected copy', () => expect(check().status).toBe(0));

it('omits only local dependency directories', () => {
  mkdirSync(join(workspace, 'apps/mobile/node_modules/pkg'), { recursive: true });
  writeFileSync(join(workspace, 'apps/mobile/node_modules/pkg/local.txt'), 'local');
  expect(check().status).toBe(0);
});

it('refuses injected archive dependencies', () => {
  mkdirSync(join(archive, 'apps/mobile/node_modules'));
  expect(check().status).toBe(1);
});

it.each(stagedPaths)('refuses a changed %s in the archive', (path) => {
  const file = join(archive, path);
  const bytes = readFileSync(file);
  bytes.writeUInt8(bytes.readUInt8(0) ^ 1);
  writeFileSync(file, bytes);
  expect(check().status).toBe(1);
});

it('refuses a file missing from both copy and archive', () => {
  for (const root of [workspace, archive]) rmSync(join(root, 'apps/mobile/eas.json'));
  expect(check().status).toBe(1);
});

it.each(['unexpected.txt', '.env', 'credentials.json'])(
  'refuses the unexpected path %s even if present in both trees',
  (path) => {
    for (const root of [workspace, archive]) writeFileSync(join(root, path), 'fixture-only');
    expect(check().status).toBe(1);
  },
);

it('refuses an unexpected file added only to the archive', () => {
  writeFileSync(join(archive, 'unexpected.txt'), 'fixture-only');
  expect(check().status).toBe(1);
});

it('refuses symbolic links and special paths before reading them', () => {
  symlinkSync(join(workspace, 'package.json'), join(archive, 'link.json'));
  expect(check().status).toBe(1);
  rmSync(join(archive, 'link.json'));
  execFileSync('mkfifo', [join(archive, 'pipe')]);
  expect(check().status).toBe(1);
});

it('refuses the workspace itself as the inspected archive', () => {
  expect(check(workspace).status).toBe(1);
});

it('refuses a linked app configuration changed beyond the EAS project link', () => {
  for (const root of [workspace, archive]) {
    writeFileSync(
      join(root, 'apps/mobile/app.json'),
      JSON.stringify({ expo: { slug: 'changed' } }),
    );
  }
  expect(check().status).toBe(1);
});

for (const mode of ['build', 'runtime']) {
  it.runIf(Boolean(process.env.BUNNY_IOS_XCFRAMEWORK_ZIP))(
    `checks the linked ${mode} stage with the approved ZIP`,
    () => {
      const flags = mode === 'runtime' ? ['--runtime'] : [];
      const env = { ...process.env, BUNNY_IOS_RUNTIME_REVISION: 'a'.repeat(40) };
      const stage = execFileSync('bash', [prepare, ...flags], { env, encoding: 'utf8' }).trim();
      try {
        const projectId = randomUUID();
        const app = join(stage, 'apps/mobile/app.json');
        const config = JSON.parse(readFileSync(app, 'utf8'));
        config.expo.extra = { eas: { projectId } };
        writeFileSync(app, JSON.stringify(config));
        const inspected = join(inspection, 'libcurl-archive');
        cpSync(stage, inspected, { recursive: true });
        const checkStage = (root: string, id: string) =>
          spawnSync('bash', [prepare, ...flags, '--check', stage, id, inspected], {
            cwd: join(stage, 'apps/mobile'),
            env: { ...env, EAS_NO_VCS: '1', EAS_PROJECT_ROOT: root },
            encoding: 'utf8',
          });
        expect(checkStage(stage, projectId).status).toBe(0);
        const wrongProject = checkStage(stage, randomUUID());
        expect(wrongProject.status).toBe(1);
        expect(wrongProject.stderr).toContain('approved Expo project ID');
        const staleRoot = checkStage(inspected, projectId);
        expect(staleRoot.status).toBe(1);
        expect(staleRoot.stderr).toContain('EAS_PROJECT_ROOT set');
      } finally {
        rmSync(stage, { force: true, recursive: true });
      }
    },
  );
}
