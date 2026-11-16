import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { HttpErrorFilter } from './http-error-filter.js';
import { httpPolicy } from './http-policy.js';

/** Configure the same global protections for production and HTTP qualification. */
export function configureHttpTransport(app: NestExpressApplication<Server>): void {
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', false);
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  app.useGlobalFilters(new HttpErrorFilter());
  app.use(httpPolicy);
  const server = app.getHttpServer();
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  // Reject excess headers ourselves instead of silently truncating duplicate credentials.
  server.maxHeadersCount = 0;
}
