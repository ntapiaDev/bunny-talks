import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { BadRequestException, HttpException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { readHttpConfig } from '../src/http/config.js';
import { classifyHttpError } from '../src/http/http-error-filter.js';
import { parseBearer, PublicRoute, SessionGuard } from '../src/http/session.guard.js';
import { sessionDto, SessionHttpService } from '../src/http/session-http.service.js';
import { generateSessionToken, SessionError } from '../src/session-token.js';

describe('HTTP components (isolated, without authentication claims)', () => {
  const token = generateSessionToken().token;
  it.each(['Bearer', 'bearer', 'BEARER'])('accepts the case-insensitive %s scheme', (scheme) => {
    expect(parseBearer(['Host', 'localhost', 'Authorization', `${scheme} ${token}`])).toBe(token);
  });
  it.each([
    [],
    ['Authorization', ''],
    ['Authorization', token],
    ['Authorization', `Basic ${token}`],
    ['Authorization', `Bearer  ${token}`],
    ['Authorization', `Bearer\t${token}`],
    ['Authorization', ` Bearer ${token}`],
    ['Authorization', `Bearer ${token} `],
    ['Authorization', `Bearer ${token}, Bearer ${token}`],
    ['Authorization', `Bearer ${token}= `],
    ['Authorization', `Bearer ${token}`, 'authorization', `Bearer ${token}`],
    ['Authorization', `Bearer ${token.toUpperCase()}`],
    ['Authorization', 'Bearer s1.bad.bad'],
    ['Cookie', `session=${token}`],
    ['X-Session-Token', token],
  ])('rejects missing, ambiguous or noncanonical header case %#', (...headers) => {
    expect(() => parseBearer(headers)).toThrow(UnauthorizedException);
  });
  it('does not include secrets in authentication exceptions', () => {
    try {
      parseBearer(['Authorization', `Basic ${token}`]);
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
  });
  it.each([
    [new SessionError('INVALID_SESSION'), 401, 'UNAUTHORIZED'],
    [new SessionError('INVALID_INPUT'), 400, 'BAD_REQUEST'],
    [new SessionError('UNAVAILABLE'), 503, 'SERVICE_UNAVAILABLE'],
    [new SessionError('OUTCOME_UNKNOWN'), 503, 'SERVICE_UNAVAILABLE'],
    [new Error(`SQL /private/path ${token}`), 500, 'INTERNAL_ERROR'],
    [new BadRequestException(token), 400, 'BAD_REQUEST'],
    [new HttpException(token, 418), 500, 'INTERNAL_ERROR'],
    [{ type: 'entity.too.large', body: token }, 413, 'PAYLOAD_TOO_LARGE'],
    [{ type: 'entity.parse.failed', body: token }, 400, 'BAD_REQUEST'],
    [{ type: 'charset.unsupported' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [{ code: 'P1001', message: token }, 500, 'INTERNAL_ERROR'],
  ])('classifies errors without reflecting their payload', (error, status, code) => {
    expect(classifyHttpError(error)).toEqual({ status, code });
  });
  it('exempts only explicitly public handlers and protects new routes by default', async () => {
    class Routes {
      @PublicRoute()
      public live() {}
      public privateRoute() {}
    }
    const service = Object.create(SessionHttpService.prototype) as SessionHttpService;
    const authenticate = vi.spyOn(service, 'authenticate');
    const guard = new SessionGuard(new Reflector(), service);
    const context = (handler: () => void) =>
      ({
        getHandler: () => handler,
        getClass: () => Routes,
        switchToHttp: () => ({ getRequest: () => ({ rawHeaders: [] }) }),
      }) as unknown as ExecutionContext;
    expect(await guard.canActivate(context(Routes.prototype.live))).toBe(true);
    await expect(guard.canActivate(context(Routes.prototype.privateRoute))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(authenticate).not.toHaveBeenCalled();
  });
  it('projects exactly the public DTO and serializes the absolute expiration', () => {
    const date = new Date('2026-11-16T00:00:00.000Z');
    expect(
      sessionDto({
        id: 'session',
        accountId: 'account',
        deviceId: 'device',
        createdAt: date,
        expiresAt: date,
        lastSeenAt: date,
        deviceState: 'pending',
      }),
    ).toEqual({
      sessionId: 'session',
      accountId: 'account',
      deviceId: 'device',
      deviceState: 'pending',
      expiresAt: date.toISOString(),
    });
  });
});

describe('HTTP startup configuration', () => {
  const databaseUrl = 'postgresql://fixture:fixture@127.0.0.1:55439/bunny_talks_test';
  it('defaults to loopback development and allows ephemeral ports only in tests', () => {
    expect(readHttpConfig({ DATABASE_URL: databaseUrl })).toEqual({
      databaseUrl,
      host: '127.0.0.1',
      port: 3000,
      mode: 'development',
    });
    expect(
      readHttpConfig({ DATABASE_URL: databaseUrl, NODE_ENV: 'test', API_PORT: '0' }).port,
    ).toBe(0);
  });
  it.each([
    {},
    { DATABASE_URL: 'secret' },
    { DATABASE_URL: 'http://fixture:fixture@localhost/db' },
    { DATABASE_URL: 'postgresql://localhost/db' },
    { NODE_ENV: 'staging' },
    { API_HOST: '' },
    { API_HOST: 'localhost' },
    { API_HOST: '127.0.0.1\n' },
    { API_PORT: '0' },
    { API_PORT: '65536' },
    { API_PORT: '-1' },
    { API_PORT: '3000x' },
    { API_PORT: '03000' },
    { API_PORT: '3e3' },
    { API_PORT: ' 3000' },
    { NODE_ENV: 'production' },
    { DATABASE_URL: 'postgresql://fixture:fixture@remote.example/db' },
    { DATABASE_URL: `${databaseUrl}?host=remote.example` },
    { DATABASE_URL: `${databaseUrl}?sslmode=verify-full&sslmode=disable` },
    { DATABASE_URL: `${databaseUrl}?sslmode=require` },
    { DATABASE_URL: `${databaseUrl}?schema=invalid-schema` },
    { DATABASE_URL: `${databaseUrl}?schema=public&schema=other` },
  ])('rejects invalid configuration without disclosing values: %j', (overrides) => {
    const env =
      Object.keys(overrides).length === 0 ? {} : { DATABASE_URL: databaseUrl, ...overrides };
    expect(() => readHttpConfig(env)).toThrow('Invalid HTTP server configuration');
  });
  it('requires explicit certificate verification for remote or production PostgreSQL', () => {
    expect(
      readHttpConfig({
        DATABASE_URL: 'postgresql://fixture:fixture@remote.example/db?sslmode=verify-full',
        NODE_ENV: 'production',
        API_HOST: '::1',
      }).mode,
    ).toBe('production');
  });
});
