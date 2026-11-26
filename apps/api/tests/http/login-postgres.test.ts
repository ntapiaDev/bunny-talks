import type { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { loadLocalEnv } from '../../local-env.mjs';
import { createHttpApplication } from '../../src/application.js';
import { createPasswordVerifier, PasswordVerifierError } from '../../src/auth/password-verifier.js';
import { PostgresSessionRepository } from '../../src/auth/sessions/postgres-session-repository.js';
import { SessionError } from '../../src/auth/sessions/session-token.js';
import { VerifiedLogin } from '../../src/auth/verified-login.js';
import { Database } from '../../src/shared/database/database.js';
import { expectKnownLengthResponse } from '../support/known-length-response.js';
import {
  loginApplication,
  loginPassword,
  loginTestConfig,
  registeredLoginAccount,
} from '../support/login-fixture.js';
import { createTestDatabase } from '../support/postgres-test-database.js';

loadLocalEnv();
const path = '/v1/auth/login';
describe('HTTP login with real Nest, PostgreSQL 18.7 and compiled ESM', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let client: PrismaClient;
  let app: NestExpressApplication;
  let base: string;
  const logs: string[] = [];
  const secrets = [loginPassword];
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeAll(async () => {
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((...args: Parameters<typeof process.stdout.write>) => {
        logs.push(String(args[0]));
        return out(...args);
      });
    stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((...args: Parameters<typeof process.stderr.write>) => {
        logs.push(String(args[0]));
        return err(...args);
      });
    db = await createTestDatabase();
    client = db.createClient();
    app = await loginApplication(db.url);
    base = await app.getUrl();
  }, 30000);
  beforeEach(async () => {
    await client.loginBudget.deleteMany();
    await client.loginLease.deleteMany();
  });
  afterAll(async () => {
    try {
      await app?.close();
      await db?.dispose();
    } finally {
      stdout?.mockRestore();
      stderr?.mockRestore();
    }
  });
  async function post(body: unknown, origin = base) {
    return fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  async function failure(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: { code } });
  }
  async function success(body: unknown, origin = base) {
    const response = await post(body, origin);
    expect(response.status).toBe(201);
    await expectKnownLengthResponse(response);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    const result = (await response.json()) as {
      sessionToken: string;
      session: {
        accountId: string;
        sessionId: string;
        deviceId: string;
        deviceState: string;
        expiresAt: string;
      };
    };
    secrets.push(result.sessionToken);
    expect(Object.keys(result).sort()).toEqual(['session', 'sessionToken']);
    expect(Object.keys(result.session).sort()).toEqual([
      'accountId',
      'deviceId',
      'deviceState',
      'expiresAt',
      'sessionId',
    ]);
    expect(/^s1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(result.sessionToken)).toBe(true);
    expect(result.session.deviceState).toBe('pending');
    return result;
  }
  it('creates an s1 token usable for read, deletion and immediate rejection after revocation', async () => {
    const account = await registeredLoginAccount(client);
    const result = await success({
      email: account.email.toUpperCase(),
      password: account.password,
    });
    expect(result.session.accountId).toBe(account.accountId);
    const headers = { Authorization: `Bearer ${result.sessionToken}` };
    const read = await fetch(`${base}/v1/session`, { headers });
    expect(read.status).toBe(200);
    await expectKnownLengthResponse(read);
    expect(await read.json()).toEqual(result.session);
    const revoked = await fetch(`${base}/v1/session`, { headers, method: 'DELETE' });
    expect(revoked.status).toBe(204);
    await expectKnownLengthResponse(revoked);
    const unauthorized = await fetch(`${base}/v1/session`, { headers });
    await expectKnownLengthResponse(unauthorized);
    await failure(unauthorized, 401, 'UNAUTHORIZED');
    expect(
      await client.device.findUnique({ where: { id: result.session.deviceId } }),
    ).toMatchObject({ authorizedAt: null });
  });
  it('preserves UTF-8 exactly and never authorizes/reuses existing devices or publishes a vault', async () => {
    const account = await registeredLoginAccount(client);
    const old = await new PostgresSessionRepository(client).createAfterAuthentication(
      account.accountId,
    );
    await client.device.update({
      where: { id: old.session.deviceId },
      data: { authorizedAt: new Date(), revokedAt: new Date() },
    });
    const trusted = await new PostgresSessionRepository(client).createAfterAuthentication(
      account.accountId,
    );
    await client.device.update({
      where: { id: trusted.session.deviceId },
      data: { authorizedAt: new Date() },
    });
    for (const password of [
      account.password.trim(),
      account.password.normalize('NFC'),
      account.password.toLowerCase(),
    ])
      await failure(await post({ email: account.email, password }), 401, 'UNAUTHORIZED');
    const result = await success({ email: account.email, password: account.password });
    expect([old.session.deviceId, trusted.session.deviceId]).not.toContain(result.session.deviceId);
    expect(
      (await client.device.findUniqueOrThrow({ where: { id: old.session.deviceId } })).revokedAt,
    ).not.toBeNull();
    expect(
      (await client.device.findUniqueOrThrow({ where: { id: trusted.session.deviceId } }))
        .authorizedAt,
    ).not.toBeNull();
    expect(await client.vaultState.count()).toBe(0);
    expect(await client.vaultPublication.count()).toBe(0);
    expect(await client.vaultOperation.count()).toBe(0);
    expect(await client.reauthenticationGrant.count()).toBe(0);
    for (const route of ['/v1/vault', '/v1/devices', '/v1/auth/bootstrap'])
      expect(
        (
          await fetch(`${base}${route}`, {
            headers: { Authorization: `Bearer ${result.sessionToken}` },
          })
        ).status,
      ).toBe(404);
  });
  it('uses identical errors for wrong, unknown, absent, malformed credentials and a missing verified identity', async () => {
    const account = await registeredLoginAccount(client);
    await failure(await post({ email: account.email, password: 'wrong' }), 401, 'UNAUTHORIZED');
    await failure(
      await post({ email: 'unknown@example.com', password: 'public dummy login verifier v1' }),
      401,
      'UNAUTHORIZED',
    );
    await client.passwordCredential.delete({ where: { accountId: account.accountId } });
    await failure(await post(account), 400, 'BAD_REQUEST'); // accountId is never admitted by transport.
    const input = { email: account.email, password: account.password };
    await failure(await post(input), 401, 'UNAUTHORIZED');
    await client.passwordCredential.create({
      data: { accountId: account.accountId, verifier: 'unusable' },
    });
    await failure(await post(input), 401, 'UNAUTHORIZED');
    await client.emailIdentity.delete({ where: { accountId: account.accountId } });
    await failure(await post(input), 401, 'UNAUTHORIZED');
    expect(await client.session.count({ where: { accountId: account.accountId } })).toBe(0);
  });
  it('samples error timing without claiming statistical indistinguishability', async () => {
    const account = await registeredLoginAccount(client);
    const measured = await loginApplication(db.url, { ...loginTestConfig(), requestsPerSource: 3 });
    try {
      const origin = await measured.getUrl();
      const timings: Record<string, number> = {};
      const sample = async (label: string, email: string, status: number) => {
        const start = performance.now();
        await failure(
          await post({ email, password: 'wrong password' }, origin),
          status,
          status === 429 ? 'TOO_MANY_REQUESTS' : 'UNAUTHORIZED',
        );
        timings[label] = Math.round(performance.now() - start);
      };
      await sample('wrongPasswordMs', account.email, 401);
      await sample('unknownEmailMs', 'timing-unknown@example.com', 401);
      await client.passwordCredential.delete({ where: { accountId: account.accountId } });
      await sample('missingCredentialMs', account.email, 401);
      await sample('rateLimitedMs', 'timing-unknown@example.com', 429);
      // Timings are diagnostic samples only, with no brittle performance/security threshold.
      console.info('Login timing sample (ms):', JSON.stringify(timings));
    } finally {
      await measured.close();
    }
  });
  it('accepts a short historical password without applying the current registration minimum', async () => {
    const account = await registeredLoginAccount(client);
    const verifier = await createPasswordVerifier('x');
    await client.passwordCredential.update({
      where: { accountId: account.accountId },
      data: { verifier, revision: { increment: 1 } },
    });
    await success({ email: account.email, password: 'x' });
  });
  it.each([
    {},
    [],
    { email: 'é@example.com', password: 'x' },
    { email: 3, password: 'x' },
    { email: 'a@example.com', password: null },
    { email: 'a@example.com', password: '\ud800' },
    { email: 'a@example.com', password: '😀'.repeat(257) },
  ])('rejects invalid bodies %#', async (body) => {
    await failure(await post(body), 400, 'BAD_REQUEST');
  });
  it.each([
    'accountId',
    'deviceId',
    'sessionId',
    'authorizedAt',
    'emailVerified',
    'credentialRevision',
    'sessionToken',
    'credential',
    'verified',
    'verifier',
  ])('refuses client-controlled %s', async (field) => {
    await failure(
      await post({ email: 'a@example.com', password: 'x', [field]: randomUUID() }),
      400,
      'BAD_REQUEST',
    );
  });
  it('rejects aliases, queries, HEAD and disallowed methods under the existing sensitive route policy', async () => {
    for (const alias of [`${path}/`, path.toUpperCase(), '/v1/auth/%6cogin']) {
      const response = await fetch(`${base}${alias}`, { method: 'POST' });
      expect(response.status).toBe(404);
      await expectKnownLengthResponse(response);
    }
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'DELETE', 'PUT', 'PATCH']) {
      const response = await fetch(`${base}${path}`, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
      await response.arrayBuffer();
    }
    await failure(
      await fetch(`${base}${path}?password=private`, { method: 'POST' }),
      400,
      'BAD_REQUEST',
    );
    for (const [body, type, status, code] of [
      ['{', 'application/json', 400, 'BAD_REQUEST'],
      ['null', 'application/json', 400, 'BAD_REQUEST'],
      ['{}', 'text/plain', 415, 'UNSUPPORTED_MEDIA_TYPE'],
      ['x'.repeat(8193), 'application/json', 413, 'PAYLOAD_TOO_LARGE'],
    ] as const)
      await failure(
        await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': type }, body }),
        status,
        code,
      );
    expect((await post({})).headers.get('access-control-allow-origin')).toBeNull();
  });
  it('is disabled independently of previous routes', async () => {
    const disabled = await createHttpApplication({
      databaseUrl: db.url,
      host: '127.0.0.1',
      port: 0,
      mode: 'test',
    });
    try {
      await disabled.listen(0, '127.0.0.1');
      const origin = await disabled.getUrl();
      await failure(
        await post({ email: 'a@example.com', password: 'x' }, origin),
        503,
        'SERVICE_UNAVAILABLE',
      );
      expect((await fetch(`${origin}/health/live`)).status).toBe(200);
      await failure(await fetch(`${origin}/v1/session`), 401, 'UNAUTHORIZED');
      await failure(
        await fetch(`${origin}/v1/auth/registration/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"email":"a@example.com"}',
        }),
        503,
        'SERVICE_UNAVAILABLE',
      );
    } finally {
      await disabled.close();
    }
  });
  it('enforces source quotas using the socket despite spoofed forwarding headers', async () => {
    const limited = await loginApplication(db.url, { ...loginTestConfig(), requestsPerSource: 1 });
    try {
      const origin = await limited.getUrl();
      for (let i = 0; i < 2; i++) {
        const response = await fetch(`${origin}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${i}` },
          body: JSON.stringify({ email: `${i}@example.com`, password: 'x' }),
        });
        await failure(
          response,
          i === 0 ? 401 : 429,
          i === 0 ? 'UNAUTHORIZED' : 'TOO_MANY_REQUESTS',
        );
      }
    } finally {
      await limited.close();
    }
  });
  it('applies canonical email quotas to absent accounts too, across two live instances', async () => {
    const config = { ...loginTestConfig(), requestsPerEmail: 1 };
    const first = await loginApplication(db.url, config);
    const second = await loginApplication(db.url, config);
    try {
      const responses = await Promise.all([
        post({ email: 'Unknown@Example.com', password: 'x' }, await first.getUrl()),
        post({ email: 'UNKNOWN@EXAMPLE.COM', password: 'x' }, await second.getUrl()),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([401, 429]);
      await Promise.all(responses.map((r) => r.arrayBuffer()));
    } finally {
      await first.close();
      await second.close();
    }
  });
  it('creates distinct sessions in two live API instances', async () => {
    const account = await registeredLoginAccount(client);
    const second = await loginApplication(db.url);
    try {
      const input = { email: account.email, password: account.password };
      const results = await Promise.all([success(input), success(input, await second.getUrl())]);
      expect(results[0]!.session.deviceId).not.toBe(results[1]!.session.deviceId);
    } finally {
      await second.close();
    }
  });
  it.each(['BUSY', 'CRYPTO_UNAVAILABLE'] as const)(
    'sanitizes native %s independently of identity existence',
    async (code) => {
      const account = await registeredLoginAccount(client);
      const spy = vi
        .spyOn(VerifiedLogin, 'verify')
        .mockRejectedValue(new PasswordVerifierError(code));
      try {
        for (const email of [account.email, 'unknown@example.com'])
          await failure(await post({ email, password: loginPassword }), 503, 'SERVICE_UNAVAILABLE');
      } finally {
        spy.mockRestore();
      }
      expect(await client.loginLease.count()).toBe(0);
    },
  );
  it('sanitizes database failure with no dependency on account existence', async () => {
    await client.$executeRawUnsafe('ALTER TABLE "LoginBudget" RENAME TO "LoginBudget_unavailable"');
    try {
      await failure(
        await post({ email: 'unknown@example.com', password: 'x' }),
        503,
        'SERVICE_UNAVAILABLE',
      );
    } finally {
      await client.$executeRawUnsafe(
        'ALTER TABLE "LoginBudget_unavailable" RENAME TO "LoginBudget"',
      );
    }
  });
  it('reports unknown commit outcome and never reissues the initially lost token', async () => {
    const account = await registeredLoginAccount(client);
    const input = { email: account.email, password: account.password };
    const original = PostgresSessionRepository.prototype.createAfterLogin;
    let lost = '';
    const spy = vi
      .spyOn(PostgresSessionRepository.prototype, 'createAfterLogin')
      .mockImplementationOnce(async function (this: PostgresSessionRepository, ...args) {
        lost = (await original.apply(this, args)).token;
        secrets.push(lost);
        throw new SessionError('OUTCOME_UNKNOWN');
      });
    try {
      await failure(await post(input), 503, 'OUTCOME_UNKNOWN');
    } finally {
      spy.mockRestore();
    }
    const next = await success(input);
    expect(next.sessionToken === lost).toBe(false);
    expect(await client.session.count({ where: { accountId: account.accountId } })).toBe(2);
  });
  it('executes login through the compiled ESM server, stays silent and closes on SIGTERM', async () => {
    const account = await registeredLoginAccount(client);
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
        REGISTRATION_ENABLED: 'false',
        LOGIN_ENABLED: 'true',
        LOGIN_HMAC_KEY: 'c'.repeat(64),
        REGISTRATION_HMAC_KEY: '',
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
      const origin = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let i = 0; i < 150 && child.exitCode === null; i++) {
        try {
          const response = await fetch(`${origin}/health/live`);
          ready = response.status === 200;
          await response.arrayBuffer();
          if (ready) break;
        } catch {
          /* Await child startup. */
        }
        await delay(20);
      }
      expect(ready).toBe(true);
      const result = await success({ email: account.email, password: account.password }, origin);
      expect(
        (
          await fetch(`${origin}/v1/session`, {
            headers: { Authorization: `Bearer ${result.sessionToken}` },
          })
        ).status,
      ).toBe(200);
      child.kill('SIGTERM');
      await Promise.race([
        exited,
        delay(4000).then(() => {
          throw new Error('compiled login server did not stop');
        }),
      ]);
      expect(output.length).toBe(0);
      await expect(fetch(`${origin}/health/live`)).rejects.toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  }, 15000);
  it('emits no passwords, PHCs or session tokens in application output', async () => {
    const verifiers = await client.passwordCredential.findMany({ select: { verifier: true } });
    const captured = logs.join('');
    expect(
      [...secrets, ...verifiers.map((v) => v.verifier)].every(
        (secret) => !captured.includes(secret),
      ),
    ).toBe(true);
    expect(/s1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/.test(captured)).toBe(false);
  });
  it('closes the shared pool once and leaves none of its backend connections', async () => {
    const isolated = await loginApplication(db.url);
    const owner = isolated.get(Database);
    const disconnect = vi.spyOn(owner.client, '$disconnect');
    // Occupy every pool slot concurrently to identify only this application's backend PIDs.
    const rows = await Promise.all(
      Array.from(
        { length: 8 },
        () =>
          owner.client.$queryRaw<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid, pg_sleep(0.1)::text`,
      ),
    ).finally(() => isolated.close());
    const pids = [...new Set(rows.flatMap((r) => r.map((v) => v.pid)))];
    expect(disconnect).toHaveBeenCalledOnce();
    const remaining = await client.$queryRaw<
      { pid: number }[]
    >`SELECT pid FROM pg_stat_activity WHERE pid = ANY(${pids}::int[])`;
    expect(remaining).toHaveLength(0);
  });
});
