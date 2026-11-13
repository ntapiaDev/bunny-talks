import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('resumes established sessions in a fresh Node process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bunny-cold-restart-'));
  const script = fileURLToPath(new URL('./fixtures/cold-restart.mjs', import.meta.url));
  const run = promisify(execFile);
  try {
    const first = await run(process.execPath, [script, directory, 'prepare'], { timeout: 30000 });
    expect(first.stdout).toBe('');
    expect(first.stderr).toBe('');
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const device of ['alice', 'bob'])
      expect((await stat(join(directory, `${device}.secret`))).mode & 0o777).toBe(0o600);
    const second = await run(process.execPath, [script, directory, 'resume'], { timeout: 30000 });
    expect(second.stdout).toBe('');
    expect(second.stderr).toBe('');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 70000);
