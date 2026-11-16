import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'vitest';
import { loadLocalEnv } from '../../../local-env.mjs';

test('loads a local env file while preserving injected variables', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bunny-env-test-'));
  const path = join(directory, '.env');
  const previousFileValue = process.env.BUNNY_TEST_FILE_VALUE;
  const previousInjectedValue = process.env.BUNNY_TEST_INJECTED_VALUE;
  try {
    delete process.env.BUNNY_TEST_FILE_VALUE;
    process.env.BUNNY_TEST_INJECTED_VALUE = 'injected';
    writeFileSync(path, 'BUNNY_TEST_FILE_VALUE=from_file\nBUNNY_TEST_INJECTED_VALUE=from_file\n');
    loadLocalEnv(path);
    assert.equal(process.env.BUNNY_TEST_FILE_VALUE, 'from_file');
    assert.equal(process.env.BUNNY_TEST_INJECTED_VALUE, 'injected');
    loadLocalEnv(join(directory, 'absent'));
    assert.throws(() => loadLocalEnv(directory));
  } finally {
    if (previousFileValue === undefined) delete process.env.BUNNY_TEST_FILE_VALUE;
    else process.env.BUNNY_TEST_FILE_VALUE = previousFileValue;
    if (previousInjectedValue === undefined) delete process.env.BUNNY_TEST_INJECTED_VALUE;
    else process.env.BUNNY_TEST_INJECTED_VALUE = previousInjectedValue;
    rmSync(directory, { recursive: true, force: true });
  }
});
