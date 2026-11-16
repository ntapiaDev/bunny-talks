import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loginEmailSchema } from '@bunny-talks/validation';
import type { Prisma, PrismaClient } from '../../../generated/prisma/client.js';
import { loadLocalEnv } from '../../../local-env.mjs';
import * as passwords from '../../../src/auth/password-verifier.js';
import type { RegistrationEmailTransport } from '../../../src/auth/registration/postgres-email-registration.js';
import { PostgresEmailRegistration } from '../../../src/auth/registration/postgres-email-registration.js';
import type { PasswordBlocklist } from '../../../src/auth/registration/registration-policy.js';
import { generateOpaqueToken } from '../../../src/auth/sessions/session-token.js';
import { createTestDatabase } from '../../support/postgres-test-database.js';

loadLocalEnv();
const password = '  exact registration e\u0301 😀 password  ';

/** Test adapter only: no mailbox delivery or production blocklist is claimed. */
class RecordingTransport implements RegistrationEmailTransport {
  public messages: { to: string; token: string; expiresAt: Date }[] = [];
  public async submitVerification(message: { to: string; token: string; expiresAt: Date }) {
    this.messages.push(message);
  }
}
const blocklist: PasswordBlocklist = {
  async isBlocked(value) {
    return value === 'known compromised password';
  },
};

