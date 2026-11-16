import 'reflect-metadata';
import type { Server } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import type { HttpConfig } from './config.js';
import { Database } from './shared/database/database.js';
import { configureHttpTransport } from './shared/http/http-transport.js';

export async function createHttpApplication(
  config: HttpConfig,
): Promise<NestExpressApplication<Server>> {
  const app = await NestFactory.create<NestExpressApplication<Server>>(AppModule.register(config), {
    logger: false,
    abortOnError: false,
    bodyParser: false,
  });
  try {
    configureHttpTransport(app);
    await app.init();
    // Startup checks connectivity; liveness deliberately makes no database query.
    await app.get(Database).client.$queryRaw`SELECT 1`;
    return app;
  } catch {
    await app.close();
    throw new Error('HTTP server initialization failed');
  }
}
