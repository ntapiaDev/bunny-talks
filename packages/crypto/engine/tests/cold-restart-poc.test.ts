import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.each(['@open-e2ee/signal-protocol-sdk', '@bunny-talks/open-e2ee-14-4'])(
  'resumes SQLCipher sessions from %s in a fresh 14.5.0 process',
  async (source) => {
    const directory = await mkdtemp(join(tmpdir(), 'bunny-cold-restart-'));
    const script = fileURLToPath(new URL('./fixtures/cold-restart.mjs', import.meta.url));
    const run = promisify(execFile);
    try {
      const first = await run(process.execPath, [script, directory, 'prepare', source], {
        timeout: 30000,
      });
      expect(first.stdout).toBe('');
      expect(first.stderr).toBe('');
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const device of ['alice', 'bob'])
        expect((await stat(join(directory, `${device}.secret`))).mode & 0o777).toBe(0o600);
      for (const phase of ['missing-key', 'wrong-key']) {
        const refused = await run(process.execPath, [script, directory, phase], { timeout: 30000 });
        expect(refused.stdout).toBe('');
        expect(refused.stderr).toBe('');
      }
      const second = await run(process.execPath, [script, directory, 'resume'], { timeout: 30000 });
      expect(second.stdout).toBe('');
      expect(second.stderr).toBe('');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  70000,
);
