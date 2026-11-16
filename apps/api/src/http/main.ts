import process from 'node:process';
import { createHttpApplication } from './application.js';
import { readHttpConfig } from './config.js';

export async function startHttpServer(): Promise<void> {
  const config = readHttpConfig(process.env);
  const app = await createHttpApplication(config);
  try {
    app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
    await app.listen(config.port, config.host);
  } catch {
    await app.close();
    throw new Error('HTTP server startup failed');
  }
}
