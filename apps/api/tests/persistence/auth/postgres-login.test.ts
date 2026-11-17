import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { loadLocalEnv } from '../../../local-env.mjs';
import { LoginService } from '../../../src/auth/login/login.service.js';
import { PostgresLoginCredentials } from '../../../src/auth/login/postgres-login-credentials.js';
import { PostgresLoginLimits } from '../../../src/auth/login/postgres-login-limits.js';
import { createPasswordVerifier } from '../../../src/auth/password-verifier.js';
import { PostgresSessionRepository } from '../../../src/auth/sessions/postgres-session-repository.js';
import { parseSessionToken, SessionError } from '../../../src/auth/sessions/session-token.js';
import { requireVerifiedLogin, VerifiedLogin } from '../../../src/auth/verified-login.js';
import { loginTestConfig, registeredLoginAccount } from '../../support/login-fixture.js';
import { createTestDatabase } from '../../support/postgres-test-database.js';

loadLocalEnv();
describe('atomic login and distributed admission on PostgreSQL 18.7', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let client: PrismaClient;
  let other: PrismaClient;
  const config = loginTestConfig();
  beforeAll(async () => {
    db = await createTestDatabase();
    client = db.createClient();
    other = db.createClient();
  }, 30000);
  beforeEach(async () => {
    await client.loginBudget.deleteMany();
    await client.loginLease.deleteMany();
  });
  afterAll(async () => {
    await db?.dispose();
  });
  function service(connection = client, configured = config) {
    return new LoginService({
      config: configured,
      credentials: new PostgresLoginCredentials(connection),
      limits: new PostgresLoginLimits(connection, configured),
      sessions: new PostgresSessionRepository(connection),
    });
  }
  async function prepared() {
    const account = await registeredLoginAccount(client);
    const before = await new PostgresLoginCredentials(client).find(account.email.toLowerCase());
    const verified = await VerifiedLogin.verify(account.password, before);
    expect(verified).toBeDefined();
    const lease = await new PostgresLoginLimits(client, config).acquire();
    return { ...account, verified: verified!, lease };
  }
  it.each([
    'structural',
    'created-prototype',
    'direct-constructor',
    'replaced-prototype',
    'inherited-proof',
    'proxy',
  ])('rejects a %s proof without querying or inserting devices/sessions', async (kind) => {
    const a = await prepared();
    const credential = a.verified.credential;
    const forged = (
      kind === 'structural'
        ? { credential }
        : kind === 'created-prototype'
          ? Object.create(VerifiedLogin.prototype, { credential: { value: credential } })
          : kind === 'direct-constructor'
            ? Reflect.construct(VerifiedLogin, [credential])
            : kind === 'replaced-prototype'
              ? Object.setPrototypeOf({ credential }, VerifiedLogin.prototype)
              : kind === 'inherited-proof'
                ? Object.create(a.verified)
                : new Proxy(a.verified, {})
    ) as VerifiedLogin;
    const before = [await client.device.count(), await client.session.count()];
    const transaction = vi.spyOn(client, '$transaction');
    try {
      await expect(
        new PostgresSessionRepository(client).createAfterLogin(forged, a.lease.id, 1000),
      ).rejects.toThrow('INVALID_CREDENTIALS');
      expect(transaction).not.toHaveBeenCalled();
      expect([await client.device.count(), await client.session.count()]).toEqual(before);
    } finally {
      transaction.mockRestore();
      await a.lease.release();
    }
  });
  it('binds an authentic proof to its original account despite a replaced input or forged getter', async () => {
    const a = await registeredLoginAccount(client);
    const b = await registeredLoginAccount(client);
    const input = (await new PostgresLoginCredentials(client).find(a.email.toLowerCase()))!;
    const proof = (await VerifiedLogin.verify(a.password, input))!;
    const otherCredential = (await new PostgresLoginCredentials(client).find(
      b.email.toLowerCase(),
    ))!;
    Object.assign(input, otherCredential);
    expect(requireVerifiedLogin(proof).accountId).toBe(a.accountId);
    expect(Reflect.defineProperty(proof, 'credential', { value: otherCredential })).toBe(false);
    const forged = Object.create(proof, {
      credential: { value: otherCredential },
    }) as VerifiedLogin;
    const lease = await new PostgresLoginLimits(client, config).acquire();
    try {
      const repository = new PostgresSessionRepository(client);
      await expect(repository.createAfterLogin(forged, lease.id, 1000)).rejects.toThrow(
        'INVALID_CREDENTIALS',
      );
      expect(await client.device.count({ where: { accountId: b.accountId } })).toBe(0);
      expect(await client.session.count({ where: { accountId: b.accountId } })).toBe(0);
      const real = await repository.createAfterLogin(proof, lease.id, 1000);
      expect(real.session.accountId).toBe(a.accountId);
      expect(real.session.deviceState).toBe('pending');
      expect(await client.device.count({ where: { accountId: b.accountId } })).toBe(0);
      expect(await client.session.count({ where: { accountId: b.accountId } })).toBe(0);
    } finally {
      await lease.release();
    }
  });
  it('persists only the token hash, creates pending state and leaves identity/vault unchanged', async () => {
    const a = await registeredLoginAccount(client);
    const identity = await client.emailIdentity.findUniqueOrThrow({
      where: { accountId: a.accountId },
    });
    const result = await service().login(
      { email: a.email.toUpperCase(), password: a.password },
      'source',
    );
    const row = await client.session.findUniqueOrThrow({
      where: { id: result.session.sessionId },
      include: { device: true },
    });
    const parsed = parseSessionToken(result.sessionToken);
    try {
      expect(row.tokenHash).toEqual(Uint8Array.from(parsed.hash));
    } finally {
      parsed.hash.fill(0);
    }
    expect(row.device.authorizedAt).toBeNull();
    expect(row.device.revokedAt).toBeNull();
    expect(await client.emailIdentity.findUnique({ where: { accountId: a.accountId } })).toEqual(
      identity,
    );
    expect(await client.vaultState.count()).toBe(0);
    expect(await client.vaultPublication.count()).toBe(0);
    expect(await client.loginLease.count()).toBe(0);
  });
  it.each(['verifier', 'revision', 'identity', 'verifiedAt', 'timestamp'] as const)(
    'rejects a changed %s after real password verification',
    async (kind) => {
      const a = await prepared();
      const replacement =
        kind === 'verifier' || kind === 'timestamp'
          ? await createPasswordVerifier('replacement password')
          : '';
      await other.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${a.accountId} FOR UPDATE`;
        if (kind === 'identity')
          await tx.emailIdentity.update({
            where: { accountId: a.accountId },
            data: { canonical: `changed-${a.email.toLowerCase()}`, display: `changed-${a.email}` },
          });
        else if (kind === 'verifiedAt')
          await tx.emailIdentity.update({
            where: { accountId: a.accountId },
            data: { verifiedAt: new Date(1) },
          });
        else if (kind === 'revision')
          await tx.passwordCredential.update({
            where: { accountId: a.accountId },
            data: { revision: { increment: 1 } },
          });
        else {
          await tx.passwordCredential.update({
            where: { accountId: a.accountId },
            data: { verifier: replacement },
          });
          if (kind === 'timestamp')
            await tx.passwordCredential.update({
              where: { accountId: a.accountId },
              data: { verifier: a.verified.credential.verifier },
            });
        }
      });
      await expect(
        new PostgresSessionRepository(client).createAfterLogin(a.verified, a.lease.id, 1000),
      ).rejects.toThrow('INVALID_CREDENTIALS');
      expect(await client.session.count({ where: { accountId: a.accountId } })).toBe(0);
      expect(await client.device.count({ where: { accountId: a.accountId } })).toBe(0);
      await a.lease.release();
    },
  );
  it('does not hold an account lock during Argon2id, and rejects a credential changed during verification', async () => {
    const a = await registeredLoginAccount(client);
    const original = VerifiedLogin.verify;
    const replacement = await createPasswordVerifier('new account password');
    const spy = vi
      .spyOn(VerifiedLogin, 'verify')
      .mockImplementationOnce(async (password, credential) => {
        const verification = original.call(VerifiedLogin, password, credential);
        await other.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('lock_timeout', '100ms', true)`;
          await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${a.accountId} FOR UPDATE`;
          await tx.passwordCredential.update({
            where: { accountId: a.accountId },
            data: { verifier: replacement, revision: { increment: 1 } },
          });
        });
        return verification;
      });
    try {
      await expect(service().login(a, 'source')).rejects.toThrow('INVALID_CREDENTIALS');
    } finally {
      spy.mockRestore();
    }
    expect(await client.session.count({ where: { accountId: a.accountId } })).toBe(0);
  });
  it('serializes concurrent valid logins from independent clients into distinct pending devices', async () => {
    const a = await registeredLoginAccount(client);
    const results = await Promise.all([service().login(a, 'a'), service(other).login(a, 'b')]);
    expect(new Set(results.map((r) => r.session.deviceId)).size).toBe(2);
    expect(new Set(results.map((r) => r.sessionToken)).size).toBe(2);
    expect(
      await client.device.count({ where: { accountId: a.accountId, authorizedAt: null } }),
    ).toBe(2);
  });
  it('serializes login with revocation without reviving a revoked historical device', async () => {
    const a = await registeredLoginAccount(client);
    const first = await service().login(a, 'a');
    const [second] = await Promise.all([
      service().login(a, 'b'),
      new PostgresSessionRepository(other).revokeDevicesAfterAuthorization(a.accountId, [
        first.session.deviceId,
      ]),
    ]);
    expect(second.session.deviceId).not.toBe(first.session.deviceId);
    const old = await client.device.findUniqueOrThrow({ where: { id: first.session.deviceId } });
    expect(old.revokedAt).not.toBeNull();
    await expect(new PostgresSessionRepository(other).validate(first.sessionToken)).rejects.toThrow(
      'INVALID_SESSION',
    );
    expect(
      (await new PostgresSessionRepository(client).validate(second.sessionToken)).deviceState,
    ).toBe('pending');
  });
  it('enforces retained session/device bounds under concurrent login, preserving expired and revoked audit rows', async () => {
    const a = await registeredLoginAccount(client);
    const first = await service().login(a, 'a');
    await client.session.update({
      where: { id: first.session.sessionId },
      data: { revokedAt: new Date(), expiresAt: new Date(Date.now() + 1) },
    });
    const configured = { ...config, maximumRecordsPerAccount: 2 };
    const results = await Promise.allSettled([
      service(client, configured).login(a, 'b'),
      service(other, configured).login(a, 'c'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await client.session.count({ where: { accountId: a.accountId } })).toBe(2);
    expect(await client.device.count({ where: { accountId: a.accountId } })).toBe(2);
    expect(
      await client.session.findUnique({ where: { id: first.session.sessionId } }),
    ).not.toBeNull();
  });
  it('rolls back the new device if session insertion fails before commit', async () => {
    const a = await registeredLoginAccount(client);
    await client.$executeRawUnsafe(
      `CREATE FUNCTION reject_login_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private insertion failure'; END $$`,
    );
    await client.$executeRawUnsafe(
      `CREATE TRIGGER reject_login_session BEFORE INSERT ON "Session" FOR EACH ROW EXECUTE FUNCTION reject_login_session()`,
    );
    try {
      await expect(service().login(a, 'source')).rejects.toThrow('OUTCOME_UNKNOWN');
      expect(await client.device.count({ where: { accountId: a.accountId } })).toBe(0);
      expect(await client.session.count({ where: { accountId: a.accountId } })).toBe(0);
    } finally {
      await client.$executeRawUnsafe('DROP TRIGGER reject_login_session ON "Session"');
      await client.$executeRawUnsafe('DROP FUNCTION reject_login_session()');
    }
    expect((await service().login(a, 'source')).session.deviceState).toBe('pending');
  });
  it('never reconstructs a token after a commit with an unknown outcome; retry creates another bounded session', async () => {
    const a = await registeredLoginAccount(client);
    const original = PostgresSessionRepository.prototype.createAfterLogin;
    let lostToken = '';
    const spy = vi
      .spyOn(PostgresSessionRepository.prototype, 'createAfterLogin')
      .mockImplementationOnce(async function (this: PostgresSessionRepository, ...args) {
        lostToken = (await original.apply(this, args)).token;
        throw new SessionError('OUTCOME_UNKNOWN');
      });
    try {
      await expect(service().login(a, 'a')).rejects.toThrow('OUTCOME_UNKNOWN');
    } finally {
      spy.mockRestore();
    }
    const next = await service(other).login(a, 'b');
    expect(next.sessionToken === lostToken).toBe(false);
    expect(await client.session.count({ where: { accountId: a.accountId } })).toBe(2);
  });
  it.each([
    'requestsPerSource',
    'requestsPerEmail',
    'requestsGlobally',
    'hashesPerWindow',
  ] as const)('shares the exact %s boundary across connections', async (setting) => {
    const configured = { ...config, [setting]: 2 };
    const a = new PostgresLoginLimits(client, configured);
    const b = new PostgresLoginLimits(other, configured);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        (i % 2 ? a : b).admit(
          setting === 'requestsPerSource' ? 'same' : `source-${i}`,
          setting === 'requestsPerEmail' ? 'unknown@example.com' : `${i}@example.com`,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(
      results
        .filter((r) => r.status === 'rejected')
        .every((r) => String(r.reason).includes('RATE_LIMITED')),
    ).toBe(true);
  });
  it('does not store clear email/source and recovers expired windows without permanent lockout', async () => {
    const limits = new PostgresLoginLimits(client, { ...config, requestsPerEmail: 1 });
    await limits.admit('192.0.2.1', 'unknown@example.com');
    await expect(limits.admit('another', 'unknown@example.com')).rejects.toThrow('RATE_LIMITED');
    const rows = await client.loginBudget.findMany();
    expect(rows.every((r) => /^[a-f0-9]{64}$/.test(r.key))).toBe(true);
    const stored = JSON.stringify(rows);
    expect(stored.includes('unknown@example.com') || stored.includes('192.0.2.1')).toBe(false);
    await client.loginBudget.updateMany({
      data: { startedAt: new Date(Date.now() - 300000), expiresAt: new Date(Date.now() - 100000) },
    });
    await limits.admit('192.0.2.1', 'unknown@example.com');
  });
  it('bounds counter cardinality with the global budget before allocating distinct sources/emails', async () => {
    const limits = new PostgresLoginLimits(client, { ...config, requestsGlobally: 1 });
    await limits.admit('a', 'a@example.com');
    await expect(limits.admit('b', 'b@example.com')).rejects.toThrow('RATE_LIMITED');
    expect(await client.loginBudget.count()).toBe(4);
  });
  it('admits shared slots atomically, recovers expiry and fences a resumed expired owner', async () => {
    const configured = { ...config, concurrency: 1 };
    const a = new PostgresLoginLimits(client, configured);
    const b = new PostgresLoginLimits(other, configured);
    const results = await Promise.allSettled([a.acquire(), b.acquire()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await client.loginLease.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    const replacement = await b.acquire();
    const account = await registeredLoginAccount(client);
    const verified = (await VerifiedLogin.verify(
      account.password,
      await new PostgresLoginCredentials(client).find(account.email.toLowerCase()),
    ))!;
    const old = results.find((r) => r.status === 'fulfilled')!;
    if (old.status !== 'fulfilled') throw new Error('missing admitted owner');
    await expect(
      new PostgresSessionRepository(client).createAfterLogin(verified, old.value.id, 1000),
    ).rejects.toThrow('BUSY');
    await a.cleanup();
    expect(await client.loginLease.count()).toBe(1);
    await replacement.release();
    await old.value.release();
    expect(await client.loginLease.count()).toBe(0);
  });
  it('rejects invalid or absent leases without creating records', async () => {
    const a = await prepared();
    await a.lease.release();
    await expect(
      new PostgresSessionRepository(client).createAfterLogin(a.verified, randomUUID(), 1000),
    ).rejects.toThrow('BUSY');
    expect(await client.device.count({ where: { accountId: a.accountId } })).toBe(0);
  });
});
