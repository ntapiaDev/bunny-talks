import process from 'node:process';
import { loadLocalEnv } from './local-env.mjs';

try {
  loadLocalEnv();
  const { startHttpServer } = await import('./dist/src/main.js');
  await startHttpServer();
} catch {
  process.stderr.write('HTTP server startup failed\n');
  process.exitCode = 1;
}
