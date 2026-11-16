import { Buffer } from 'node:buffer';
import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrdinaryPasswordChange } from '@bunny-talks/contracts';
import type { Prisma, PrismaClient } from '../../../generated/prisma/client.js';
import { loadLocalEnv } from '../../../local-env.mjs';
import * as passwords from '../../../src/auth/password-verifier.js';
import { PostgresReauthentication } from '../../../src/auth/reauthentication/postgres-reauthentication.js';
import { PostgresSessionRepository } from '../../../src/auth/sessions/postgres-session-repository.js';
import { PostgresVaultRepository } from '../../../src/vault/postgres-vault-repository.js';
import { publicationDigest } from '../../../src/vault/publication-digest.js';
import { createTestDatabase } from '../../support/postgres-test-database.js';

loadLocalEnv();
const vector = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../packages/crypto/backup/tests/fixtures/account-vault-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { publication: string };
function publication(account: string, generation: number) {
  const v = JSON.parse(vector.publication);
  v.header.account = account;
  v.manifest.generation = generation;
  for (const field of ['passwordEnvelope', 'recoveryEnvelope']) {
    const e = JSON.parse(v[field]);
    e.header.account = account;
    if (field === 'passwordEnvelope') e.header.revision = generation;
    v[field] = JSON.stringify(e);
  }
  return JSON.stringify(v);
}
const key = createSecretKey(randomBytes(32));
const keys = { activeKeyId: 'grant-test', getKey: () => key };
const digest = (s: string) => publicationDigest(Buffer.from(s));
const encode = (s: string) => Buffer.from(s).toString('base64url');
describe('transactional reauthentication on PostgreSQL 18.7', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let client: PrismaClient;
  let now = Date.UTC(2026, 10, 15);
  const clock = () => new Date(now);
  let oldVerifier: string;
  let newVerifier: string;
  let alternativeVerifier: string;
  let sessions: PostgresSessionRepository;
  let vault: PostgresVaultRepository;
  let service: PostgresReauthentication;
  beforeAll(async () => {
    db = await createTestDatabase();
    client = db.createClient();
    oldVerifier = await passwords.createPasswordVerifier('test-old-password');
    newVerifier = await passwords.createPasswordVerifier('test-new-password');
    alternativeVerifier = await passwords.createPasswordVerifier('test-new-password');
    sessions = new PostgresSessionRepository(client, undefined, clock);
    vault = new PostgresVaultRepository(client, keys);
    service = new PostgresReauthentication(client, vault, clock);
  }, 30000);
  afterAll(async () => {
    await db?.dispose();
  });
  async function fixture(authorized = true) {
    const account = `reauth:${randomUUID()}`;
    await client.account.create({
      data: { id: account, credential: { create: { verifier: oldVerifier } } },
    });
    const initial = publication(account, 1);
    const candidate = publication(account, 2);
    const vaultId = JSON.parse(initial).header.vaultId as string;
    await vault.publishInitial(
      {
        transportVersion: 1,
        account,
        vaultId,
        operationId: randomUUID(),
        expectedCredentialRevision: '1',
        expectedStorageRevision: null,
        publicationBase64Url: encode(initial),
      },
      digest(initial),
    );
    const session = await sessions.createAfterAuthentication(account);
    // Test fixture only: no production device authorization procedure is provided.
    if (authorized)
      await client.device.update({
        where: { id: session.session.deviceId },
        data: { authorizedAt: clock() },
      });
    const request: OrdinaryPasswordChange = {
      transportVersion: 1,
      account,
      vaultId,
      operationId: randomUUID(),
      expected: { storageRevision: '1', credentialRevision: '1' },
      publicationBase64Url: encode(candidate),
    };
    const prepared = {
      verifier: newVerifier,
      candidateDigest: digest(candidate),
      expectedPublicationDigest: digest(initial),
      expectedGeneration: 1,
    };
    const issue = () =>
      service.issuePasswordChange(session.token, 'test-old-password', request, prepared);
    return { account, session, request, prepared, issue };
  }
  async function snapshot(accountId: string) {
    return {
      credential: await client.passwordCredential.findUnique({ where: { accountId } }),
      vault: await client.vaultState.findUnique({ where: { accountId } }),
      publications: await client.vaultPublication.findMany({
        where: { accountId },
        orderBy: { id: 'asc' },
      }),
      receipts: await client.vaultOperation.findMany({
        where: { accountId },
        orderBy: { operationId: 'asc' },
      }),
      grants: await client.reauthenticationGrant.findMany({
        where: { accountId },
        orderBy: { id: 'asc' },
      }),
    };
  }
  it('binds the exact prepared PHC before mutation and after commit', async () => {
    const f = await fixture();
    expect(newVerifier).not.toBe(alternativeVerifier);
    expect(passwords.validatePasswordVerifier(alternativeVerifier)).toBe(true);
    const grant = await f.issue();
    const before = await snapshot(f.account);
    const substitute = { ...f.prepared, verifier: alternativeVerifier };
    await expect(
      service.changePassword(f.session.token, grant, f.request, substitute),
    ).rejects.toThrow('INVALID_GRANT');
    expect(await snapshot(f.account)).toEqual(before);
    const result = await service.changePassword(f.session.token, grant, f.request, f.prepared);
    expect(result.status).toBe('committed');
    expect(
      (await client.passwordCredential.findUniqueOrThrow({ where: { accountId: f.account } }))
        .verifier,
    ).toBe(newVerifier);
    const committed = await snapshot(f.account);
    expect(committed.credential!.verifierUpdatedAt!.getTime()).toBeGreaterThan(
      before.credential!.verifierUpdatedAt!.getTime(),
    );
    expect(await service.changePassword(f.session.token, grant, f.request, f.prepared)).toEqual(
      result,
    );
    await expect(
      service.changePassword(f.session.token, grant, f.request, substitute),
    ).rejects.toThrow('INVALID_GRANT');
    expect(await snapshot(f.account)).toEqual(committed);
  });
  it('refuses pending devices at issuance and rechecks authorization before consumption', async () => {
    const pending = await fixture(false);
    await expect(pending.issue()).rejects.toMatchObject({
      code: 'INVALID_GRANT',
      message: 'INVALID_GRANT',
    });
    expect(
      await client.reauthenticationGrant.count({ where: { accountId: pending.account } }),
    ).toBe(0);
    expect((await sessions.read(pending.session.token)).deviceState).toBe('pending');
    const f = await fixture();
    const grant = await f.issue();
    await client.device.update({
      where: { id: f.session.session.deviceId },
      data: { authorizedAt: null },
    });
    const before = await snapshot(f.account);
    await expect(
      service.changePassword(f.session.token, grant, f.request, f.prepared),
    ).rejects.toMatchObject({ code: 'INVALID_GRANT', message: 'INVALID_GRANT' });
    expect(await snapshot(f.account)).toEqual(before);
    expect((await sessions.read(f.session.token)).deviceState).toBe('pending');
  });
  it.each(['COMMITTED', 'REJECTED'] as const)(
    'recovers a %s receipt without writes using its historical HMAC key',
    async (status) => {
      const f = await fixture();
      if (status === 'REJECTED') f.prepared.expectedGeneration = 2;
      const grant = await f.issue();
      const result = await service.changePassword(f.session.token, grant, f.request, f.prepared);
      expect(result.status.toUpperCase()).toBe(status);
      const rotatedKey = createSecretKey(randomBytes(32));
      const rotatedVault = new PostgresVaultRepository(client, {
        activeKeyId: 'new-test-key',
        getKey: (id) => (id === 'grant-test' ? key : rotatedKey),
      });
      const reader = new PostgresReauthentication(client, rotatedVault, clock);
      const before = await snapshot(f.account);
      expect(await reader.changePassword(f.session.token, grant, f.request, f.prepared)).toEqual(
        result,
      );
      expect(await snapshot(f.account)).toEqual(before);
      await expect(
        client.reauthenticationGrant.update({
          where: { id: grant.split('.')[1]! },
          data: { consumedAt: null },
        }),
      ).rejects.toBeDefined();
      await expect(
        client.reauthenticationGrant.update({
          where: { id: grant.split('.')[1]! },
          data: { intentHash: Buffer.alloc(32, 7) },
        }),
      ).rejects.toBeDefined();
      expect(await snapshot(f.account)).toEqual(before);
    },
  );
  it('refuses missing receipts and never recreates a publication during recovery', async () => {
    const f = await fixture();
    const grant = await f.issue();
    await service.changePassword(f.session.token, grant, f.request, f.prepared);
    await client.vaultOperation.delete({
      where: {
        accountId_operationId: { accountId: f.account, operationId: f.request.operationId },
      },
    });
    const before = await snapshot(f.account);
    await expect(
      service.changePassword(f.session.token, grant, f.request, f.prepared),
    ).rejects.toThrow('OUTCOME_UNKNOWN');
    expect(await snapshot(f.account)).toEqual(before);
  });
  it('checks historical receipt fingerprints and preserves 4.2B mismatch behavior', async () => {
    const f = await fixture();
    const grant = await f.issue();
    await service.changePassword(f.session.token, grant, f.request, f.prepared);
    const changed = vault.preparePasswordChange(f.request, {
      ...f.prepared,
      verifier: alternativeVerifier,
    });
    const before = await snapshot(f.account);
    const mismatch = await client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${f.account} FOR UPDATE`;
      return vault.executeInTransaction(tx, changed, true);
    });
    expect(mismatch).toMatchObject({ status: 'rejected', code: 'IDEMPOTENCY_MISMATCH' });
    expect(await snapshot(f.account)).toEqual(before);
    await client.vaultOperation.update({
      where: {
        accountId_operationId: { accountId: f.account, operationId: f.request.operationId },
      },
      data: { fingerprint: Buffer.alloc(32, 8) },
    });
    const corrupted = await snapshot(f.account);
    expect(
      await service.changePassword(f.session.token, grant, f.request, f.prepared),
    ).toMatchObject({ status: 'rejected', code: 'IDEMPOTENCY_MISMATCH' });
    expect(await snapshot(f.account)).toEqual(corrupted);
  });
  it('commits once, persists only fingerprints and recovers a lost response with a recreated client', async () => {
    const f = await fixture();
    const grant = await f.issue();
    const stored = await client.reauthenticationGrant.findUniqueOrThrow({
      where: { id: grant.split('.')[1]! },
    });
    expect(stored.tokenHash).toHaveLength(32);
    expect(
      JSON.stringify(stored, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toContain(grant);
    const result = await service.changePassword(f.session.token, grant, f.request, f.prepared);
    expect(result.status).toBe('committed');
    const recreatedClient = db.createClient();
    const recreated = new PostgresReauthentication(
      recreatedClient,
      new PostgresVaultRepository(recreatedClient, keys),
      clock,
    );
    expect(await recreated.changePassword(f.session.token, grant, f.request, f.prepared)).toEqual(
      result,
    );
    expect((await sessions.read(f.session.token)).deviceState).toBe('authorized');
    expect(await client.vaultPublication.count({ where: { accountId: f.account } })).toBe(2);
    await expect(
      service.changePassword(
        f.session.token,
        grant,
        { ...f.request, operationId: randomUUID() },
        f.prepared,
      ),
    ).rejects.toThrow();
  });
  it('allows only one mutation with concurrent consumers on different connections', async () => {
    const f = await fixture();
    const grant = await f.issue();
    const otherClient = db.createClient();
    const other = new PostgresReauthentication(
      otherClient,
      new PostgresVaultRepository(otherClient, keys),
      clock,
    );
    const results = await Promise.all([
      service.changePassword(f.session.token, grant, f.request, f.prepared),
      other.changePassword(f.session.token, grant, f.request, f.prepared),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await client.vaultPublication.count({ where: { accountId: f.account } })).toBe(2);
  });
  it('rejects wrong passwords and native failures without issuing grants', async () => {
    const f = await fixture();
    await expect(
      service.issuePasswordChange(f.session.token, 'wrong-secret', f.request, f.prepared),
    ).rejects.toThrow('INVALID_GRANT');
    const mock = vi
      .spyOn(passwords, 'verifyPassword')
      .mockRejectedValueOnce(new passwords.PasswordVerifierError('CRYPTO_UNAVAILABLE'));
    try {
      await expect(f.issue()).rejects.toThrow('CRYPTO_UNAVAILABLE');
    } finally {
      mock.mockRestore();
    }
    expect(await client.reauthenticationGrant.count({ where: { accountId: f.account } })).toBe(0);
  });
  it('rejects a verifier revision changed while the KDF is running', async () => {
    const f = await fixture();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ready = new Promise<void>((r) => {
      reached = r;
    });
    const original = passwords.verifyPassword;
    const mock = vi.spyOn(passwords, 'verifyPassword').mockImplementationOnce(async (p, v) => {
      const valid = await original(p, v);
      reached();
      await gate;
      return valid;
    });
    try {
      const issuing = f.issue();
      await ready;
      await client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${f.account} FOR UPDATE`;
        await tx.passwordCredential.update({
          where: { accountId: f.account },
          data: { revision: 2 },
        });
      });
      release();
      await expect(issuing).rejects.toThrow('INVALID_GRANT');
    } finally {
      release();
      mock.mockRestore();
    }
  });
  it('rejects exact expiry, revised credentials and altered intent', async () => {
    const f = await fixture();
    const grant = await f.issue();
    await expect(
      service.changePassword(
        f.session.token,
        grant,
        { ...f.request, operationId: randomUUID() },
        f.prepared,
      ),
    ).rejects.toThrow();
    await expect(
      service.changePassword(f.session.token, grant, f.request, {
        ...f.prepared,
        expectedGeneration: 2,
      }),
    ).rejects.toThrow();
    now += 300000;
    await expect(
      service.changePassword(f.session.token, grant, f.request, f.prepared),
    ).rejects.toThrow('INVALID_GRANT');
    const g = await fixture();
    const token = await g.issue();
    await client.passwordCredential.update({
      where: { accountId: g.account },
      data: { revision: 2 },
    });
    await expect(
      service.changePassword(g.session.token, token, g.request, g.prepared),
    ).rejects.toThrow('INVALID_GRANT');
  });
  it('rejects malformed tokens, wrong secrets, unsupported kinds and expired sessions', async () => {
    const f = await fixture();
    const grant = await f.issue();
    const wrongSecret = grant.slice(0, 40) + Buffer.alloc(32, 7).toString('base64url');
    await expect(
      service.changePassword(f.session.token, wrongSecret, f.request, f.prepared),
    ).rejects.toMatchObject({ code: 'INVALID_GRANT', message: 'INVALID_GRANT' });
    for (const value of [null, grant.split('.')[1], grant + '=']) {
      await expect(
        service.changePassword(f.session.token, value, f.request, f.prepared),
      ).rejects.toThrow();
    }
    await expect(
      service.issuePasswordChange(
        f.session.token,
        'test-old-password',
        { ...f.request, kind: 'device-revocation' },
        f.prepared,
      ),
    ).rejects.toThrow('INVALID_INTENT');
    await client.session.update({
      where: { id: f.session.session.id },
      data: { expiresAt: new Date(now + 1) },
    });
    now += 1;
    await expect(
      service.changePassword(f.session.token, grant, f.request, f.prepared),
    ).rejects.toMatchObject({ code: 'INVALID_SESSION', message: 'INVALID_SESSION' });
  });
  it('keeps durable business rejection and consumption in one commit', async () => {
    const f = await fixture();
    f.prepared.expectedGeneration = 2;
    const grant = await f.issue();
    const result = await service.changePassword(f.session.token, grant, f.request, f.prepared);
    expect(result.status).toBe('rejected');
    expect(
      (
        await client.reauthenticationGrant.findUniqueOrThrow({
          where: { id: grant.split('.')[1]! },
        })
      ).consumedAt,
    ).not.toBeNull();
    expect(await service.changePassword(f.session.token, grant, f.request, f.prepared)).toEqual(
      result,
    );
    expect(await client.vaultPublication.count({ where: { accountId: f.account } })).toBe(1);
  });
  it('rejects grant reassignment in SQL and competing operations', async () => {
    const f = await fixture();
    const grant = await f.issue();
    const otherClient = db.createClient();
    await expect(
      client.reauthenticationGrant.update({
        where: { id: grant.split('.')[1]! },
        data: { operationId: randomUUID() },
      }),
    ).rejects.toBeDefined();
    const other = new PostgresReauthentication(
      otherClient,
      new PostgresVaultRepository(otherClient, keys),
      clock,
    );
    const results = await Promise.allSettled([
      service.changePassword(f.session.token, grant, f.request, f.prepared),
      other.changePassword(
        f.session.token,
        grant,
        { ...f.request, operationId: randomUUID() },
        f.prepared,
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await client.vaultPublication.count({ where: { accountId: f.account } })).toBe(2);
  });
  it('rejects another session or account and revoked sessions or devices', async () => {
    const f = await fixture();
    const grant = await f.issue();
    const sameDevice = await sessions.createAfterAuthentication(
      f.account,
      f.session.session.deviceId,
    );
    const other = await fixture();
    for (const token of [sameDevice.token, other.session.token])
      await expect(service.changePassword(token, grant, f.request, f.prepared)).rejects.toThrow();
    await sessions.revokeSession(f.session.token, f.session.session.id);
    await expect(
      service.changePassword(f.session.token, grant, f.request, f.prepared),
    ).rejects.toMatchObject({ code: 'INVALID_SESSION', message: 'INVALID_SESSION' });
    const g = await fixture();
    const gtoken = await g.issue();
    await sessions.revokeDevicesAfterAuthorization(g.account, [g.session.session.deviceId]);
    await expect(
      service.changePassword(g.session.token, gtoken, g.request, g.prepared),
    ).rejects.toMatchObject({ code: 'INVALID_SESSION', message: 'INVALID_SESSION' });
  });
  it('rolls back grant consumption, receipt and mutation when failure precedes commit', async () => {
    const f = await fixture();
    const grant = await f.issue();
    const broken = new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === '$transaction')
          return async (
            work: (tx: Prisma.TransactionClient) => Promise<unknown>,
            options: object,
          ) =>
            target.$transaction(async (tx) => {
              await work(tx);
              throw new Error('test-secret-failure');
            }, options);
        return Reflect.get(target, prop, receiver);
      },
    });
    const interrupted = new PostgresReauthentication(broken, vault, clock);
    await expect(
      interrupted.changePassword(f.session.token, grant, f.request, f.prepared),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', message: 'OUTCOME_UNKNOWN' });
    expect(
      (
        await client.reauthenticationGrant.findUniqueOrThrow({
          where: { id: grant.split('.')[1]! },
        })
      ).consumedAt,
    ).toBeNull();
    expect(
      await client.vaultOperation.count({
        where: { accountId: f.account, operationId: f.request.operationId },
      }),
    ).toBe(0);
    expect(await client.vaultPublication.count({ where: { accountId: f.account } })).toBe(1);
    expect(
      (await service.changePassword(f.session.token, grant, f.request, f.prepared)).status,
    ).toBe('committed');
  });
  it.each(['session', 'device', 'authorization', 'expiration'] as const)(
    'serializes consumption after concurrent %s invalidation',
    async (kind) => {
      const f = await fixture();
      const grant = await f.issue();
      let release!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const ready = new Promise<void>((r) => {
        reached = r;
      });
      const blocking = client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${f.account} FOR UPDATE`;
        if (kind === 'session')
          await tx.session.update({
            where: { id: f.session.session.id },
            data: { revokedAt: clock() },
          });
        if (kind === 'device')
          await tx.device.update({
            where: { id: f.session.session.deviceId },
            data: { revokedAt: clock() },
          });
        if (kind === 'authorization')
          await tx.device.update({
            where: { id: f.session.session.deviceId },
            data: { authorizedAt: null },
          });
        reached();
        await gate;
      });
      await ready;
      const consuming = service.changePassword(f.session.token, grant, f.request, f.prepared).then(
        () => true,
        () => false,
      );
      await delay(50);
      if (kind === 'expiration') now += 300000;
      release();
      await blocking;
      expect(await consuming).toBe(false);
    },
  );
});
