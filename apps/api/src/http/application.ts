import 'reflect-metadata';
import type { Server } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import type { HttpConfig } from './config.js';
import { Database } from './database.js';
import { HttpErrorFilter } from './http-error-filter.js';
import { httpPolicy, maxBodyBytes, noInputPolicy } from './http-policy.js';

export async function createHttpApplication(
  config: HttpConfig,
): Promise<NestExpressApplication<Server>> {
  const app = await NestFactory.create<NestExpressApplication<Server>>(AppModule.register(config), {
    logger: false,
    abortOnError: false,
    bodyParser: false,
  });
  try {
    app.disable('x-powered-by');
    app.disable('etag');
    app.set('trust proxy', false);
    app.set('case sensitive routing', true);
    app.set('strict routing', true);
    app.useGlobalFilters(new HttpErrorFilter());
    app.use(httpPolicy);
    app.useBodyParser('json', { limit: maxBodyBytes, inflate: false, strict: true });
    app.use(noInputPolicy);
    const server = app.getHttpServer();
    server.requestTimeout = 10000;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 1000;
    // Reject excess headers ourselves instead of silently truncating duplicate credentials.
    server.maxHeadersCount = 0;
    await app.init();
    // Startup checks connectivity; liveness deliberately makes no database query.
    await app.get(Database).client.$queryRaw`SELECT 1`;
    return app;
  } catch {
    await app.close();
    throw new Error('HTTP server initialization failed');
  }
}
