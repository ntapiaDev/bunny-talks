import { Buffer } from 'node:buffer';
import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InitialVaultPublication, OrdinaryPasswordChange } from '@bunny-talks/contracts';
import { validateAccountVault } from '@bunny-talks/crypto-backup';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { loadLocalEnv } from '../local-env.mjs';
import { PostgresVaultRepository } from '../src/postgres-vault-repository.js';
import { publicationDigest } from '../src/publication-digest.js';
import { createTestDatabase } from './postgres-test-database.js';

loadLocalEnv();
const vector = JSON.parse(
  readFileSync(
    new URL(
      '../../../packages/crypto/backup/tests/fixtures/account-vault-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { publication: string; context: { account: string; vaultId: string } };
const key = createSecretKey(randomBytes(32));
const keys = {
  activeKeyId: 'test-42b',
  getKey: (id: string) => (id === 'test-42b' ? key : undefined),
};
const digest = (text: string) => publicationDigest(Buffer.from(text));
const encoded = (text: string) => Buffer.from(text).toString('base64url');

// Structural fixtures intentionally do not claim valid client MACs or server authentication.
function publication(account: string, generation = 1) {
  const v = JSON.parse(vector.publication) as {
    header: { account: string };
    manifest: { generation: number };
    passwordEnvelope: string;
    recoveryEnvelope: string;
  };
  v.header.account = account;
  v.manifest.generation = generation;
  for (const field of ['passwordEnvelope', 'recoveryEnvelope'] as const) {
    const e = JSON.parse(v[field]) as { header: { account: string; revision: number } };
    e.header.account = account;
    if (field === 'passwordEnvelope') e.header.revision = generation;
    v[field] = JSON.stringify(e);
  }
  return JSON.stringify(v);
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Injection lives exclusively in tests, after all writes and before the actual commit. */
function interceptTransaction(
  client: PrismaClient,
  afterWork: (tx: Prisma.TransactionClient) => Promise<void>,
  afterCommit?: () => void,
): PrismaClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === '$transaction')
        return async <T>(
          work: (tx: Prisma.TransactionClient) => Promise<T>,
          options: { isolationLevel: 'ReadCommitted'; maxWait: number; timeout: number },
        ) => {
          const result = await target.$transaction(async (tx) => {
            const value = await work(tx);
            await afterWork(tx);
            return value;
          }, options);
          afterCommit?.();
          return result;
        };
      return Reflect.get(target, property, receiver);
    },
  });
}

