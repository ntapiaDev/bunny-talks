import {
  BadRequestException,
  HttpException,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { json } from 'express';
import { acceptHttpInput } from './http-input.guard.js';

export const maxBodyBytes = 8192;

/** Global transport protections run before any route-specific parsing. */
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
  next();
}

/** Bounds both declared and streamed JSON; does not validate a business schema. */
export function jsonBodyPolicy(limit = maxBodyBytes): RequestHandler {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid HTTP body limit');
  const parse = json({ limit, inflate: false, strict: true });
  return (request, response, next) => {
    const type = request.headers['content-type'];
    const hasBody =
      request.headers['transfer-encoding'] !== undefined ||
      (request.headers['content-length'] !== undefined &&
        request.headers['content-length'] !== '0');
    if (Number(request.headers['content-length']) > limit) {
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
    parse(request, response, next);
  };
}

/** Run after bounded parsing, before authentication, including for disallowed methods. */
export function noInputPolicy(
  canonicalPath: string,
  allowedMethods: readonly string[],
): RequestHandler {
  return (request, response, next) => {
    if (request.originalUrl.includes('?') || request.body !== undefined) {
      next(new BadRequestException());
      return;
    }
    // Preserve 4.4C1's method policy: router aliases did not use the canonical method table.
    if (request.path === canonicalPath && !allowedMethods.includes(request.method)) {
      response.setHeader('Allow', allowedMethods.join(', '));
      next(new HttpException('', 405));
      return;
    }
    acceptHttpInput(request);
    next();
  };
}

/** Exact sensitive routes: reject router aliases and query strings before any handler runs. */
export function exactJsonRoutePolicy(
  canonicalPath: string,
  allowedMethods: readonly string[],
): RequestHandler {
  return (request, response, next) => {
    if (request.path !== canonicalPath) {
      next(new NotFoundException());
      return;
    }
    if (request.originalUrl.includes('?')) {
      next(new BadRequestException());
      return;
    }
    if (!allowedMethods.includes(request.method)) {
      response.setHeader('Allow', allowedMethods.join(', '));
      next(new HttpException('', 405));
      return;
    }
    acceptHttpInput(request);
    next();
  };
}