describe('email registration on real PostgreSQL 18.7', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let client: PrismaClient;
  let now = Date.UTC(2026, 10, 15);
  const clock = () => new Date(now);
  let transport: RecordingTransport;
  let service: PostgresEmailRegistration;
  beforeAll(async () => {
    db = await createTestDatabase();
    client = db.createClient();
    transport = new RecordingTransport();
    service = new PostgresEmailRegistration(client, transport, blocklist, clock);
  }, 30000);
  afterAll(async () => {
    await db?.dispose();
  });
  async function intention(email = `${randomUUID()}@EXAMPLE.COM`) {
    const result = await service.requestVerification(email);
    expect(result).toEqual({ status: 'verification-requested' });
    const message = transport.messages.at(-1)!;
    expect(message.to).toBe(email);
    return { email, token: message.token, password };
  }
  const storedProof = (token: string) =>
    client.emailRegistration.findUniqueOrThrow({ where: { id: token.split('.')[1]! } });
  const accountSnapshot = (id: string) =>
    client.account.findUniqueOrThrow({
      where: { id },
      include: {
        credential: true,
        emailIdentity: true,
        devices: true,
        vault: true,
        publications: true,
        operations: true,
      },
    });

  it('persists only a proof fingerprint before verification, then creates a stable verified account', async () => {
    const accountsBefore = await client.account.count();
    const request = await intention();
    const pending = await storedProof(request.token);
    expect(await client.account.count()).toBe(accountsBefore);
    expect(pending.completedAt).toBeNull();
    expect(pending.accountId).toBeNull();
    expect(pending.tokenHash).toHaveLength(32);
    expect(JSON.stringify(pending)).not.toContain(request.token);
    expect(JSON.stringify(pending)).not.toContain(password);
    const result = await service.finalize(request);
    expect(result.status).toBe('account-created');
    expect(result.accountId).not.toBe(request.email);
    const account = await accountSnapshot(result.accountId);
    expect(account.emailIdentity).toMatchObject({
      canonical: request.email.toLowerCase(),
      display: request.email,
      verifiedAt: clock(),
    });
    expect(account.credential?.revision).toBe(1n);
    expect(account.credential?.verifierUpdatedAt).toBeInstanceOf(Date);
    expect(passwords.validatePasswordVerifier(account.credential?.verifier)).toBe(true);
    expect(await passwords.verifyPassword(password, account.credential?.verifier)).toBe(true);
    expect(await passwords.verifyPassword(password.trim(), account.credential?.verifier)).toBe(
      false,
    );
    expect(
      await passwords.verifyPassword(password.normalize('NFC'), account.credential?.verifier),
    ).toBe(false);
    await expect(
      passwords.verifyPassword(
        password,
        account.credential?.verifier.replace('m=19456', 'm=19457'),
      ),
    ).rejects.toThrow('INVALID_VERIFIER');
    expect(account.devices).toEqual([]);
    expect(account.vault).toBeNull();
    expect(account.publications).toEqual([]);
    expect(await client.session.count({ where: { accountId: result.accountId } })).toBe(0);
    const persisted = await storedProof(request.token);
    expect(persisted).toMatchObject({ accountId: result.accountId, completedAt: clock() });
    const serialized = JSON.stringify({ account, persisted }, (_key, value: unknown) =>
      typeof value === 'bigint' ? String(value) : value,
    );
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain(request.token);
  });

  it('rejects invalid addresses before storing or delivering a proof', async () => {
    const count = await client.emailRegistration.count();
    const sent = transport.messages.length;
    for (const address of ['bad', 'a@éxample.com', ' a@example.com', 'a@domain-.com', null])
      await expect(service.requestVerification(address)).rejects.toThrow('INVALID_EMAIL');
    expect(await client.emailRegistration.count()).toBe(count);
    expect(transport.messages).toHaveLength(sent);
  });

  it('keeps PostgreSQL and shared email validation consistent at format and length boundaries', async () => {
    const longest =
      'a'.repeat(64) + '@' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(57) + '.com';
    for (const display of [
      'a@example.com',
      "o'connor@EXAMPLE.COM",
      'a.b+tag@sub.example.com',
      "a'@example.com",
      'a..b@example.com',
      'a@domain-.com',
      'a@éxample.com',
      'é@example.com',
      'a@example.com\n',
      longest,
      longest.replace('.com', '.comm'),
      'a'.repeat(65) + '@example.com',
      'a@' + 'b'.repeat(64) + '.com',
    ]) {
      const canonical = display.toLowerCase();
      const rows = await client.$queryRaw<
        { valid: boolean }[]
      >`SELECT valid_login_email(${display}, ${canonical}) AS valid`;
      expect(rows[0]!.valid).toBe(loginEmailSchema.safeParse(display).success);
    }
  });

  it('fails closed without a transport or when acceptance is uncertain', async () => {
    const address = `${randomUUID()}@example.com`;
    const count = await client.emailRegistration.count();
    await expect(
      new PostgresEmailRegistration(client).requestVerification(address),
    ).rejects.toThrow('DELIVERY_UNAVAILABLE');
    expect(await client.emailRegistration.count()).toBe(count);
    const failing = new PostgresEmailRegistration(client, {
      async submitVerification() {
        throw new Error('sensitive provider detail');
      },
    });
    await expect(failing.requestVerification(address)).rejects.toMatchObject({
      code: 'DELIVERY_UNAVAILABLE',
      message: 'DELIVERY_UNAVAILABLE',
    });
    const row = await client.emailRegistration.findFirstOrThrow({ where: { canonical: address } });
    expect(row.completedAt).toBeNull();
    expect(row.accountId).toBeNull();
  });

  it('requires a real, correctly scoped proof bound to the exact canonical address', async () => {
    const request = await intention();
    const foreign = await intention();
    const nonexistent = generateOpaqueToken('e1');
    const wrongKind = generateOpaqueToken('r1');
    const wrongSecret = request.token.slice(0, 40) + Buffer.alloc(32, 9).toString('base64url');
    try {
      for (const token of [
        null,
        '',
        true,
        request.token + '=',
        request.token.split('.')[1],
        nonexistent.token,
        wrongKind.token,
        wrongSecret,
      ])
        await expect(service.finalize({ ...request, token })).rejects.toThrow('INVALID_PROOF');
      await expect(service.finalize({ ...request, email: foreign.email })).rejects.toThrow(
        'INVALID_PROOF',
      );
      expect((await storedProof(request.token)).completedAt).toBeNull();
    } finally {
      nonexistent.hash.fill(0);
      wrongKind.hash.fill(0);
    }
  });

  it('rejects injected account identifiers, PHCs, verification flags and missing fields', async () => {
    const request = await intention();
    for (const extra of [
      { accountId: 'victim' },
      { verifier: '$argon2id$malicious' },
      { emailVerified: true },
    ])
      await expect(service.finalize({ ...request, ...extra })).rejects.toThrow('INVALID_REQUEST');
    for (const input of [
      null,
      [],
      {},
      { email: request.email, password },
      { email: request.email, token: request.token },
    ])
      await expect(service.finalize(input)).rejects.toThrow();
    expect((await storedProof(request.token)).accountId).toBeNull();
  });

  it('expires exactly at the boundary, rejects future issuance, and does not reserve abandoned addresses', async () => {
    const request = await intention();
    const issuedAt = now;
    now -= 1;
    await expect(service.finalize(request)).rejects.toThrow('INVALID_PROOF');
    now = issuedAt + 1800000;
    await expect(service.finalize(request)).rejects.toThrow('INVALID_PROOF');
    const replacement = await intention(request.email);
    expect((await service.finalize(replacement)).status).toBe('account-created');
    expect((await storedProof(request.token)).completedAt).toBeNull();
  });

  it('applies the blocklist and exact UTF-8 policy without consuming the proof on failure', async () => {
    const request = await intention();
    for (const password of ['short', '😀'.repeat(14), 'a'.repeat(1025), 'x'.repeat(15) + '\ud800'])
      await expect(service.finalize({ ...request, password })).rejects.toThrow('INVALID_PASSWORD');
    await expect(
      service.finalize({ ...request, password: 'known compromised password' }),
    ).rejects.toThrow('BLOCKED_PASSWORD');
    await expect(
      new PostgresEmailRegistration(client, transport, undefined, clock).finalize(request),
    ).rejects.toThrow('POLICY_UNAVAILABLE');
    await expect(
      new PostgresEmailRegistration(
        client,
        transport,
        {
          async isBlocked() {
            throw new Error('private');
          },
        },
        clock,
      ).finalize(request),
    ).rejects.toThrow('POLICY_UNAVAILABLE');
    expect((await storedProof(request.token)).accountId).toBeNull();
    const failure = vi
      .spyOn(passwords, 'createPasswordVerifier')
      .mockRejectedValueOnce(new passwords.PasswordVerifierError('CRYPTO_UNAVAILABLE'));
    try {
      await expect(service.finalize(request)).rejects.toThrow('CRYPTO_UNAVAILABLE');
    } finally {
      failure.mockRestore();
    }
    expect((await service.finalize(request)).status).toBe('account-created');
  });

  it('never modifies an existing account using a new proof for the same address', async () => {
    const first = await intention();
    const result = await service.finalize(first);
    const snapshot = await accountSnapshot(result.accountId);
    const duplicate = await intention(first.email.replace('EXAMPLE.COM', 'example.com'));
    await expect(
      service.finalize({ ...duplicate, password: 'attacker replacement password' }),
    ).rejects.toThrow('EMAIL_UNAVAILABLE');
    expect(await accountSnapshot(result.accountId)).toEqual(snapshot);
    expect((await storedProof(duplicate.token)).completedAt).toBeNull();
  });

  it('keeps legitimate local-part variants distinct under PostgreSQL uniqueness', async () => {
    const name = randomUUID();
    const addresses = [
      `a${name}@example.com`,
      `a.${name}@example.com`,
      `a${name}+tag@example.com`,
      `o'${name}@example.com`,
    ];
    const ids = [];
    for (const address of addresses)
      ids.push((await service.finalize(await intention(address))).accountId);
    expect(new Set(ids).size).toBe(addresses.length);
  });

  it('serializes concurrent consumers of one proof across separate connections', async () => {
    const request = await intention();
    const other = new PostgresEmailRegistration(db.createClient(), transport, blocklist, clock);
    const results = await Promise.all([service.finalize(request), other.finalize(request)]);
    expect(results[0]).toEqual(results[1]);
    expect(
      await client.emailIdentity.count({
        where: { canonical: request.email.toLowerCase() },
      }),
    ).toBe(1);
  });

  it('allows only one account when separate proofs race for one address', async () => {
    const first = await intention();
    const second = await intention(first.email.toUpperCase());
    const beforeAccounts = await client.account.count();
    const beforeCredentials = await client.passwordCredential.count();
    let lookups = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    function synchronized(connection: PrismaClient) {
      return new Proxy(connection, {
        get(target, prop, receiver) {
          if (prop === '$transaction')
            return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
              target.$transaction(
                (tx) =>
                  work(
                    new Proxy(tx, {
                      get(t, key, r) {
                        if (key === 'emailIdentity')
                          return new Proxy(t.emailIdentity, {
                            get(delegate, operation, dr) {
                              if (operation === 'findUnique')
                                return async (args: Prisma.EmailIdentityFindUniqueArgs) => {
                                  const found = await delegate.findUnique(args);
                                  expect(found).toBeNull();
                                  if (++lookups === 2) release();
                                  await gate;
                                  return found;
                                };
                              return Reflect.get(delegate, operation, dr);
                            },
                          });
                        return Reflect.get(t, key, r);
                      },
                    }),
                  ),
                options,
              );
          return Reflect.get(target, prop, receiver);
        },
      });
    }
    const firstService = new PostgresEmailRegistration(
      synchronized(client),
      transport,
      blocklist,
      clock,
    );
    const other = new PostgresEmailRegistration(
      synchronized(db.createClient()),
      transport,
      blocklist,
      clock,
    );
    const results = await Promise.allSettled([
      firstService.finalize(first),
      other.finalize(second),
    ]);
    // Both transactions passed the application precheck: only the SQL index can arbitrate.
    expect(lookups).toBe(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'EMAIL_UNAVAILABLE' },
    });
    const rows = await client.emailRegistration.findMany({
      where: { id: { in: [first.token.split('.')[1]!, second.token.split('.')[1]!] } },
    });
    expect(rows.filter((r) => r.completedAt !== null)).toHaveLength(1);
    expect(rows.filter((r) => r.completedAt === null && r.accountId === null)).toHaveLength(1);
    expect(await client.account.count()).toBe(beforeAccounts + 1);
    expect(await client.passwordCredential.count()).toBe(beforeCredentials + 1);
    const loser = results[0]!.status === 'rejected' ? first : second;
    await expect(service.finalize(loser)).rejects.toThrow('EMAIL_UNAVAILABLE');
  });

  it('sanitizes a different unique constraint without classifying it as an email conflict', async () => {
    const request = await intention();
    const existingId = randomUUID();
    await client.account.create({ data: { id: existingId } });
    const otherId = randomUUID();
    await client.account.create({ data: { id: otherId } });
    const address = `${randomUUID()}@example.com`;
    await client.emailIdentity.create({
      data: { accountId: existingId, canonical: address, display: address, verifiedAt: clock() },
    });
    const duplicateError = await client.emailIdentity
      .create({
        data: { accountId: otherId, canonical: address, display: address, verifiedAt: clock() },
      })
      .catch((error: unknown) => error);
    expect(duplicateError).toMatchObject({
      code: 'P2002',
      meta: {
        driverAdapterError: {
          cause: {
            originalCode: '23505',
            kind: 'UniqueConstraintViolation',
            constraint: { index: 'EmailIdentity_canonical_key' },
          },
        },
      },
    });
    const broken = new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === '$transaction')
          return async (_work: unknown, options: object) =>
            target.$transaction(async (tx) => {
              await tx.account.create({ data: { id: existingId } });
            }, options);
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(
      new PostgresEmailRegistration(broken, transport, blocklist, clock).finalize(request),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', message: 'OUTCOME_UNKNOWN' });
    expect((await storedProof(request.token)).accountId).toBeNull();
  });

  it('recovers a lost response after Prisma restart and expiry without mutating credentials', async () => {
    const request = await intention();
    const result = await service.finalize(request);
    const before = await accountSnapshot(result.accountId);
    await client.$disconnect();
    const newClient = db.createClient();
    now += 1800001;
    const recreated = new PostgresEmailRegistration(newClient, undefined, undefined, clock);
    // Receipt recovery is not a second password selection or a successful login.
    expect(await recreated.finalize({ ...request, password: 'different password' })).toEqual(
      result,
    );
    expect(await accountSnapshot(result.accountId)).toEqual(before);
    await expect(
      recreated.finalize({ ...request, email: `${randomUUID()}@example.com` }),
    ).rejects.toThrow('INVALID_PROOF');
  });

  function faultClient(kind: 'credential' | 'rollback' | 'after-commit') {
    return new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === '$transaction')
          return async (
            work: (tx: Prisma.TransactionClient) => Promise<unknown>,
            options: object,
          ) => {
            const result = await target.$transaction(async (tx) => {
              if (kind === 'credential') {
                // A real SQL failure after Account and EmailIdentity writes, before the verifier insert.
                return work(
                  new Proxy(tx, {
                    get(t, key, r) {
                      if (key === 'passwordCredential')
                        return { create: () => tx.$executeRaw`SELECT 1 / 0` };
                      return Reflect.get(t, key, r);
                    },
                  }),
                );
              }
              const result = await work(tx);
              if (kind === 'rollback') throw new Error('private failure before commit');
              return result;
            }, options);
            if (kind === 'after-commit') throw new Error('connection lost after successful commit');
            return result;
          };
        return Reflect.get(target, prop, receiver);
      },
    });
  }
  it.each(['credential', 'rollback', 'after-commit'] as const)(
    'handles %s failure without assuming a rollback',
    async (kind) => {
      const request = await intention();
      const before = await client.account.count();
      const broken = new PostgresEmailRegistration(faultClient(kind), transport, blocklist, clock);
      await expect(broken.finalize(request)).rejects.toMatchObject({
        code: 'OUTCOME_UNKNOWN',
        message: 'OUTCOME_UNKNOWN',
      });
      const row = await storedProof(request.token);
      expect(row.completedAt !== null).toBe(kind === 'after-commit');
      expect(await client.account.count()).toBe(before + (kind === 'after-commit' ? 1 : 0));
      const result = await service.finalize(request);
      expect(await client.account.count()).toBe(before + 1);
      if (kind === 'after-commit') expect(result.accountId).toBe(row.accountId);
    },
  );

  it('rechecks expiry after password preparation without holding a transaction', async () => {
    const request = await intention();
    const original = passwords.createPasswordVerifier;
    const spy = vi
      .spyOn(passwords, 'createPasswordVerifier')
      .mockImplementationOnce(async (value) => {
        // A real concurrent writer can acquire the proof lock while the KDF runs.
        await db.createClient().$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('lock_timeout', '100ms', true)`;
          const rows = await tx.$queryRaw<
            { accountId: string | null }[]
          >`SELECT "accountId" FROM "EmailRegistration" WHERE id = ${request.token.split('.')[1]}::uuid FOR UPDATE`;
          expect(rows[0]!.accountId).toBeNull();
        });
        const result = await original(value);
        now += 1800000;
        return result;
      });
    try {
      await expect(service.finalize(request)).rejects.toThrow('INVALID_PROOF');
    } finally {
      spy.mockRestore();
    }
    expect((await storedProof(request.token)).accountId).toBeNull();
  });

  it('enforces canonical identity and immutable proof lifecycle directly in SQL', async () => {
    const request = await intention();
    const row = await storedProof(request.token);
    for (const data of [
      { canonical: 'other@example.com' },
      { tokenHash: Buffer.alloc(32) },
      { expiresAt: new Date(now + 1) },
      { completedAt: clock() },
    ])
      await expect(
        client.emailRegistration.update({ where: { id: row.id }, data }),
      ).rejects.toBeDefined();
    await expect(
      client.emailRegistration.create({
        data: { ...row, id: randomUUID(), tokenHash: Buffer.alloc(1) },
      }),
    ).rejects.toBeDefined();
    const result = await service.finalize(request);
    await expect(
      client.emailRegistration.update({
        where: { id: row.id },
        data: { accountId: null, completedAt: null },
      }),
    ).rejects.toBeDefined();
    const completed = await storedProof(request.token);
    await expect(
      client.emailRegistration.create({ data: { ...completed, id: randomUUID() } }),
    ).rejects.toBeDefined();
    const victim = (await service.finalize(await intention())).accountId;
    const pending = await intention();
    await expect(
      client.emailRegistration.update({
        where: { id: pending.token.split('.')[1]! },
        data: { accountId: victim, completedAt: clock() },
      }),
    ).rejects.toBeDefined();
    await expect(
      client.emailIdentity.update({
        where: { accountId: result.accountId },
        data: { canonical: request.email },
      }),
    ).rejects.toBeDefined();
    const another = await client.account.create({ data: { id: randomUUID() } });
    await expect(
      client.emailIdentity.create({
        data: {
          accountId: another.id,
          display: request.email,
          canonical: row.canonical,
          verifiedAt: clock(),
        },
      }),
    ).rejects.toBeDefined();
  });

  it('timestamps actual verifier replacement and preserves the date on no-op, revision-only updates and rollback', async () => {
    const result = await service.finalize(await intention());
    const credential = () =>
      client.passwordCredential.findUniqueOrThrow({ where: { accountId: result.accountId } });
    const initial = await credential();
    await client.passwordCredential.update({
      where: { accountId: result.accountId },
      data: { verifier: initial.verifier, revision: 2n, verifierUpdatedAt: null },
    });
    expect((await credential()).verifierUpdatedAt).toEqual(initial.verifierUpdatedAt);
    const newVerifier = await passwords.createPasswordVerifier(password);
    await expect(
      client.$transaction(async (tx) => {
        await tx.passwordCredential.update({
          where: { accountId: result.accountId },
          data: { verifier: newVerifier },
        });
        throw new Error('rollback fixture');
      }),
    ).rejects.toThrow();
    expect((await credential()).verifier).toBe(initial.verifier);
    expect((await credential()).verifierUpdatedAt).toEqual(initial.verifierUpdatedAt);
    await client.passwordCredential.update({
      where: { accountId: result.accountId },
      data: { verifier: newVerifier },
    });
    const updated = await credential();
    expect(updated.verifierUpdatedAt!.getTime()).toBeGreaterThan(
      initial.verifierUpdatedAt!.getTime(),
    );
    expect(await passwords.verifyPassword(password, updated.verifier)).toBe(true);
  });
});
