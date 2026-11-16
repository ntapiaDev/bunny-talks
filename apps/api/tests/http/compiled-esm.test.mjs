import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { test } from 'vitest';

const apiRoot = new URL('../../', import.meta.url);
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    return entry.isDirectory() ? files(path) : [path];
  });
}

test('emits only current production sources and imports every module with Node ESM', () => {
  const sourceRoot = new URL('src/', apiRoot);
  const outputRoot = new URL('dist/src/', apiRoot);
  const expected = files(sourceRoot).map((file) =>
    file.href.slice(sourceRoot.href.length).replace(/\.ts$/, ''),
  );
  const actual = files(outputRoot).map((file) => file.href.slice(outputRoot.href.length));
  assert.deepEqual(
    actual.sort(),
    expected.flatMap((file) => [`${file}.js`, `${file}.d.ts`]).sort(),
  );
  assert.ok(existsSync(new URL('dist/generated/prisma/client.js', apiRoot)));
  assert.equal(existsSync(new URL('dist/tests', apiRoot)), false);
  const modules = files(outputRoot).filter((file) => file.pathname.endsWith('.js'));
  const output = execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `
    await import('reflect-metadata');
    for (const path of process.argv.slice(1)) await import(path);
    process.stdout.write('ESM imports verified\\n');
  `,
      ...modules.map((file) => file.href),
    ],
    {
      cwd: fileURLToPath(apiRoot),
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.equal(output, 'ESM imports verified\n');
});