describe('transactional vault repository on PostgreSQL 18.7', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let client: PrismaClient;
  let repository: PostgresVaultRepository;
  beforeAll(async () => {
    db = await createTestDatabase();
    client = db.createClient();
    repository = new PostgresVaultRepository(client, keys);
  }, 30_000);
  afterAll(async () => {
    await db?.dispose();
  });

  async function fixture(active = false) {
    const account = `fixture:${randomUUID()}`;
    await client.account.create({
      data: { id: account, credential: { create: { verifier: 'fixture-old-verifier' } } },
    });
    const first = publication(account);
    const initial: InitialVaultPublication = {
      transportVersion: 1,
      operationId: randomUUID(),
      account,
      vaultId: vector.context.vaultId,
      expectedCredentialRevision: '1',
      expectedStorageRevision: null,
      publicationBase64Url: encoded(first),
    };
    const next = publication(account, 2);
    const request: OrdinaryPasswordChange = {
      transportVersion: 1,
      operationId: randomUUID(),
      account,
      vaultId: vector.context.vaultId,
      expected: { storageRevision: '1', credentialRevision: '1' },
      publicationBase64Url: encoded(next),
    };
    const prepared = {
      verifier: 'fixture-new-verifier',
      expectedPublicationDigest: digest(first),
      expectedGeneration: 1,
      candidateDigest: digest(next),
    };
    if (active)
      expect(await repository.publishInitial(initial, digest(first))).toMatchObject({
        status: 'committed',
      });
    return { account, first, next, initial, request, prepared };
  }

  async function snapshot(account: string) {
    return {
      state: await client.vaultState.findUnique({ where: { accountId: account } }),
      credential: await client.passwordCredential.findUnique({ where: { accountId: account } }),
      publications: await client.vaultPublication.findMany({
        where: { accountId: account },
        orderBy: { generation: 'asc' },
      }),
      operations: await client.vaultOperation.findMany({
        where: { accountId: account },
        orderBy: { operationId: 'asc' },
      }),
    };
  }

  async function waitForLock(name: string) {
    // Observe a real database wait, not an assumption that a timer implies overlap.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const rows = await db.admin.$queryRaw<
        { waiting: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = ${name} AND wait_event_type = 'Lock') AS waiting`;
      if (rows[0]?.waiting) return;
      await delay(5);
    }
    throw new Error('Expected PostgreSQL lock wait was not observed');
  }

  it.each([
    { kind: 'initial', replay: false },
    { kind: 'rewrap', replay: false },
    { kind: 'initial', replay: true },
    { kind: 'rewrap', replay: true },
  ] as const)(
    'serializes concurrent $kind mutations across separate connections (same operation=$replay)',
    async ({ kind, replay }) => {
      const f = await fixture(kind === 'rewrap');
      const entered = gate();
      const release = gate();
      const a = new PostgresVaultRepository(
        interceptTransaction(db.createClient(), async () => {
          entered.resolve();
          await release.promise;
        }),
        keys,
        { lockTimeoutMs: 4_000, statementTimeoutMs: 5_000, timeoutMs: 8_000 },
      );
      const name = `waiter-${randomUUID()}`;
      const b = new PostgresVaultRepository(db.createClient(name), keys, {
        lockTimeoutMs: 4_000,
        statementTimeoutMs: 5_000,
        timeoutMs: 8_000,
      });
      const first =
        kind === 'initial'
          ? a.publishInitial(f.initial, digest(f.first))
          : a.rewrapPassword(f.request, f.prepared);
      await entered.promise;
      const second =
        kind === 'initial'
          ? b.publishInitial(
              { ...f.initial, operationId: replay ? f.initial.operationId : randomUUID() },
              digest(f.first),
            )
          : b.rewrapPassword(
              { ...f.request, operationId: replay ? f.request.operationId : randomUUID() },
              f.prepared,
            );
      try {
        await waitForLock(name);
      } finally {
        release.resolve();
      }
      const results = await Promise.all([first, second]);
      expect(results[0]).toMatchObject({ status: 'committed' });
      if (replay) expect(results[1]).toEqual(results[0]);
      else
        expect(results[1]).toMatchObject({
          status: 'rejected',
          code: kind === 'initial' ? 'ALREADY_EXISTS' : 'VERSION_CONFLICT',
        });
      const after = await snapshot(f.account);
      expect(after.publications).toHaveLength(kind === 'initial' ? 1 : 2);
      expect(after.state?.storageRevision).toBe(kind === 'initial' ? 1n : 2n);
      expect(after.credential?.revision).toBe(kind === 'initial' ? 1n : 2n);
      expect(after.operations).toHaveLength((kind === 'initial' ? 0 : 1) + (replay ? 1 : 2));
    },
  );

  it('allows another account to commit while the first account lock is held', async () => {
    const a = await fixture();
    const b = await fixture();
    const entered = gate();
    const release = gate();
    const held = new PostgresVaultRepository(
      interceptTransaction(db.createClient(), async () => {
        entered.resolve();
        await release.promise;
      }),
      keys,
    );
    const pending = held.publishInitial(a.initial, digest(a.first));
    await entered.promise;
    try {
      const other = new PostgresVaultRepository(db.createClient(), keys);
      expect(await other.publishInitial(b.initial, digest(b.first))).toMatchObject({
        status: 'committed',
      });
      expect(await client.vaultState.count({ where: { accountId: a.account } })).toBe(0);
    } finally {
      release.resolve();
    }
    expect(await pending).toMatchObject({ status: 'committed' });
  });

  it('replays initial and rewrap receipts after client recreation, without a second mutation', async () => {
    const f = await fixture();
    expect(await repository.getOperation(f.account, f.initial.operationId)).toEqual({
      transportVersion: 1,
      status: 'unknown',
    });
    const committed = await repository.publishInitial(f.initial, digest(f.first));
    expect(await repository.publishInitial(f.initial, digest(f.first))).toEqual(committed);
    const changed = await repository.rewrapPassword(f.request, f.prepared);
    const before = await snapshot(f.account);
    await client.$disconnect();
    client = db.createClient();
    repository = new PostgresVaultRepository(client, keys);
    expect(await repository.getOperation(f.account, f.initial.operationId)).toEqual(committed);
    expect(await repository.publishInitial(f.initial, digest(f.first))).toEqual(committed);
    expect(await repository.rewrapPassword(f.request, f.prepared)).toEqual(changed);
    expect(await repository.getOperation(f.account, f.request.operationId)).toEqual(changed);
    expect(await snapshot(f.account)).toEqual(before);
  });

  it('refuses a different request for the same operation without replacing its receipt', async () => {
    const f = await fixture(true);
    const committed = await repository.rewrapPassword(f.request, f.prepared);
    const before = await snapshot(f.account);
    const changed = publication(f.account, 3);
    for (const [request, prepared] of [
      [f.request, { ...f.prepared, verifier: 'different-prepared-verifier' }],
      [
        { ...f.request, publicationBase64Url: encoded(changed) },
        { ...f.prepared, candidateDigest: digest(changed) },
      ],
      [{ ...f.request, expected: { ...f.request.expected, credentialRevision: '2' } }, f.prepared],
    ] as const) {
      expect(await repository.rewrapPassword(request, prepared)).toMatchObject({
        status: 'rejected',
        code: 'IDEMPOTENCY_MISMATCH',
      });
    }
    expect(await repository.getOperation(f.account, f.request.operationId)).toEqual(committed);
    expect(await snapshot(f.account)).toEqual(before);
    const text = JSON.stringify(before.operations, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(text).not.toContain('fixture-old-verifier');
    expect(text).not.toContain('fixture-new-verifier');
  });

  it.each(['storage', 'credential', 'digest', 'generation'] as const)(
    'records and replays a terminal %s CAS rejection',
    async (field) => {
      const f = await fixture(true);
      const request = {
        ...f.request,
        expected: {
          ...f.request.expected,
          ...(field === 'storage'
            ? { storageRevision: '2' }
            : field === 'credential'
              ? { credentialRevision: '2' }
              : {}),
        },
      };
      const prepared = {
        ...f.prepared,
        ...(field === 'digest'
          ? { expectedPublicationDigest: digest('different') }
          : field === 'generation'
            ? { expectedGeneration: 2 }
            : {}),
      };
      const before = await snapshot(f.account);
      const rejection = await repository.rewrapPassword(request, prepared);
      expect(rejection).toMatchObject({ status: 'rejected', code: 'VERSION_CONFLICT' });
      expect(
        await repository.rewrapPassword({ ...f.request, operationId: randomUUID() }, f.prepared),
      ).toMatchObject({ status: 'committed' });
      const restarted = new PostgresVaultRepository(db.createClient(), keys);
      expect(await restarted.rewrapPassword(request, prepared)).toEqual(rejection);
      expect(await restarted.getOperation(f.account, request.operationId)).toEqual(rejection);
      const after = await snapshot(f.account);
      expect(after.state?.storageRevision).toBe(before.state!.storageRevision + 1n);
      expect(after.publications).toHaveLength(2);
    },
  );

  it.each(['content', 'recoveryEnvelope', 'counters'] as const)(
    'rejects forbidden changes to %s durably',
    async (field) => {
      const f = await fixture(true);
      const v = JSON.parse(f.next) as {
        content: string;
        recoveryEnvelope: string;
        manifest: { generation: number };
      };
      if (field === 'counters') v.manifest.generation++;
      else {
        const e = JSON.parse(v[field]) as { ciphertext: string };
        e.ciphertext = (e.ciphertext.startsWith('A') ? 'B' : 'A') + e.ciphertext.slice(1);
        v[field] = JSON.stringify(e);
      }
      const candidate = JSON.stringify(v);
      expect(validateAccountVault(Buffer.from(candidate), f.initial).ok).toBe(true);
      const before = await snapshot(f.account);
      const request = { ...f.request, publicationBase64Url: encoded(candidate) };
      const prepared = { ...f.prepared, candidateDigest: digest(candidate) };
      const result = await repository.rewrapPassword(request, prepared);
      expect(result).toMatchObject({ status: 'rejected', code: 'INVALID_TRANSITION' });
      expect(await repository.rewrapPassword(request, prepared)).toEqual(result);
      const after = await snapshot(f.account);
      expect(after.state).toEqual(before.state);
      expect(after.credential).toEqual(before.credential);
      expect(after.publications).toEqual(before.publications);
    },
  );

  it('preserves exact bytes, devices and sessions, and only changes the prepared credential', async () => {
    const f = await fixture(true);
    const device = await client.device.create({
      data: {
        id: randomUUID(),
        accountId: f.account,
        sessions: { create: { id: randomUUID() } },
      },
    });
    const revoked = await client.device.create({
      data: {
        id: randomUUID(),
        accountId: f.account,
        revokedAt: new Date('2026-01-01T00:00:00Z'),
        sessions: {
          create: {
            id: randomUUID(),
            createdAt: new Date('2026-01-01T00:00:00Z'),
            revokedAt: new Date('2026-01-01T00:00:00Z'),
          },
        },
      },
    });
    const devices = await client.device.findMany({
      where: { accountId: f.account },
      include: { sessions: true },
      orderBy: { id: 'asc' },
    });
    expect(device.revokedAt).toBe(null);
    expect(revoked.revokedAt).not.toBe(null);
    expect(await repository.rewrapPassword(f.request, f.prepared)).toMatchObject({
      status: 'committed',
      cas: { storageRevision: '2', credentialRevision: '2' },
    });
    expect(
      await client.device.findMany({
        where: { accountId: f.account },
        include: { sessions: true },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(devices);
    const after = await snapshot(f.account);
    expect(after.publications.map((p) => Buffer.from(p.bytes))).toEqual([
      Buffer.from(f.first),
      Buffer.from(f.next),
    ]);
    expect(after.credential).toMatchObject({ revision: 2n, verifier: f.prepared.verifier });
    expect(await repository.readActive(f.account)).toMatchObject({
      publicationBase64Url: encoded(f.next),
      publicationDigest: digest(f.next),
      revisions: { generation: 2, contentRevision: 1, passwordRevision: 2, recoveryRevision: 1 },
      envelopeCredentialRevision: '2',
    });
  });

  it.each([false, true])(
    'rolls back all writes on failure before commit (active=%s)',
    async (active) => {
      const f = await fixture(active);
      const before = await snapshot(f.account);
      const failing = new PostgresVaultRepository(
        interceptTransaction(db.createClient(), async (tx) => {
          expect(await tx.vaultOperation.count({ where: { accountId: f.account } })).toBe(
            before.operations.length + 1,
          );
          expect(await tx.vaultPublication.count({ where: { accountId: f.account } })).toBe(
            before.publications.length + 1,
          );
          throw new Error('test-only precommit fault');
        }),
        keys,
      );
      await expect(
        active
          ? failing.rewrapPassword(f.request, f.prepared)
          : failing.publishInitial(f.initial, digest(f.first)),
      ).rejects.toMatchObject({
        code: 'TRANSACTION_OUTCOME_UNKNOWN',
        message: 'TRANSACTION_OUTCOME_UNKNOWN',
      });
      expect(await snapshot(f.account)).toEqual(before);
      expect(
        await repository.getOperation(
          f.account,
          active ? f.request.operationId : f.initial.operationId,
        ),
      ).toMatchObject({ status: 'unknown' });
      expect(
        await (active
          ? repository.rewrapPassword(f.request, f.prepared)
          : repository.publishInitial(f.initial, digest(f.first))),
      ).toMatchObject({ status: 'committed' });
    },
  );

  it('recovers a committed operation when the application response was lost', async () => {
    const f = await fixture(true);
    const lost = new PostgresVaultRepository(
      interceptTransaction(
        db.createClient(),
        async () => {},
        () => {
          throw new Error('test-only lost response');
        },
      ),
      keys,
    );
    await expect(lost.rewrapPassword(f.request, f.prepared)).rejects.toMatchObject({
      code: 'TRANSACTION_OUTCOME_UNKNOWN',
    });
    const before = await snapshot(f.account);
    const recreated = new PostgresVaultRepository(db.createClient(), keys);
    const receipt = await recreated.getOperation(f.account, f.request.operationId);
    expect(receipt).toMatchObject({ status: 'committed' });
    expect(await recreated.rewrapPassword(f.request, f.prepared)).toEqual(receipt);
    expect(await snapshot(f.account)).toEqual(before);
  });

  it('resumes after a real lock timeout without a durable rejection or double mutation', async () => {
    const f = await fixture(true);
    const entered = gate();
    const release = gate();
    const holder = db.createClient().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${f.account} FOR UPDATE`;
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const timed = new PostgresVaultRepository(db.createClient(), keys, { lockTimeoutMs: 100 });
    try {
      await expect(timed.rewrapPassword(f.request, f.prepared)).rejects.toMatchObject({
        code: 'TRANSACTION_OUTCOME_UNKNOWN',
      });
      expect(
        await client.vaultOperation.count({
          where: { accountId: f.account, operationId: f.request.operationId },
        }),
      ).toBe(0);
    } finally {
      release.resolve();
      await holder;
    }
    const result = await repository.rewrapPassword(f.request, f.prepared);
    expect(result).toMatchObject({ status: 'committed' });
    expect(await repository.rewrapPassword(f.request, f.prepared)).toEqual(result);
    expect((await snapshot(f.account)).publications).toHaveLength(2);
  });

  it('fails closed if a receipt key is missing and verifies with the retained key by keyId', async () => {
    const f = await fixture();
    const result = await repository.publishInitial(f.initial, digest(f.first));
    const replacement = createSecretKey(randomBytes(32));
    const missing = new PostgresVaultRepository(db.createClient(), {
      activeKeyId: 'replacement',
      getKey: (id) => (id === 'replacement' ? replacement : undefined),
    });
    await expect(missing.publishInitial(f.initial, digest(f.first))).rejects.toMatchObject({
      code: 'KEY_UNAVAILABLE',
    });
    await expect(missing.getOperation(f.account, f.initial.operationId)).rejects.toMatchObject({
      code: 'KEY_UNAVAILABLE',
    });
    const retained = new PostgresVaultRepository(db.createClient(), {
      activeKeyId: 'replacement',
      getKey: (id) => (id === 'replacement' ? replacement : keys.getKey(id)),
    });
    expect(await retained.publishInitial(f.initial, digest(f.first))).toEqual(result);
  });

  it('rejects malformed input, context substitution and caller digest mismatch without receipts', async () => {
    const f = await fixture();
    expect(await repository.readActive(f.account)).toBe(null);
    await expect(
      repository.publishInitial({ ...f.initial, account: 'other-account' }, digest(f.first)),
    ).rejects.toMatchObject({ code: 'INVALID_PUBLICATION' });
    await expect(repository.publishInitial(f.initial, digest('wrong'))).rejects.toMatchObject({
      code: 'INVALID_PUBLICATION',
    });
    await expect(
      repository.publishInitial(
        { ...f.initial, publicationBase64Url: encoded('private-invalid-json') },
        digest('private-invalid-json'),
      ),
    ).rejects.toMatchObject({ message: 'INVALID_PUBLICATION' });
    await expect(
      repository.publishInitial({ ...f.initial, unexpected: 'private-value' }, digest(f.first)),
    ).rejects.toMatchObject({ message: 'INVALID_INPUT' });
    await expect(
      repository.rewrapPassword(f.request, { ...f.prepared, verifier: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(repository.getOperation(f.account, 'invalid-uuid')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(() => new PostgresVaultRepository(client, keys, { lockTimeoutMs: 3_000 })).toThrow(
      'INVALID_INPUT',
    );
    expect(await client.vaultOperation.count({ where: { accountId: f.account } })).toBe(0);
  });

  it('durably rejects noninitial counters and a stale initial credential revision', async () => {
    const f = await fixture();
    const invalidInitial = { ...f.initial, publicationBase64Url: encoded(f.next) };
    const rejection = await repository.publishInitial(invalidInitial, digest(f.next));
    expect(rejection).toMatchObject({ status: 'rejected', code: 'INVALID_TRANSITION' });
    expect(await repository.publishInitial(invalidInitial, digest(f.next))).toEqual(rejection);
    const stale = { ...f.initial, operationId: randomUUID(), expectedCredentialRevision: '2' };
    expect(await repository.publishInitial(stale, digest(f.first))).toMatchObject({
      status: 'rejected',
      code: 'VERSION_CONFLICT',
    });
    expect(await repository.readActive(f.account)).toBe(null);
    expect((await snapshot(f.account)).publications).toHaveLength(0);
  });

  it.each(['storage', 'credential'] as const)(
    'rejects exhausted PostgreSQL %s revisions without mutation',
    async (field) => {
      const f = await fixture(true);
      const maximum = 9223372036854775807n;
      const request = { ...f.request, expected: { ...f.request.expected } };
      if (field === 'storage') {
        await client.vaultState.update({
          where: { accountId: f.account },
          data: { storageRevision: maximum },
        });
        request.expected.storageRevision = maximum.toString();
      } else {
        await client.passwordCredential.update({
          where: { accountId: f.account },
          data: { revision: maximum },
        });
        await client.vaultPublication.updateMany({
          where: { accountId: f.account },
          data: { envelopeCredentialRevision: maximum },
        });
        request.expected.credentialRevision = maximum.toString();
      }
      const before = await snapshot(f.account);
      expect(await repository.rewrapPassword(request, f.prepared)).toMatchObject({
        status: 'rejected',
        code: 'INVALID_TRANSITION',
      });
      const after = await snapshot(f.account);
      expect(after.state).toEqual(before.state);
      expect(after.credential).toEqual(before.credential);
      expect(after.publications).toEqual(before.publications);
    },
  );

  it('reads a stale envelope after a simulated reset and durably rejects ordinary rewrap', async () => {
    const f = await fixture(true);
    const device = await client.device.create({
      data: { id: randomUUID(), accountId: f.account, sessions: { create: { id: randomUUID() } } },
    });
    await client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${f.account} FOR UPDATE`;
      await tx.passwordCredential.update({
        where: { accountId: f.account },
        data: { verifier: 'simulated-reset-verifier', revision: 2n },
      });
    });
    expect(await repository.readActive(f.account)).toMatchObject({
      publicationBase64Url: encoded(f.first),
      cas: { storageRevision: '1', credentialRevision: '2' },
      envelopeCredentialRevision: '1',
    });
    const before = await snapshot(f.account);
    const sessions = await client.session.findMany({ where: { deviceId: device.id } });
    const request = { ...f.request, expected: { ...f.request.expected, credentialRevision: '2' } };
    const result = await repository.rewrapPassword(request, f.prepared);
    expect(result).toMatchObject({ status: 'rejected', code: 'VERSION_CONFLICT' });
    expect(await repository.rewrapPassword(request, f.prepared)).toEqual(result);
    const after = await snapshot(f.account);
    expect(after.state).toEqual(before.state);
    expect(after.credential).toEqual(before.credential);
    expect(after.publications).toEqual(before.publications);
    expect(after.operations).toHaveLength(before.operations.length + 1);
    expect(await client.session.findMany({ where: { deviceId: device.id } })).toEqual(sessions);
    expect(await client.device.findUnique({ where: { id: device.id } })).toEqual(device);
  });

  it('treats an envelope revision ahead of authentication as corrupt storage', async () => {
    const f = await fixture(true);
    await client.vaultPublication.updateMany({
      where: { accountId: f.account },
      data: { envelopeCredentialRevision: 2n },
    });
    await expect(repository.readActive(f.account)).rejects.toMatchObject({
      code: 'CORRUPT_STORAGE',
    });
    await expect(repository.rewrapPassword(f.request, f.prepared)).rejects.toMatchObject({
      code: 'CORRUPT_STORAGE',
    });
    expect(await repository.getOperation(f.account, f.request.operationId)).toMatchObject({
      status: 'unknown',
    });
  });

  it.each(['structure', 'digest'] as const)(
    'treats corrupt stored %s as a storage failure, not a durable business rejection',
    async (corruption) => {
      const f = await fixture(true);
      const bytes = Buffer.from('invalid stored JSON');
      await client.vaultPublication.updateMany({
        where: { accountId: f.account },
        data:
          corruption === 'structure'
            ? { bytes, digest: Buffer.from(publicationDigest(bytes), 'base64url') }
            : { digest: Buffer.alloc(32) },
      });
      await expect(repository.readActive(f.account)).rejects.toMatchObject({
        code: 'CORRUPT_STORAGE',
      });
      await expect(repository.rewrapPassword(f.request, f.prepared)).rejects.toMatchObject({
        code: 'CORRUPT_STORAGE',
      });
      expect(await repository.getOperation(f.account, f.request.operationId)).toMatchObject({
        status: 'unknown',
      });
    },
  );

  it('does not create missing accounts or fabricate credentials', async () => {
    const f = await fixture();
    await client.passwordCredential.delete({ where: { accountId: f.account } });
    await expect(repository.publishInitial(f.initial, digest(f.first))).rejects.toMatchObject({
      code: 'CREDENTIAL_NOT_FOUND',
    });
    await client.account.delete({ where: { id: f.account } });
    await expect(repository.publishInitial(f.initial, digest(f.first))).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
    expect(await client.vaultOperation.count({ where: { accountId: f.account } })).toBe(0);
  });
});
