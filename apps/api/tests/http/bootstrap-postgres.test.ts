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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { loadLocalEnv } from '../../local-env.mjs';
import { createHttpApplication } from '../../src/application.js';
import { InitialBootstrapError } from '../../src/auth/bootstrap/initial-bootstrap-error.js';
import { PostgresInitialDeviceBootstrap } from '../../src/auth/bootstrap/postgres-initial-device-bootstrap.js';
import * as passwords from '../../src/auth/password-verifier.js';
import { PostgresSessionRepository } from '../../src/auth/sessions/postgres-session-repository.js';
import { Database } from '../../src/shared/database/database.js';
import { readBootstrapConfig } from '../../src/vault/bootstrap-config.js';
import { PostgresBootstrapLimits } from '../../src/vault/postgres-bootstrap-limits.js';
import { publicationDigest } from '../../src/vault/publication-digest.js';
import { bootstrapMaxBodyBytes } from '../../src/vault/vault.module.js';
import {
  bootstrapEnvironment,
  bootstrapTestConfig,
  clientBootstrapInput,
} from '../support/bootstrap-fixture.js';
import { loginTestConfig, registeredLoginAccount } from '../support/login-fixture.js';
import { createTestDatabase } from '../support/postgres-test-database.js';

loadLocalEnv();
const path = '/v1/vault/bootstrap';
type Input = Awaited<ReturnType<typeof clientBootstrapInput>>;
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('bootstrap over real HTTP and PostgreSQL 18.7', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let client: PrismaClient;
  let app: NestExpressApplication;
  let base: string;
  const logs: string[] = [];
  const secrets: string[] = [];
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  async function application(bootstrap = bootstrapTestConfig()) {
    const instance = await createHttpApplication({
      databaseUrl: db.url,
      host: '127.0.0.1',
      port: 0,
      mode: 'test',
      login: loginTestConfig(),
      bootstrap,
    });
    try {
      await instance.listen(0, '127.0.0.1');
      return instance;
    } catch (error) {
      await instance.close();
      throw error;
    }
  }
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
    app = await application();
    base = await app.getUrl();
  }, 30000);
  beforeEach(async () => {
    await client.bootstrapBudget.deleteMany();
    await client.bootstrapLease.deleteMany();
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
  async function post(body: unknown, token?: string, suffix = '', origin = base) {
    return fetch(`${origin}${path}${suffix}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }
  async function login(account: Awaited<ReturnType<typeof registeredLoginAccount>>, origin = base) {
    const response = await fetch(`${origin}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: account.email, password: account.password }),
    });
    expect(response.status).toBe(201);
    const result = (await response.json()) as {
      sessionToken: string;
      session: { sessionId: string; deviceId: string; deviceState: string };
    };
    expect(result.session.deviceState).toBe('pending');
    secrets.push(result.sessionToken);
    return result;
  }
  async function fixture(size = 32) {
    const account = await registeredLoginAccount(client);
    const session = await login(account);
    const body = await clientBootstrapInput(account.accountId, account.password, size);
    secrets.push(body.password, body.request.publicationBase64Url);
    return { account, ...session, body };
  }
  const receipt = (body: Input) => ({
    request: body.request,
    candidateDigest: body.candidateDigest,
  });
  async function result(response: Response, status: number, expected: object) {
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject(expected);
    return body;
  }
  const failure = (response: Response, status: number, code: string) =>
    result(response, status, { error: { code } });
  async function snapshot(accountId: string) {
    return {
      vault: await client.vaultState.findMany({ where: { accountId } }),
      publications: await client.vaultPublication.findMany({ where: { accountId } }),
      operations: await client.vaultOperation.findMany({ where: { accountId } }),
      bindings: await client.initialBootstrapOperation.findMany({ where: { accountId } }),
      devices: await client.device.findMany({ where: { accountId }, orderBy: { id: 'asc' } }),
      // The existing guard advances inactivity; bootstrap preserves every other field.
      sessions: await client.session.findMany({
        where: { accountId },
        orderBy: { id: 'asc' },
        omit: { lastSeenAt: true },
      }),
    };
  }
  it('publishes, authorizes only the original device, preserves sessions and replays exact receipts', async () => {
    const f = await fixture();
    const before = await snapshot(f.account.accountId);
    const committed = await result(await post(f.body, f.sessionToken), 200, {
      status: 'committed',
    });
    const after = await snapshot(f.account.accountId);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.sessions).toHaveLength(1);
    expect(after.devices[0]!.authorizedAt).not.toBeNull();
    expect(after.publications).toHaveLength(1);
    const session = await fetch(`${base}/v1/session`, {
      headers: { Authorization: `Bearer ${f.sessionToken}` },
    });
    await result(session, 200, { deviceState: 'authorized', sessionId: f.session.sessionId });
    expect(await result(await post(f.body, f.sessionToken), 200, { status: 'committed' })).toEqual(
      committed,
    );
    expect(
      await result(await post(receipt(f.body), f.sessionToken, '/receipt'), 200, {
        status: 'committed',
      }),
    ).toEqual(committed);
    expect(await snapshot(f.account.accountId)).toEqual(after);
  });
  it('persists a business rejection without authorization and recovers it without a password or KDF', async () => {
    const f = await fixture();
    f.body.request = { ...f.body.request, expectedCredentialRevision: '2' };
    const rejected = await result(await post(f.body, f.sessionToken), 200, {
      status: 'rejected',
      code: 'VERSION_CONFLICT',
    });
    const before = await snapshot(f.account.accountId);
    expect(before.devices[0]!.authorizedAt).toBeNull();
    const spy = vi.spyOn(passwords, 'verifyPassword');
    try {
      expect(
        await result(await post(receipt(f.body), f.sessionToken, '/receipt'), 200, {
          status: 'rejected',
        }),
      ).toEqual(rejected);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(await snapshot(f.account.accountId)).toEqual(before);
  });
  it('returns unknown with 202 and never creates an absent receipt', async () => {
    const f = await fixture();
    const before = await snapshot(f.account.accountId);
    await result(await post(receipt(f.body), f.sessionToken, '/receipt'), 202, {
      transportVersion: 1,
      status: 'unknown',
    });
    expect(await snapshot(f.account.accountId)).toEqual(before);
  });
  it('rejects incorrect passwords and mismatched session accounts without mutation', async () => {
    const f = await fixture();
    const before = await snapshot(f.account.accountId);
    await failure(
      await post({ ...f.body, password: 'wrong' }, f.sessionToken),
      401,
      'UNAUTHORIZED',
    );
    const other = await fixture();
    for (const suffix of ['', '/receipt'])
      await failure(
        await post(suffix ? receipt(f.body) : f.body, other.sessionToken, suffix),
        401,
        'UNAUTHORIZED',
      );
    expect(await snapshot(f.account.accountId)).toEqual(before);
  });
  it.each(['expired', 'session-revoked', 'device-revoked'] as const)(
    'rejects %s on both routes',
    async (kind) => {
      const f = await fixture();
      if (kind === 'expired')
        await client.session.update({
          where: { id: f.session.sessionId },
          data: {
            createdAt: new Date(Date.now() - 2000),
            lastSeenAt: new Date(Date.now() - 2000),
            expiresAt: new Date(Date.now() - 1000),
          },
        });
      if (kind === 'session-revoked')
        await client.session.update({
          where: { id: f.session.sessionId },
          data: { revokedAt: new Date() },
        });
      if (kind === 'device-revoked')
        await client.device.update({
          where: { id: f.session.deviceId },
          data: { revokedAt: new Date() },
        });
      const before = await snapshot(f.account.accountId);
      for (const suffix of ['', '/receipt'])
        await failure(
          await post(suffix ? receipt(f.body) : f.body, f.sessionToken, suffix),
          401,
          'UNAUTHORIZED',
        );
      expect(await snapshot(f.account.accountId)).toEqual(before);
    },
  );
  it('forbids appropriation by another logged-in pending device and any second bootstrap after total revocation', async () => {
    const f = await fixture();
    await result(await post(f.body, f.sessionToken), 200, { status: 'committed' });
    const other = await login(f.account);
    await failure(await post(receipt(f.body), other.sessionToken, '/receipt'), 403, 'FORBIDDEN');
    const next = { ...f.body, request: { ...f.body.request, operationId: randomUUID() } };
    await failure(await post(next, other.sessionToken), 403, 'FORBIDDEN');
    await new PostgresSessionRepository(client).revokeDevicesAfterAuthorization(
      f.account.accountId,
      [f.session.deviceId, other.session.deviceId],
    );
    const fresh = await login(f.account);
    await failure(await post(next, fresh.sessionToken), 403, 'FORBIDDEN');
    expect(await client.vaultPublication.count({ where: { accountId: f.account.accountId } })).toBe(
      1,
    );
  });
  it('fails closed on ambiguous authorized-device history', async () => {
    const f = await fixture();
    await client.device.update({
      where: { id: f.session.deviceId },
      data: { authorizedAt: new Date() },
    });
    const before = await snapshot(f.account.accountId);
    await failure(await post(f.body, f.sessionToken), 403, 'FORBIDDEN');
    expect(await snapshot(f.account.accountId)).toEqual(before);
  });
  it('returns the unchanged repository idempotency mismatch without changing the original receipt', async () => {
    const f = await fixture();
    await result(await post(f.body, f.sessionToken), 200, { status: 'committed' });
    const before = await snapshot(f.account.accountId);
    const changed = { ...f.body, request: { ...f.body.request, expectedCredentialRevision: '2' } };
    for (const suffix of ['', '/receipt'])
      await result(await post(suffix ? receipt(changed) : changed, f.sessionToken, suffix), 200, {
        status: 'rejected',
        code: 'IDEMPOTENCY_MISMATCH',
      });
    expect(await snapshot(f.account.accountId)).toEqual(before);
  });
  it('replays after receipt key rotation and fails closed if a historical key is unavailable', async () => {
    const f = await fixture();
    await result(await post(f.body, f.sessionToken), 200, { status: 'committed' });
    const before = await snapshot(f.account.accountId);
    for (const keepHistorical of [true, false]) {
      const config = readBootstrapConfig({
        ...bootstrapEnvironment,
        VAULT_RECEIPT_ACTIVE_KEY_ID: 'rotated',
        VAULT_RECEIPT_KEYS: JSON.stringify([
          { id: 'rotated', key: 'f'.repeat(64) },
          ...(keepHistorical ? [{ id: 'http-test', key: 'e'.repeat(64) }] : []),
        ]),
      })!;
      const rotated = await application(config);
      try {
        const response = await post(
          receipt(f.body),
          f.sessionToken,
          '/receipt',
          await rotated.getUrl(),
        );
        if (keepHistorical) await result(response, 200, { status: 'committed' });
        else await failure(response, 503, 'SERVICE_UNAVAILABLE');
      } finally {
        await rotated.close();
      }
    }
    expect(await snapshot(f.account.accountId)).toEqual(before);
  });
  it('requires an actually verified email even with a valid authenticated session', async () => {
    const f = await fixture();
    await client.emailIdentity.delete({ where: { accountId: f.account.accountId } });
    const before = await snapshot(f.account.accountId);
    for (const suffix of ['', '/receipt'])
      await failure(
        await post(suffix ? receipt(f.body) : f.body, f.sessionToken, suffix),
        401,
        'UNAUTHORIZED',
      );
    expect(await snapshot(f.account.accountId)).toEqual(before);
  });
  it('serializes two valid initial candidates on separate live instances and authorizes one device', async () => {
    const f = await fixture();
    const other = await login(f.account);
    const second = await application();
    const next = await clientBootstrapInput(f.account.accountId, f.account.password);
    const ready = gate();
    const release = gate();
    let verified = 0;
    const original = passwords.verifyPassword;
    const spy = vi.spyOn(passwords, 'verifyPassword').mockImplementation(async (...args) => {
      const valid = await original(...args);
      if (++verified === 2) ready.resolve();
      await release.promise;
      return valid;
    });
    const pending = Promise.all([
      post(f.body, f.sessionToken),
      post(next, other.sessionToken, '', await second.getUrl()),
    ]);
    try {
      await ready.promise;
      release.resolve();
      const responses = await pending;
      expect(responses.map((r) => r.status).sort()).toEqual([200, 403]);
      await Promise.all(responses.map((r) => r.arrayBuffer()));
      expect(
        await client.device.count({
          where: { accountId: f.account.accountId, authorizedAt: { not: null } },
        }),
      ).toBe(1);
      expect(
        await client.vaultPublication.count({ where: { accountId: f.account.accountId } }),
      ).toBe(1);
    } finally {
      release.resolve();
      spy.mockRestore();
      await second.close();
    }
  }, 15000);
  it('rolls back a real pre-commit fault and recovers a genuinely committed lost response', async () => {
    const f = await fixture();
    const before = await snapshot(f.account.accountId);
    const owner = app.get(Database).client;
    const transaction = owner.$transaction.bind(owner);
    const spy = vi.spyOn(owner, '$transaction').mockImplementation(async (work, options) => {
      if (typeof work !== 'function') throw new Error('Unexpected batch transaction');
      return transaction(async (tx) => {
        const value = await work(tx);
        if (await tx.initialBootstrapOperation.count({ where: { accountId: f.account.accountId } }))
          throw new Error('Injected pre-commit failure');
        return value;
      }, options);
    });
    try {
      await failure(await post(f.body, f.sessionToken), 503, 'OUTCOME_UNKNOWN');
    } finally {
      spy.mockRestore();
    }
    expect(await snapshot(f.account.accountId)).toEqual(before);
    const original = PostgresInitialDeviceBootstrap.prototype.activate;
    const lost = vi
      .spyOn(PostgresInitialDeviceBootstrap.prototype, 'activate')
      .mockImplementationOnce(async function (this: PostgresInitialDeviceBootstrap, ...args) {
        await original.apply(this, args);
        throw new InitialBootstrapError('OUTCOME_UNKNOWN');
      });
    try {
      await failure(await post(f.body, f.sessionToken), 503, 'OUTCOME_UNKNOWN');
    } finally {
      lost.mockRestore();
    }
    await result(await post(receipt(f.body), f.sessionToken, '/receipt'), 200, {
      status: 'committed',
    });
    expect(await client.vaultPublication.count({ where: { accountId: f.account.accountId } })).toBe(
      1,
    );
  });
  it('revalidates a password revision changed while the real Argon2id verification is suspended', async () => {
    const f = await fixture();
    const entered = gate();
    const release = gate();
    const original = passwords.verifyPassword;
    const spy = vi.spyOn(passwords, 'verifyPassword').mockImplementationOnce(async (...args) => {
      const valid = await original(...args);
      entered.resolve();
      await release.promise;
      return valid;
    });
    const response = post(f.body, f.sessionToken);
    try {
      await entered.promise;
      await db.createClient().$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${f.account.accountId} FOR UPDATE`;
        await tx.passwordCredential.update({
          where: { accountId: f.account.accountId },
          data: { revision: 2 },
        });
      });
      release.resolve();
      await failure(await response, 401, 'UNAUTHORIZED');
      expect(await client.vaultOperation.count({ where: { accountId: f.account.accountId } })).toBe(
        0,
      );
    } finally {
      release.resolve();
      spy.mockRestore();
    }
  });
  it('revalidates revocation committed while activation waits for the account lock', async () => {
    const f = await fixture();
    const locked = gate();
    const release = gate();
    const entered = gate();
    const original = passwords.verifyPassword;
    // Start the lock only after the guard and 4.4B's initial read, inside the KDF barrier.
    let lock!: Promise<unknown>;
    const barrier = vi
      .spyOn(passwords, 'verifyPassword')
      .mockImplementationOnce(async (...args) => {
        const valid = await original(...args);
        lock = db.createClient().$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${f.account.accountId} FOR UPDATE`;
            locked.resolve();
            await release.promise;
            await tx.session.update({
              where: { id: f.session.sessionId },
              data: { revokedAt: new Date() },
            });
          },
          { timeout: 5000 },
        );
        await locked.promise;
        entered.resolve();
        return valid;
      });
    const response = post(f.body, f.sessionToken);
    try {
      await entered.promise;
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const rows = await db.admin.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = 'bunny-talks-http' AND wait_event_type = 'Lock') AS waiting`;
        if (rows[0]!.waiting) {
          waiting = true;
          break;
        }
        await delay(5);
      }
      expect(waiting).toBe(true);
      release.resolve();
      await lock;
      await failure(await response, 401, 'UNAUTHORIZED');
      expect(await client.vaultOperation.count({ where: { accountId: f.account.accountId } })).toBe(
        0,
      );
    } finally {
      release.resolve();
      barrier.mockRestore();
      if (lock) await lock;
    }
  });
  it('accepts a real client vault with the maximum 65536-byte plaintext and preserves exact ciphertext', async () => {
    const f = await fixture(65536);
    expect(Buffer.byteLength(JSON.stringify(f.body))).toBeGreaterThan(8192);
    await result(await post(f.body, f.sessionToken), 200, { status: 'committed' });
    const stored = await client.vaultPublication.findFirstOrThrow({
      where: { accountId: f.account.accountId },
    });
    expect(
      Buffer.from(stored.bytes).equals(
        Buffer.from(f.body.request.publicationBase64Url, 'base64url'),
      ),
    ).toBe(true);
  });
  it('accepts the exact transport boundary but refuses invalid V1 before Argon2id, and rejects oversized input', async () => {
    const f = await fixture();
    const spy = vi.spyOn(passwords, 'verifyPassword');
    try {
      const invalid = {
        ...f.body,
        request: {
          ...f.body.request,
          publicationBase64Url: Buffer.alloc(131072).toString('base64url'),
        },
        candidateDigest: publicationDigest(Buffer.alloc(131072)),
      };
      await failure(await post(invalid, f.sessionToken), 400, 'BAD_REQUEST');
      invalid.request.publicationBase64Url = Buffer.alloc(131073).toString('base64url');
      await failure(await post(invalid, f.sessionToken), 400, 'BAD_REQUEST');
      for (const suffix of ['', '/receipt']) {
        const json = JSON.stringify(suffix ? receipt(f.body) : f.body);
        for (const extra of [0, 1]) {
          const response = await fetch(`${base}${path}${suffix}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${f.sessionToken}`,
            },
            body: json + ' '.repeat(bootstrapMaxBodyBytes - Buffer.byteLength(json) + extra),
          });
          if (extra) await failure(response, 413, 'PAYLOAD_TOO_LARGE');
          else await result(response, 200, { status: 'committed' });
        }
      }
      // Only the single structurally valid activation above invokes Argon2id.
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
  it('enforces exact paths, methods, no queries, strict bodies, credentials and encodings', async () => {
    const f = await fixture();
    for (const suffix of ['', '/receipt']) {
      const body = suffix ? receipt(f.body) : f.body;
      await failure(await post(body, undefined, suffix), 401, 'UNAUTHORIZED');
      await failure(await post(body, 's1.bad.bad', suffix), 401, 'UNAUTHORIZED');
      await failure(
        await post({ ...body, deviceId: f.session.deviceId }, f.sessionToken, suffix),
        400,
        'BAD_REQUEST',
      );
      await failure(await post(body, f.sessionToken, `${suffix}?ignored=1`), 400, 'BAD_REQUEST');
      for (const alias of [`${suffix}/`, `${suffix}`.replace('receipt', 'Receipt')]) {
        if (alias === suffix) continue;
        await failure(await post(body, f.sessionToken, alias), 404, 'NOT_FOUND');
      }
      const method = await fetch(`${base}${path}${suffix}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${f.sessionToken}` },
      });
      await failure(method, 405, 'METHOD_NOT_ALLOWED');
      expect(method.headers.get('allow')).toBe('POST');
      await failure(
        await fetch(`${base}${path}${suffix}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            Authorization: `Bearer ${f.sessionToken}`,
          },
          body: JSON.stringify(body),
        }),
        415,
        'UNSUPPORTED_MEDIA_TYPE',
      );
    }
    for (const alias of [
      '/V1/vault/bootstrap',
      '/v1/Vault/bootstrap',
      '/v1/vault/Bootstrap',
      '/v1/vault/bootstrap%2Freceipt',
    ]) {
      await failure(
        await fetch(`${base}${alias}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${f.sessionToken}`,
          },
          body: JSON.stringify(f.body),
        }),
        404,
        'NOT_FOUND',
      );
    }
  });
  it('bounds streamed JSON with no declared Content-Length before any bootstrap call', async () => {
    const f = await fixture();
    const activate = vi.spyOn(PostgresInitialDeviceBootstrap.prototype, 'activate');
    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(
          `${base}${path}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${f.sessionToken}`,
            },
          },
          (incoming) => {
            let body = '';
            incoming.setEncoding('utf8');
            incoming.on('data', (chunk: string) => {
              body += chunk;
            });
            incoming.on('end', () => resolve({ status: incoming.statusCode!, body }));
            incoming.on('error', reject);
          },
        );
        request.on('error', reject);
        request.write('{"padding":"');
        request.write('x'.repeat(bootstrapMaxBodyBytes));
        request.end('"}');
      });
      expect(response.status).toBe(413);
      expect(JSON.parse(response.body)).toEqual({ error: { code: 'PAYLOAD_TOO_LARGE' } });
      expect(activate).not.toHaveBeenCalled();
    } finally {
      activate.mockRestore();
    }
  });
  it.each([
    'requestsPerAccount',
    'requestsPerDevice',
    'requestsPerSource',
    'requestsGlobally',
    'hashesPerWindow',
  ] as const)('shares %s admission across instances', async (scope) => {
    const config = { ...bootstrapTestConfig(), [scope]: 1 };
    const first = await application(config);
    const second = await application(config);
    try {
      const f = await fixture();
      const body = { ...f.body, password: 'wrong' };
      await failure(
        await post(body, f.sessionToken, '', await first.getUrl()),
        401,
        'UNAUTHORIZED',
      );
      await failure(
        await post(body, f.sessionToken, '', await second.getUrl()),
        429,
        'TOO_MANY_REQUESTS',
      );
    } finally {
      await first.close();
      await second.close();
    }
  });
  it('bounds receipt admission and shared concurrency without losing existing receipts', async () => {
    const f = await fixture();
    await result(await post(f.body, f.sessionToken), 200, { status: 'committed' });
    await client.bootstrapBudget.deleteMany();
    const constrained = await application({
      ...bootstrapTestConfig(),
      requestsPerAccount: 1,
      concurrency: 1,
    });
    try {
      const limits = new PostgresBootstrapLimits(client, {
        ...bootstrapTestConfig(),
        concurrency: 1,
      });
      const lease = await limits.acquire();
      try {
        await failure(
          await post(receipt(f.body), f.sessionToken, '/receipt', await constrained.getUrl()),
          503,
          'SERVICE_UNAVAILABLE',
        );
      } finally {
        await lease.release();
      }
      await failure(
        await post(receipt(f.body), f.sessionToken, '/receipt', await constrained.getUrl()),
        429,
        'TOO_MANY_REQUESTS',
      );
      await client.bootstrapBudget.deleteMany();
      await result(
        await post(receipt(f.body), f.sessionToken, '/receipt', await constrained.getUrl()),
        200,
        { status: 'committed' },
      );
    } finally {
      await constrained.close();
    }
  });
  it('sanitizes cryptographic and PostgreSQL failures and keeps bootstrap disabled by default', async () => {
    const f = await fixture();
    const spy = vi
      .spyOn(passwords, 'verifyPassword')
      .mockRejectedValueOnce(new passwords.PasswordVerifierError('CRYPTO_UNAVAILABLE'));
    try {
      await failure(await post(f.body, f.sessionToken), 503, 'SERVICE_UNAVAILABLE');
    } finally {
      spy.mockRestore();
    }
    await client.$executeRawUnsafe(
      'ALTER TABLE "BootstrapBudget" RENAME TO "BootstrapBudget_unavailable"',
    );
    try {
      await failure(await post(f.body, f.sessionToken), 503, 'SERVICE_UNAVAILABLE');
    } finally {
      await client.$executeRawUnsafe(
        'ALTER TABLE "BootstrapBudget_unavailable" RENAME TO "BootstrapBudget"',
      );
    }
    const disabled = await createHttpApplication({
      databaseUrl: db.url,
      mode: 'test',
      host: '127.0.0.1',
      port: 0,
    });
    try {
      await disabled.listen(0, '127.0.0.1');
      await failure(
        await post(f.body, f.sessionToken, '', await disabled.getUrl()),
        503,
        'SERVICE_UNAVAILABLE',
      );
    } finally {
      await disabled.close();
    }
  });
  it('executes bootstrap and recovery in the compiled ESM server and shuts its pool down cleanly', async () => {
    const f = await fixture();
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
        ...bootstrapEnvironment,
        DATABASE_URL: db.url,
        NODE_ENV: 'test',
        API_PORT: String(port),
        API_HOST: '127.0.0.1',
        LOGIN_ENABLED: 'false',
        REGISTRATION_ENABLED: 'false',
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
    const origin = `http://127.0.0.1:${port}`;
    try {
      let ready = false;
      for (let i = 0; i < 150 && child.exitCode === null; i++) {
        try {
          const r = await fetch(`${origin}/health/live`);
          ready = r.status === 200;
          await r.arrayBuffer();
          if (ready) break;
        } catch {
          /* Wait for startup. */
        }
        await delay(20);
      }
      expect(ready).toBe(true);
      await result(await post(f.body, f.sessionToken, '', origin), 200, { status: 'committed' });
      await result(await post(receipt(f.body), f.sessionToken, '/receipt', origin), 200, {
        status: 'committed',
      });
      child.kill('SIGTERM');
      await Promise.race([
        exited,
        delay(4000).then(() => {
          throw new Error('ESM bootstrap server did not stop');
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
  it('emits no password, bearer, ciphertext, PHC or HMAC keys in application output', async () => {
    const verifiers = await client.passwordCredential.findMany({ select: { verifier: true } });
    const captured = logs.join('');
    expect(
      [...secrets, ...verifiers.map((v) => v.verifier), 'd'.repeat(64), 'e'.repeat(64)].every(
        (secret) => !captured.includes(secret),
      ),
    ).toBe(true);
  });
  it('disconnects its sole pool exactly once with no remaining backend connections', async () => {
    const isolated = await application();
    const owner = isolated.get(Database);
    const disconnect = vi.spyOn(owner.client, '$disconnect');
    const rows = await Promise.all(
      Array.from(
        { length: 8 },
        () =>
          owner.client.$queryRaw<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid, pg_sleep(0.1)::text`,
      ),
    ).finally(() => isolated.close());
    expect(disconnect).toHaveBeenCalledOnce();
    const pids = [...new Set(rows.flatMap((r) => r.map((v) => v.pid)))];
    expect(
      await client.$queryRaw`SELECT pid FROM pg_stat_activity WHERE pid = ANY(${pids}::int[])`,
    ).toHaveLength(0);
    expect(await client.bootstrapLease.count()).toBe(0);
  });
});
