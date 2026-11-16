import { randomUUID } from 'node:crypto';
import process from 'node:process';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { loadLocalEnv } from '../../local-env.mjs';
import { verifyPassword } from '../../src/auth/password-verifier.js';
import { PostgresEmailRegistration } from '../../src/auth/registration/postgres-email-registration.js';
import { PostgresRegistrationLimits } from '../../src/auth/registration/postgres-registration-limits.js';
import type { PasswordBlocklist } from '../../src/auth/registration/registration-policy.js';
import { RegistrationError } from '../../src/auth/registration/registration-policy.js';
import { generateOpaqueToken } from '../../src/auth/sessions/session-token.js';
import { createTestDatabase } from '../support/postgres-test-database.js';
import {
  CapturingRegistrationEmail,
  registrationApplication,
  registrationTestConfig,
} from '../support/registration-fixture.js';

loadLocalEnv();
const path = '/v1/auth/registration';
const password = '  exact HTTP registration e\u0301 😀 password  ';

describe('registration HTTP with real Nest and PostgreSQL 18.7', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let client: PrismaClient;
  let app: NestExpressApplication;
  let base: string;
  let transport: CapturingRegistrationEmail;
  let policyUnavailable = false;
  const blocklist: PasswordBlocklist = {
    async isBlocked(value) {
      if (policyUnavailable) throw new Error(`policy fixture secret ${value}`);
      return value === 'known compromised password';
    },
  };
  const logs: string[] = [];
  const secrets: string[] = [password];
  let output: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;
  beforeAll(async () => {
    const write = process.stdout.write.bind(process.stdout);
    const writeError = process.stderr.write.bind(process.stderr);
    output = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((...args: Parameters<typeof process.stdout.write>) => {
        logs.push(String(args[0]));
        return write(...args);
      });
    errors = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((...args: Parameters<typeof process.stderr.write>) => {
        logs.push(String(args[0]));
        return writeError(...args);
      });
    db = await createTestDatabase();
    client = db.createClient();
    transport = new CapturingRegistrationEmail();
    app = await registrationApplication(db.url, transport, blocklist);
    base = await app.getUrl();
  }, 30000);
  beforeEach(async () => {
    policyUnavailable = false;
    transport.unavailable = false;
    transport.uncertain = false;
    await client.registrationBudget.deleteMany();
  });
  afterAll(async () => {
    try {
      await app?.close();
      await db?.dispose();
    } finally {
      output?.mockRestore();
      errors?.mockRestore();
    }
  });
  async function post(action: string, body: unknown, origin = base) {
    return fetch(`${origin}${path}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  async function intention(email = `${randomUUID()}@EXAMPLE.COM`) {
    const response = await post('request', { email });
    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'accepted' });
    const message = transport.messages.at(-1)!;
    expect(message.to).toBe(email);
    secrets.push(message.token);
    return { email, token: message.token, password };
  }
  async function failure(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: { code } });
  }
  it('accepts a valid request without exposing proof, account, session or cookies', async () => {
    const before = await client.account.count();
    const input = await intention('Alice+HTTP@EXAMPLE.COM');
    const pending = await client.emailRegistration.findUniqueOrThrow({
      where: { id: input.token.split('.')[1]! },
    });
    expect(pending).toMatchObject({
      canonical: 'alice+http@example.com',
      display: input.email,
      accountId: null,
      completedAt: null,
    });
    expect(pending.expiresAt.getTime() - pending.createdAt.getTime()).toBe(1800000);
    expect(await client.account.count()).toBe(before);
  });
  it.each([
    {},
    { email: 'bad' },
    { email: 'é@example.com' },
    { email: 42 },
    [],
    { email: 'a@example.com', accountId: 'chosen' },
    { email: 'a@example.com', emailVerified: true },
  ])('rejects invalid or privileged request body %#', async (body) => {
    const count = transport.messages.length;
    await failure(await post('request', body), 400, 'BAD_REQUEST');
    expect(transport.messages.length).toBe(count);
  });
  it('creates the verified account, original email and Argon2id verifier atomically without device/session/vault', async () => {
    const input = await intention();
    const before = await client.account.count();
    const response = await post('complete', { ...input, email: input.email.toLowerCase() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'account-created' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await client.account.count()).toBe(before + 1);
    const identity = await client.emailIdentity.findUniqueOrThrow({
      where: { canonical: input.email.toLowerCase() },
    });
    expect(identity.display).toBe(input.email);
    const credential = await client.passwordCredential.findUniqueOrThrow({
      where: { accountId: identity.accountId },
    });
    expect(await verifyPassword(password, credential.verifier)).toBe(true);
    for (const count of [
      await client.session.count(),
      await client.device.count(),
      await client.vaultState.count(),
      await client.vaultPublication.count(),
      await client.vaultOperation.count(),
      await client.reauthenticationGrant.count(),
    ])
      expect(count).toBe(0);
    const stored = await client.emailRegistration.findUniqueOrThrow({
      where: { id: input.token.split('.')[1]! },
    });
    expect(stored.accountId).toBe(identity.accountId);
    expect(stored.completedAt).not.toBeNull();
  });
  it('returns identical acknowledgements for existing identity, case variants and pending requests without extra sends', async () => {
    const input = await intention();
    const sent = transport.messages.length;
    const pending = await post('request', { email: input.email.toLowerCase() });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ status: 'accepted' });
    expect((await post('complete', input)).status).toBe(200);
    for (const email of [input.email, input.email.toUpperCase()]) {
      const response = await post('request', { email });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: 'accepted' });
    }
    expect(transport.messages.length).toBe(sent);
  });
  it('suppresses concurrent case variants atomically across two real API instances', async () => {
    const second = await registrationApplication(db.url, transport, blocklist);
    try {
      const email = `${randomUUID()}@Example.com`;
      const sent = transport.messages.length;
      const responses = await Promise.all([
        post('request', { email }),
        post('request', { email: email.toUpperCase() }, await second.getUrl()),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ status: 'accepted' });
      }
      expect(transport.messages.length).toBe(sent + 1);
      expect(
        await client.emailRegistration.count({ where: { canonical: email.toLowerCase() } }),
      ).toBe(1);
    } finally {
      await second.close();
    }
  });
  it('rejects wrong proof, another address and expired proof with the same error', async () => {
    const input = await intention();
    await failure(
      await post('complete', { ...input, token: generateOpaqueToken('e1').token }),
      400,
      'INVALID_VERIFICATION',
    );
    await failure(
      await post('complete', { ...input, email: 'another@example.com' }),
      400,
      'INVALID_VERIFICATION',
    );
    const expired = new PostgresEmailRegistration(
      client,
      transport,
      blocklist,
      () => new Date(Date.now() - 1800001),
    );
    const email = `${randomUUID()}@example.com`;
    await expired.requestVerification(email);
    await failure(
      await post('complete', { email, token: transport.messages.at(-1)!.token, password }),
      400,
      'INVALID_VERIFICATION',
    );
  });
  it('rejects short, oversized UTF-8, invalid Unicode and compromised passwords without consuming proof', async () => {
    const input = await intention();
    for (const value of [
      'too short',
      '😀'.repeat(257),
      '\ud800'.repeat(15),
      'known compromised password',
    ]) {
      await failure(
        await post('complete', { ...input, password: value }),
        422,
        'PASSWORD_REJECTED',
      );
    }
    const row = await client.emailRegistration.findUniqueOrThrow({
      where: { id: input.token.split('.')[1]! },
    });
    expect(row.accountId).toBeNull();
  });
  it('fails closed when compromise checking is unavailable, then allows retry', async () => {
    const input = await intention();
    policyUnavailable = true;
    await failure(await post('complete', input), 503, 'PASSWORD_CHECK_UNAVAILABLE');
    policyUnavailable = false;
    expect((await post('complete', input)).status).toBe(200);
  });
  it('replays a lost response after app restart without rechecking password or mutating its verifier', async () => {
    const input = await intention();
    expect((await post('complete', input)).status).toBe(200);
    const before = await client.passwordCredential.findMany();
    policyUnavailable = true;
    const second = await registrationApplication(db.url, transport, blocklist);
    try {
      const replay = await post('complete', input, await second.getUrl());
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ status: 'account-created' });
      const changed = await post(
        'complete',
        { ...input, password: 'another long password' },
        await second.getUrl(),
      );
      expect(changed.status).toBe(200);
      expect(await client.passwordCredential.findMany()).toEqual(before);
    } finally {
      await second.close();
    }
  });
  it('serializes two concurrent completions and returns the same minimal acknowledgement', async () => {
    const input = await intention();
    const before = await client.account.count();
    const responses = await Promise.all([post('complete', input), post('complete', input)]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'account-created' });
    }
    expect(await client.account.count()).toBe(before + 1);
  });
  it('distinguishes global SMTP unavailability from admission and hides an uncertain submission', async () => {
    transport.unavailable = true;
    // The real adapter sanitizes availability failures; mimic this trusted-port contract.
    const spy = vi
      .spyOn(transport, 'checkAvailability')
      .mockRejectedValue(new RegistrationError('DELIVERY_UNAVAILABLE'));
    try {
      await failure(
        await post('request', { email: 'Alice+HTTP@EXAMPLE.COM' }),
        503,
        'DELIVERY_UNAVAILABLE',
      );
      await failure(
        await post('request', { email: `${randomUUID()}@example.com` }),
        503,
        'DELIVERY_UNAVAILABLE',
      );
    } finally {
      spy.mockRestore();
      transport.unavailable = false;
    }
    transport.uncertain = true;
    const input = await intention();
    transport.uncertain = false;
    expect((await post('complete', input)).status).toBe(200);
  });
  it('limits requests by the actual socket source despite spoofed forwarding headers', async () => {
    const config = registrationTestConfig();
    const limited = await registrationApplication(db.url, transport, blocklist, {
      ...config,
      limits: { ...config.limits, requestsPerSource: 2 },
    });
    try {
      const origin = await limited.getUrl();
      for (let index = 0; index < 3; index++) {
        const response = await fetch(`${origin}${path}/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${index}` },
          body: JSON.stringify({ email: `${randomUUID()}@example.com` }),
        });
        expect(response.status).toBe(index < 2 ? 202 : 429);
        await response.arrayBuffer();
      }
    } finally {
      await limited.close();
    }
  });
  it('limits invalid proof presentations across sources and instances, before Argon2id', async () => {
    const config = registrationTestConfig();
    const limits = new PostgresRegistrationLimits(client, {
      ...config,
      limits: { ...config.limits, attemptsPerProof: 2 },
    });
    const id = randomUUID();
    await limits.source('complete', 'source-a', id);
    await limits.source('complete', 'source-b', id);
    await expect(limits.source('complete', 'source-c', id)).rejects.toThrow('RATE_LIMITED');
  });
  it('sanitizes real PostgreSQL unavailability while keeping liveness and previous routes intact', async () => {
    await client.$executeRawUnsafe(
      'ALTER TABLE "RegistrationBudget" RENAME TO "RegistrationBudget_unavailable"',
    );
    try {
      await failure(
        await post('request', { email: `${randomUUID()}@example.com` }),
        503,
        'SERVICE_UNAVAILABLE',
      );
      expect((await fetch(`${base}/health/live`)).status).toBe(200);
      await failure(await fetch(`${base}/v1/session`), 401, 'UNAUTHORIZED');
    } finally {
      await client.$executeRawUnsafe(
        'ALTER TABLE "RegistrationBudget_unavailable" RENAME TO "RegistrationBudget"',
      );
    }
  });
  it('reports uncertain finalization without leaking driver errors and recovers the committed receipt', async () => {
    const input = await intention();
    const real = PostgresEmailRegistration.prototype.finalize;
    const spy = vi
      .spyOn(PostgresEmailRegistration.prototype, 'finalize')
      .mockImplementationOnce(async function (this: PostgresEmailRegistration, body) {
        await real.call(this, body);
        throw new RegistrationError('OUTCOME_UNKNOWN');
      });
    try {
      await failure(await post('complete', input), 503, 'OUTCOME_UNKNOWN');
    } finally {
      spy.mockRestore();
    }
    const replay = await post('complete', input);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ status: 'account-created' });
  });
  it('protects transport boundaries, methods and routing aliases on both new routes', async () => {
    for (const action of ['request', 'complete']) {
      for (const alias of [
        `${path}/${action}/`,
        `${path.toUpperCase()}/${action}`,
        `${path}/%${action.charCodeAt(0).toString(16)}${action.slice(1)}`,
      ]) {
        expect((await fetch(`${base}${alias}`, { method: 'POST' })).status).toBe(404);
      }
      for (const method of ['GET', 'HEAD', 'OPTIONS', 'DELETE', 'PUT', 'PATCH']) {
        const response = await fetch(`${base}${path}/${action}`, { method });
        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('POST');
        await response.arrayBuffer();
      }
      for (const [body, type, status, code] of [
        ['{', 'application/json', 400, 'BAD_REQUEST'],
        ['null', 'application/json', 400, 'BAD_REQUEST'],
        ['{}', 'text/plain', 415, 'UNSUPPORTED_MEDIA_TYPE'],
        ['x'.repeat(8193), 'application/json', 413, 'PAYLOAD_TOO_LARGE'],
      ] as const)
        await failure(
          await fetch(`${base}${path}/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': type },
            body,
          }),
          status,
          code,
        );
      await failure(
        await fetch(`${base}${path}/${action}?token=secret`, { method: 'POST' }),
        400,
        'BAD_REQUEST',
      );
      const cors = await post(action, {});
      expect(cors.headers.get('access-control-allow-origin')).toBeNull();
    }
    for (const route of [
      '/v1/auth/login',
      '/v1/auth/registration/finalize',
      '/v1/vault',
      '/v1/devices',
      '/v1/accounts',
      '/v1/auth/registration/receipt',
    ])
      expect((await fetch(`${base}${route}`, { method: 'POST' })).status).toBe(404);
  });
  it('rejects extra completion fields before any account mutation', async () => {
    const input = await intention();
    for (const key of ['accountId', 'emailVerified', 'verifier', 'deviceId']) {
      await failure(await post('complete', { ...input, [key]: 'untrusted' }), 400, 'BAD_REQUEST');
    }
    expect(
      (
        await client.emailRegistration.findUniqueOrThrow({
          where: { id: input.token.split('.')[1]! },
        })
      ).completedAt,
    ).toBeNull();
  });
  it('rolls back a real credential insertion failure and permits the same proof to retry', async () => {
    const input = await intention();
    const before = await client.account.count();
    await client.$executeRawUnsafe(
      `CREATE FUNCTION reject_http_credential() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private database detail'; END $$`,
    );
    await client.$executeRawUnsafe(
      `CREATE TRIGGER reject_http_credential BEFORE INSERT ON "PasswordCredential" FOR EACH ROW EXECUTE FUNCTION reject_http_credential()`,
    );
    try {
      await failure(await post('complete', input), 503, 'OUTCOME_UNKNOWN');
      expect(await client.account.count()).toBe(before);
      expect(
        await client.emailIdentity.findUnique({ where: { canonical: input.email.toLowerCase() } }),
      ).toBeNull();
    } finally {
      await client.$executeRawUnsafe('DROP TRIGGER reject_http_credential ON "PasswordCredential"');
      await client.$executeRawUnsafe('DROP FUNCTION reject_http_credential()');
    }
    expect((await post('complete', input)).status).toBe(200);
  });
  it('pads unknown, pending, existing and uncertain-delivery requests to the same configured floor', async () => {
    const config = { ...registrationTestConfig(), requestFloorMs: 200 };
    const padded = await registrationApplication(db.url, transport, blocklist, config);
    try {
      const origin = await padded.getUrl();
      const email = `${randomUUID()}@example.com`;
      const timings: number[] = [];
      const request = async () => {
        const start = performance.now();
        const response = await post('request', { email }, origin);
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ status: 'accepted' });
        timings.push(performance.now() - start);
      };
      await request();
      const token = transport.messages.at(-1)!.token;
      await request();
      expect((await post('complete', { email, token, password }, origin)).status).toBe(200);
      await request();
      transport.uncertain = true;
      const start = performance.now();
      const uncertain = await post('request', { email: `${randomUUID()}@example.com` }, origin);
      expect(uncertain.status).toBe(202);
      await uncertain.arrayBuffer();
      timings.push(performance.now() - start);
      expect(timings.every((value) => value >= 200)).toBe(true);
      // This is a local floor check, not a statistical proof of indistinguishability.
      expect(Math.max(...timings) - Math.min(...timings)).toBeLessThan(350);
    } finally {
      transport.uncertain = false;
      await padded.close();
    }
  });
  it('never writes passwords or verification proofs into application logs', () => {
    const captured = logs.join('');
    expect(secrets.every((secret) => !captured.includes(secret))).toBe(true);
    expect(/e1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/.test(captured)).toBe(false);
  });
});
