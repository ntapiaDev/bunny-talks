import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { loadLocalEnv } from '../local-env.mjs';
import { createHttpApplication } from '../src/http/application.js';
import { readHttpConfig } from '../src/http/config.js';
import { Database } from '../src/http/database.js';
import { SessionHttpService } from '../src/http/session-http.service.js';
import { PostgresSessionRepository } from '../src/postgres-session-repository.js';
import { createTestDatabase } from './postgres-test-database.js';

loadLocalEnv();
describe('real Nest HTTP and PostgreSQL 18.7', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let client: PrismaClient;
  let repository: PostgresSessionRepository;
  let app: NestExpressApplication;
  let base: string;
  let logs: string[];
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;
  const secrets: string[] = [];

  beforeAll(async () => {
    logs = [];
    // Capture actual application output; never print captured payloads in assertions.
    const writeOut = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((...args: Parameters<typeof process.stdout.write>) => {
        logs.push(String(args[0]));
        return writeOut(...args);
      });
    stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((...args: Parameters<typeof process.stderr.write>) => {
        logs.push(String(args[0]));
        return writeErr(...args);
      });
    db = await createTestDatabase();
    client = db.createClient();
    repository = new PostgresSessionRepository(client);
    app = await createHttpApplication(
      readHttpConfig({ DATABASE_URL: db.url, NODE_ENV: 'test', API_PORT: '0' }),
    );
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  }, 30000);
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      try {
        await db?.dispose();
      } finally {
        stdout?.mockRestore();
        stderr?.mockRestore();
      }
    }
  });
  async function fixture(options: { authorized?: boolean; expired?: boolean } = {}) {
    const accountId = `http-fixture:${randomUUID()}`;
    await client.account.create({ data: { id: accountId } });
    const creator = options.expired
      ? new PostgresSessionRepository(client, undefined, () => new Date(Date.now() - 31 * 86400000))
      : repository;
    const result = await creator.createAfterAuthentication(accountId);
    secrets.push(result.token);
    if (options.authorized) {
      // Trusted storage fixture only. No HTTP API may set server authorization.
      await client.device.update({
        where: { id: result.session.deviceId },
        data: { authorizedAt: new Date() },
      });
    }
    return { accountId, ...result };
  }
  async function call(
    path = '/v1/session',
    options: {
      token?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ) {
    return fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: options.body }),
    });
  }
  function raw(
    path: string,
    headers: readonly string[],
    method = 'GET',
    body?: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        `${base}${path}`,
        { method, headers: ['Host', new URL(base).host, ...headers] },
        (response) => {
          let content = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            content += chunk;
          });
          response.on('end', () => resolve({ status: response.statusCode!, body: content }));
        },
      );
      request.on('error', reject);
      request.end(body);
    });
  }
  async function unauthorized(response: Response) {
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: { code: 'UNAUTHORIZED' } });
  }
  it('starts on an ephemeral loopback port and exposes only minimal public liveness', async () => {
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
    const response = await call('/health/live');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('x-powered-by')).toBeNull();
  });
  it('rejects missing authentication', async () => {
    await unauthorized(await call());
  });
  it.each(['Basic bad', 'Bearer malformed', 'Bearer  s1.bad.bad', 'Bearer\ts1.bad.bad'])(
    'rejects malformed Bearer: %s',
    async (header) => {
      await unauthorized(await call('/v1/session', { headers: { Authorization: header } }));
    },
  );
  it('rejects duplicate and comma-joined Authorization headers over the real HTTP parser', async () => {
    const f = await fixture();
    for (const headers of [
      ['Authorization', `Bearer ${f.token}`, 'authorization', `Bearer ${f.token}`],
      ['Authorization', `Bearer ${f.token}, Bearer ${f.token}`],
    ]) {
      const response = await raw('/v1/session', headers);
      expect(response.status).toBe(401);
      expect(JSON.parse(response.body)).toEqual({ error: { code: 'UNAUTHORIZED' } });
    }
  });
  it('rejects the right session ID with an incorrect canonical secret', async () => {
    const f = await fixture();
    await unauthorized(
      await call('/v1/session', {
        token: `${f.token.slice(0, 40)}${Buffer.alloc(32, 9).toString('base64url')}`,
      }),
    );
  });
  it('rejects ambiguous content headers and excess headers without hiding duplicate credentials', async () => {
    const f = await fixture();
    expect(
      (
        await raw('/v1/session', [
          'Content-Type',
          'application/json',
          'content-type',
          'text/plain',
          'Authorization',
          `Bearer ${f.token}`,
        ])
      ).status,
    ).toBe(400);
    const headers = ['Authorization', `Bearer ${f.token}`];
    for (let index = 0; index < 65; index++) headers.push(`X-Fixture-${index}`, 'x');
    headers.push('authorization', `Bearer ${f.token}`);
    expect((await raw('/v1/session', headers)).status).toBe(400);
  });
  it('rejects inactivity expiration without extending the session', async () => {
    const f = await fixture();
    const creator = new PostgresSessionRepository(
      client,
      { absoluteMs: 86400000, idleMs: 1000 },
      () => new Date(Date.now() - 2000),
    );
    const idle = await creator.createAfterAuthentication(f.accountId);
    await unauthorized(await call('/v1/session', { token: idle.token }));
    expect(
      (await client.session.findUniqueOrThrow({ where: { id: idle.session.id } })).lastSeenAt,
    ).toEqual(idle.session.lastSeenAt);
  });
  it('rejects expired sessions', async () => {
    const f = await fixture({ expired: true });
    await unauthorized(await call('/v1/session', { token: f.token }));
  });
  it('rejects revoked sessions', async () => {
    const f = await fixture();
    await repository.revokeCurrent(f.token);
    await unauthorized(await call('/v1/session', { token: f.token }));
  });
  it('rejects revoked devices', async () => {
    const f = await fixture();
    await repository.revokeDevicesAfterAuthorization(f.accountId, [f.session.deviceId]);
    await unauthorized(await call('/v1/session', { token: f.token }));
  });
  it.each([false, true])(
    'returns exactly the verified session for authorized=%s and updates only inactivity',
    async (authorized) => {
      const f = await fixture({ authorized });
      await delay(5);
      const response = await call('/v1/session', { token: f.token });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        accountId: f.accountId,
        sessionId: f.session.id,
        deviceId: f.session.deviceId,
        deviceState: authorized ? 'authorized' : 'pending',
        expiresAt: f.session.expiresAt.toISOString(),
      });
      const stored = await client.session.findUniqueOrThrow({ where: { id: f.session.id } });
      expect(stored.lastSeenAt.getTime()).toBeGreaterThan(f.session.lastSeenAt.getTime());
      expect(stored.expiresAt).toEqual(f.session.expiresAt);
      expect(await client.vaultState.count({ where: { accountId: f.accountId } })).toBe(0);
    },
  );
  it('isolates two accounts and refuses query/body identity selectors', async () => {
    const a = await fixture();
    const b = await fixture();
    const response = await call('/v1/session', { token: a.token });
    const text = await response.text();
    expect(text).not.toContain(b.accountId);
    expect(text).not.toContain(b.session.id);
    expect((await call(`/v1/session?accountId=${b.accountId}`, { token: a.token })).status).toBe(
      400,
    );
    expect(
      (
        await call('/v1/session', {
          token: a.token,
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: b.session.id }),
        })
      ).status,
    ).toBe(400);
    expect((await repository.read(b.token)).id).toBe(b.session.id);
  });
  it('does not accept cookies, custom headers, query strings or JSON as authentication', async () => {
    const f = await fixture();
    await unauthorized(
      await call('/v1/session', {
        headers: { Cookie: `session=${f.token}`, 'X-Session-Token': f.token },
      }),
    );
    expect((await call(`/v1/session?token=${f.token}`)).status).toBe(400);
    expect(
      (
        await call('/v1/session', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: f.token }),
        })
      ).status,
    ).toBe(400);
  });
  it('revokes only the current session, preserving other sessions, devices and authorization', async () => {
    const a = await fixture({ authorized: true });
    const b = await fixture();
    const second = await repository.createAfterAuthentication(a.accountId, a.session.deviceId);
    const otherDevice = await repository.createAfterAuthentication(a.accountId);
    const response = await call('/v1/session', { method: 'DELETE', token: a.token });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.get('cache-control')).toBe('no-store');
    await unauthorized(await call('/v1/session', { token: a.token }));
    await unauthorized(await call('/v1/session', { token: a.token, method: 'DELETE' }));
    for (const token of [second.token, otherDevice.token, b.token])
      expect((await call('/v1/session', { token })).status).toBe(200);
    const device = await client.device.findUniqueOrThrow({ where: { id: a.session.deviceId } });
    expect(device.revokedAt).toBeNull();
    expect(device.authorizedAt).not.toBeNull();
  });
  it('revalidates a revocation when the session is revoked after the guard has passed', async () => {
    const f = await fixture();
    const service = app.get(SessionHttpService);
    const revoke = service.revokeCurrent.bind(service);
    const spy = vi.spyOn(service, 'revokeCurrent').mockImplementationOnce(async (token) => {
      await repository.revokeCurrent(token);
      await revoke(token);
    });
    try {
      await unauthorized(await call('/v1/session', { token: f.token, method: 'DELETE' }));
    } finally {
      spy.mockRestore();
    }
  });
  it('serializes simultaneous HTTP revocations: only one succeeds', async () => {
    const f = await fixture();
    const responses = await Promise.all([
      call('/v1/session', { token: f.token, method: 'DELETE' }),
      call('/v1/session', { token: f.token, method: 'DELETE' }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([204, 401]);
    await Promise.all(responses.map((response) => response.arrayBuffer()));
    await unauthorized(await call('/v1/session', { token: f.token }));
  });
  it('waits for a concurrent revocation and rejects validation after its commit', async () => {
    const f = await fixture();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const transaction = client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${f.accountId} FOR UPDATE`;
      await tx.session.update({ where: { id: f.session.id }, data: { revokedAt: new Date() } });
      reached();
      await gate;
    });
    await ready;
    const response = call('/v1/session', { token: f.token });
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const rows = await client.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) FROM pg_stat_activity WHERE application_name = 'bunny-talks-http' AND wait_event_type = 'Lock'`;
        if (rows[0]!.count > 0n) {
          waiting = true;
          break;
        }
        await delay(10);
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await transaction;
    }
    await unauthorized(await response);
  });
  it('sanitizes actual PostgreSQL failures and keeps liveness independent', async () => {
    const f = await fixture();
    await client.$executeRawUnsafe('ALTER TABLE "Session" RENAME TO "Session_unavailable"');
    try {
      const response = await call('/v1/session', { token: f.token });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: 'SERVICE_UNAVAILABLE' } });
      expect((await call('/health/live')).status).toBe(200);
    } finally {
      await client.$executeRawUnsafe('ALTER TABLE "Session_unavailable" RENAME TO "Session"');
    }
    expect((await call('/v1/session', { token: f.token })).status).toBe(200);
  });
  it('reports transaction lock timeouts as unavailable, never as invalid credentials', async () => {
    const f = await fixture();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const transaction = client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${f.accountId} FOR UPDATE`;
      reached();
      await gate;
    });
    await ready;
    const start = performance.now();
    try {
      const response = await call('/v1/session', { token: f.token });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: 'SERVICE_UNAVAILABLE' } });
      expect(performance.now() - start).toBeGreaterThanOrEqual(900);
    } finally {
      release();
      await transaction;
    }
  });
  it('disables caching, CORS and implicit HEAD/OPTIONS and ignores forwarded headers', async () => {
    const f = await fixture();
    const response = await call('/v1/session', {
      token: f.token,
      headers: {
        Origin: 'https://untrusted.example',
        'X-Forwarded-For': '1.2.3.4',
        'X-Forwarded-Proto': 'https',
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('etag')).toBeNull();
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(app.getHttpAdapter().getInstance().get('trust proxy')).toBe(false);
    for (const method of ['HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH']) {
      const rejected = await call('/v1/session', { token: f.token, method });
      expect(rejected.status).toBe(405);
      expect(rejected.headers.get('allow')).toBe('GET, DELETE');
      await rejected.arrayBuffer();
    }
  });
  it.each([
    ['application/json', '{', 400],
    ['application/json', '{}', 400],
    ['application/json', 'null', 400],
    ['text/plain', '{}', 415],
    ['application/x-www-form-urlencoded', 'token=x', 415],
    ['application/json; charset=iso-8859-1', '{}', 415],
    ['application/json', `"${'x'.repeat(8192)}"`, 413],
  ])(
    'rejects malformed, unsupported or oversized input case %#',
    async (contentType, body, status) => {
      const response = await call('/v1/session', {
        method: 'DELETE',
        headers: { 'Content-Type': contentType },
        body,
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        error: {
          code:
            status === 400
              ? 'BAD_REQUEST'
              : status === 413
                ? 'PAYLOAD_TOO_LARGE'
                : 'UNSUPPORTED_MEDIA_TYPE',
        },
      });
    },
  );
  it('bounds chunked JSON and refuses bodies without a content type and compressed bodies', async () => {
    expect(
      (
        await raw(
          '/v1/session',
          ['Transfer-Encoding', 'chunked', 'Content-Type', 'application/json'],
          'DELETE',
          'x'.repeat(8193),
        )
      ).status,
    ).toBe(413);
    expect((await raw('/v1/session', ['Content-Length', '2'], 'DELETE', '{}')).status).toBe(415);
    expect(
      (
        await call('/v1/session', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
          body: '{}',
        })
      ).status,
    ).toBe(415);
  });
  it('exposes none of the sensitive endpoints', async () => {
    const f = await fixture();
    for (const path of [
      '/v1/login',
      '/v1/registration',
      '/v1/email/verify',
      '/v1/vault',
      '/v1/bootstrap',
      '/v1/password',
      '/v1/grants',
      '/v1/devices',
      '/swagger',
    ]) {
      const response = await call(path, { token: f.token, method: 'POST' });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND' } });
    }
  });
  it('never exposes bearer tokens in successful/error responses or application logs', async () => {
    const f = await fixture();
    for (const response of [
      await call('/v1/session', { token: f.token }),
      await call('/v1/session', { headers: { Authorization: `Basic ${f.token}` } }),
    ]) {
      expect((await response.text()).includes(f.token)).toBe(false);
    }
    expect(secrets.some((secret) => logs.join('').includes(secret))).toBe(false);
  });
  it('runs the compiled ESM entrypoint and releases its HTTP server and database pool on SIGTERM', async () => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    const child = spawn(process.execPath, ['server.mjs'], {
      env: {
        ...process.env,
        DATABASE_URL: db.url,
        NODE_ENV: 'test',
        API_HOST: '127.0.0.1',
        API_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = once(child, 'exit');
    try {
      let ready = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        if (child.exitCode !== null) break;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health/live`);
          ready = response.status === 200;
          await response.arrayBuffer();
          if (ready) break;
        } catch {
          /* The child has not started listening yet. */
        }
        await delay(20);
      }
      expect(ready).toBe(true);
      const f = await fixture();
      const response = await fetch(`http://127.0.0.1:${port}/v1/session`, {
        headers: { Authorization: `Bearer ${f.token}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ accountId: f.accountId });
      child.kill('SIGTERM');
      await Promise.race([
        exited,
        delay(4000).then(() => {
          throw new Error('Compiled server did not stop');
        }),
      ]);
      expect(secrets.some((secret) => output.includes(secret))).toBe(false);
      expect(output).toBe('');
      await expect(fetch(`http://127.0.0.1:${port}/health/live`)).rejects.toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  }, 15000);
  it('fails startup cleanly when PostgreSQL is unreachable', async () => {
    const url = new URL(db.url);
    url.port = '1';
    await expect(
      createHttpApplication(
        readHttpConfig({ DATABASE_URL: url.toString(), NODE_ENV: 'test', API_PORT: '0' }),
      ),
    ).rejects.toThrow('HTTP server initialization failed');
  });
  it('closes its server and leaves no PostgreSQL connections after shutdown', async () => {
    const database = app.get(Database);
    const [backend] = await database.client.$queryRaw<
      { pid: number }[]
    >`SELECT pg_backend_pid() AS pid`;
    await app.close();
    expect(app.getHttpServer().listening).toBe(false);
    await expect(fetch(`${base}/health/live`)).rejects.toThrow();
    const rows = await client.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) FROM pg_stat_activity WHERE pid = ${backend!.pid} OR application_name = 'bunny-talks-http'`;
    expect(rows[0]!.count).toBe(0n);
  });
});
