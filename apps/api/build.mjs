import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { URL } from 'node:url';

// TypeScript does not remove outputs left behind by moved or deleted sources.
rmSync(new URL('./dist', import.meta.url), { recursive: true, force: true });
execFileSync('tsc', ['-p', 'tsconfig.json'], {
  cwd: new URL('.', import.meta.url),
  stdio: 'inherit',
});
