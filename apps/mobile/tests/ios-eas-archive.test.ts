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
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

const prepare = resolve('qualification/prepare-ios-eas.sh');
let workspace: string;
let inspection: string;
let archive: string;
let projectId: string;

beforeEach(() => {
  workspace = execFileSync('bash', [prepare], { encoding: 'utf8' }).trim();
  inspection = realpathSync(mkdtempSync(join(tmpdir(), 'bunny-eas-archive-test-')));
  archive = join(inspection, 'archive');
  projectId = randomUUID();
  const app = join(workspace, 'apps/mobile/app.json');
  const config = JSON.parse(readFileSync(app, 'utf8'));
  config.expo.extra = { eas: { projectId } };
  writeFileSync(app, JSON.stringify(config));
  cpSync(workspace, archive, { recursive: true });
});

afterEach(() => {
  if (workspace) rmSync(workspace, { force: true, recursive: true });
  if (inspection) rmSync(inspection, { force: true, recursive: true });
});

function check(root = workspace, id = projectId) {
  return spawnSync('bash', [prepare, '--check', workspace, id, archive], {
    cwd: join(workspace, 'apps/mobile'),
    env: { ...process.env, EAS_NO_VCS: '1', EAS_PROJECT_ROOT: root },
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

it.each([
  'apps/mobile/modules/application-https/ios/HttpsTransport.swift',
  'apps/mobile/modules/application-https/ios/ApplicationHttps.podspec',
  'apps/mobile/qualification/native-https-entry.tsx',
  'apps/mobile/package.json',
  'pnpm-lock.yaml',
])('refuses a changed %s in the archive', (path) => {
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

it('refuses a stale workspace root', () => expect(check(inspection).status).toBe(1));
it('refuses the wrong linked project', () => expect(check(workspace, randomUUID()).status).toBe(1));
