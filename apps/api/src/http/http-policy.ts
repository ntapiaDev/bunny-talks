import { BadRequestException, HttpException, UnsupportedMediaTypeException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export const maxBodyBytes = 8192;
const methods: Readonly<Record<string, readonly string[]>> = {
  '/health/live': ['GET'],
  '/v1/session': ['GET', 'DELETE'],
};

/** Runs before parsing so errors, including oversized bodies, cannot be cached. */
export function httpPolicy(request: Request, response: Response, next: NextFunction): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (request.rawHeaders.length > 128) {
    next(new BadRequestException());
    return;
  }
  const seen = new Set<string>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase();
    if (
      ['host', 'content-type', 'content-encoding', 'content-length', 'transfer-encoding'].includes(
        name,
      )
    ) {
      if (seen.has(name)) {
        next(new BadRequestException());
        return;
      }
      seen.add(name);
    }
  }
  const type = request.headers['content-type'];
  const hasBody =
    request.headers['transfer-encoding'] !== undefined ||
    (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0');
  if (Number(request.headers['content-length']) > maxBodyBytes) {
    next(new HttpException('', 413));
    return;
  }
  if (
    (type !== undefined && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) ||
    (hasBody && type === undefined) ||
    (request.headers['content-encoding'] !== undefined &&
      request.headers['content-encoding'] !== 'identity')
  ) {
    next(new UnsupportedMediaTypeException());
    return;
  }
  next();
}

/** Current routes accept no body or query, including authentication/identity selectors. */
export function noInputPolicy(request: Request, response: Response, next: NextFunction): void {
  if (request.originalUrl.includes('?') || request.body !== undefined) {
    next(new BadRequestException());
    return;
  }
  const allowed = methods[request.path];
  if (allowed && !allowed.includes(request.method)) {
    response.setHeader('Allow', allowed.join(', '));
    next(new HttpException('', 405));
    return;
  }
  next();
}
