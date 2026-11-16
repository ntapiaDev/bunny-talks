import { Buffer } from 'node:buffer';
import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InitialVaultPublication } from '@bunny-talks/contracts';
import type { Prisma, PrismaClient } from '../../../generated/prisma/client.js';
import { loadLocalEnv } from '../../../local-env.mjs';
import { PostgresInitialDeviceBootstrap } from '../../../src/auth/bootstrap/postgres-initial-device-bootstrap.js';
import * as passwords from '../../../src/auth/password-verifier.js';
import { PostgresSessionRepository } from '../../../src/auth/sessions/postgres-session-repository.js';
import { generateSessionToken } from '../../../src/auth/sessions/session-token.js';
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
) as { publication: string; context: { vaultId: string } };
const key = createSecretKey(randomBytes(32));
const keys = {
  activeKeyId: 'test-bootstrap',
  getKey: (id: string) => (id === 'test-bootstrap' ? key : undefined),
};
const password = 'bootstrap-test-password';
const encode = (value: string) => Buffer.from(value).toString('base64url');
const digest = (value: string) => publicationDigest(Buffer.from(value));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Structural fixtures do not claim a valid MAC, decryption or possession of an E2EE identity.
function publication(account: string, generation = 1) {
  const v = JSON.parse(vector.publication) as {
    header: { account: string };
    manifest: { generation: number };
    passwordEnvelope: string;
    recoveryEnvelope: string;
  };
  v.header.account = account;
  v.manifest.generation = generation;
  for (const name of ['passwordEnvelope', 'recoveryEnvelope'] as const) {
    const e = JSON.parse(v[name]) as { header: { account: string; revision: number } };
    e.header.account = account;
    if (name === 'passwordEnvelope') e.header.revision = generation;
    v[name] = JSON.stringify(e);
  }
  return JSON.stringify(v);
}

/** Injection wraps a real transaction; only activation transactions are intercepted. */
function intercept(
  client: PrismaClient,
  accountId: string,
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
          let activated = false;
          const result = await target.$transaction(async (tx) => {
            const value = await work(tx);
            activated = (await tx.initialBootstrapOperation.count({ where: { accountId } })) > 0;
            if (activated) await afterWork(tx);
            return value;
          }, options);
          if (activated) afterCommit?.();
          return result;
        };
      return Reflect.get(target, property, receiver);
    },
  });
}

describe('first-device bootstrap on real PostgreSQL 18.7', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let client: PrismaClient;
  let vault: PostgresVaultRepository;
  let sessions: PostgresSessionRepository;
  let service: PostgresInitialDeviceBootstrap;
  let verifier: string;
  let now = Date.now();
  const clock = () => new Date(now);
  beforeAll(async () => {
    db = await createTestDatabase();
    client = db.createClient();
    vault = new PostgresVaultRepository(client, keys);
    sessions = new PostgresSessionRepository(client, undefined, clock);
    service = new PostgresInitialDeviceBootstrap(client, vault, clock);
    verifier = await passwords.createPasswordVerifier(password);
  }, 30_000);
  afterAll(async () => {
    await db?.dispose();
  });

  async function fixture() {
    const account = randomUUID();
    await client.account.create({
      data: {
        id: account,
        credential: { create: { verifier } },
        emailIdentity: {
          create: {
            canonical: `${account}@example.com`,
            display: `${account}@example.com`,
            verifiedAt: clock(),
          },
        },
      },
    });
    const session = await sessions.createAfterAuthentication(account);
    const text = publication(account);
    const request: InitialVaultPublication = {
      transportVersion: 1,
      account,
      vaultId: vector.context.vaultId,
      operationId: randomUUID(),
      expectedStorageRevision: null,
      expectedCredentialRevision: '1',
      publicationBase64Url: encode(text),
    };
    return {
      account,
      session,
      text,
      request,
      digest: digest(text),
      activate: () => service.activate(session.token, password, request, digest(text)),
      recover: () => service.recoverReceipt(session.token, request, digest(text)),
    };
  }
  async function snapshot(accountId: string) {
    return {
      vault: await client.vaultState.findUnique({ where: { accountId } }),
      publications: await client.vaultPublication.findMany({
        where: { accountId },
        orderBy: { id: 'asc' },
      }),
      receipts: await client.vaultOperation.findMany({
        where: { accountId },
        orderBy: { operationId: 'asc' },
      }),
      bindings: await client.initialBootstrapOperation.findMany({
        where: { accountId },
        orderBy: { operationId: 'asc' },
      }),
      devices: await client.device.findMany({ where: { accountId }, orderBy: { id: 'asc' } }),
      sessions: await client.session.findMany({ where: { accountId }, orderBy: { id: 'asc' } }),
      credential: await client.passwordCredential.findUnique({ where: { accountId } }),
    };
  }
  async function waitForLock(name: string) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const rows = await db.admin.$queryRaw<
        { waiting: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = ${name} AND wait_event_type = 'Lock') AS waiting`;
      if (rows[0]?.waiting) return;
      await delay(5);
    }
    throw new Error('Expected PostgreSQL lock wait was not observed');
  }

  it('activates a verified new account atomically, preserving exact bytes and all sessions', async () => {
    const f = await fixture();
    const other = await sessions.createAfterAuthentication(f.account);
    const before = await snapshot(f.account);
    expect((await sessions.read(f.session.token)).deviceState).toBe('pending');
    const result = await f.activate();
    expect(result).toMatchObject({
      status: 'committed',
      cas: { storageRevision: '1', credentialRevision: '1' },
      publicationDigest: f.digest,
    });
    const after = await snapshot(f.account);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.credential).toEqual(before.credential);
    expect(after.publications).toHaveLength(1);
    expect(Buffer.from(after.publications[0]!.bytes)).toEqual(Buffer.from(f.text));
    expect(after.bindings).toEqual([
      {
        accountId: f.account,
        operationId: f.request.operationId,
        deviceId: f.session.session.deviceId,
      },
    ]);
    expect(after.receipts[0]!.status).toBe('COMMITTED');
    expect((await sessions.read(f.session.token)).deviceState).toBe('authorized');
    expect((await sessions.read(other.token)).deviceState).toBe('pending');
    expect(await vault.readActive(f.account)).toMatchObject({
      publicationBase64Url: f.request.publicationBase64Url,
    });
  });

  it.each(['unverified', 'future-verification', 'missing-verifier', 'wrong-password'] as const)(
    'rejects %s without any mutation',
    async (kind) => {
      const f = await fixture();
      if (kind === 'unverified')
        await client.emailIdentity.delete({ where: { accountId: f.account } });
      if (kind === 'future-verification')
        await client.emailIdentity.update({
          where: { accountId: f.account },
          data: { verifiedAt: new Date(now + 1) },
        });
      if (kind === 'missing-verifier')
        await client.passwordCredential.delete({ where: { accountId: f.account } });
      const before = await snapshot(f.account);
      await expect(
        service.activate(
          f.session.token,
          kind === 'wrong-password' ? 'wrong' : password,
          f.request,
          f.digest,
        ),
      ).rejects.toMatchObject({
        code: 'INVALID_AUTHENTICATION',
        message: 'INVALID_AUTHENTICATION',
      });
      expect(await snapshot(f.account)).toEqual(before);
    },
  );

  it.each([
    'absent',
    'unknown',
    'wrong-secret',
    'expired',
    'idle',
    'session-revoked',
    'device-revoked',
  ] as const)('rejects a %s session before authorization', async (kind) => {
    const f = await fixture();
    let token: unknown = f.session.token;
    if (kind === 'absent') token = undefined;
    if (kind === 'unknown') token = generateSessionToken().token;
    if (kind === 'wrong-secret')
      token = f.session.token.slice(0, 40) + randomBytes(32).toString('base64url');
    if (kind === 'expired')
      await client.session.update({
        where: { id: f.session.session.id },
        data: { expiresAt: new Date(now + 1) },
      });
    if (kind === 'expired') now++;
    if (kind === 'idle') now += 7 * 86400000;
    if (kind === 'session-revoked') await sessions.revokeSession(token, f.session.session.id);
    if (kind === 'device-revoked')
      await sessions.revokeDevicesAfterAuthorization(f.account, [f.session.session.deviceId]);
    const before = await snapshot(f.account);
    for (const work of [
      () => service.activate(token, password, f.request, f.digest),
      () => service.recoverReceipt(token, f.request, f.digest),
    ]) {
      await expect(work()).rejects.toMatchObject({
        code: 'INVALID_SESSION',
        message: 'INVALID_SESSION',
      });
    }
    expect(await snapshot(f.account)).toEqual(before);
  });

  it('sanitizes a native Argon2id failure without receipts or authorization', async () => {
    const f = await fixture();
    const before = await snapshot(f.account);
    const mock = vi
      .spyOn(passwords, 'verifyPassword')
      .mockRejectedValueOnce(new passwords.PasswordVerifierError('CRYPTO_UNAVAILABLE'));
    try {
      await expect(f.activate()).rejects.toMatchObject({
        code: 'CRYPTO_UNAVAILABLE',
        message: 'CRYPTO_UNAVAILABLE',
      });
    } finally {
      mock.mockRestore();
    }
    expect(await snapshot(f.account)).toEqual(before);
  });

  it.each(['revision', 'verifier', 'session', 'device', 'email', 'stale-password-check'] as const)(
    'revalidates %s changed during the real KDF outside a transaction',
    async (kind) => {
      const f = await fixture();
      const entered = gate();
      const release = gate();
      const original = passwords.verifyPassword;
      const mock = vi.spyOn(passwords, 'verifyPassword').mockImplementationOnce(async (p, v) => {
        const valid = await original(p, v);
        entered.resolve();
        await release.promise;
        return valid;
      });
      const attempt = f.activate();
      const outcome = expect(attempt).rejects.toThrow();
      try {
        await entered.promise;
        // A separate connection acquires the same account lock while the KDF is suspended.
        const replacement =
          kind === 'verifier' ? await passwords.createPasswordVerifier(password) : verifier;
        await db.createClient().$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${f.account} FOR UPDATE`;
          if (kind === 'revision')
            await tx.passwordCredential.update({
              where: { accountId: f.account },
              data: { revision: 2 },
            });
          if (kind === 'verifier')
            await tx.passwordCredential.update({
              where: { accountId: f.account },
              data: { verifier: replacement },
            });
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
          if (kind === 'email') await tx.emailIdentity.delete({ where: { accountId: f.account } });
        });
        if (kind === 'stale-password-check') now += 300000;
        const before = await snapshot(f.account);
        release.resolve();
        await outcome;
        expect(await snapshot(f.account)).toEqual(before);
      } finally {
        release.resolve();
        mock.mockRestore();
      }
    },
  );

  it.each(['malformed', 'digest', 'context', 'account', 'revision-format'] as const)(
    'rejects invalid candidate %s without a durable receipt',
    async (kind) => {
      const f = await fixture();
      const request = { ...f.request };
      let candidateDigest = f.digest;
      if (kind === 'malformed') {
        request.publicationBase64Url = encode('{}');
        candidateDigest = digest('{}');
      }
      if (kind === 'digest') candidateDigest = randomBytes(32).toString('base64url');
      if (kind === 'context') request.vaultId = randomBytes(16).toString('base64url');
      if (kind === 'account') request.account = randomUUID();
      if (kind === 'revision-format') request.expectedCredentialRevision = '01';
      const before = await snapshot(f.account);
      await expect(
        service.activate(f.session.token, password, request, candidateDigest),
      ).rejects.toThrow();
      expect(await snapshot(f.account)).toEqual(before);
    },
  );

  it.each(['credential-revision', 'crypto-revision'] as const)(
    'persists a %s business rejection and allows a correctly prepared new attempt',
    async (kind) => {
      const f = await fixture();
      const text = kind === 'crypto-revision' ? publication(f.account, 2) : f.text;
      const request = {
        ...f.request,
        expectedCredentialRevision: kind === 'credential-revision' ? '2' : '1',
        publicationBase64Url: encode(text),
      };
      const result = await service.activate(f.session.token, password, request, digest(text));
      expect(result).toMatchObject({
        status: 'rejected',
        code: kind === 'credential-revision' ? 'VERSION_CONFLICT' : 'INVALID_TRANSITION',
      });
      const before = await snapshot(f.account);
      expect(before.vault).toBeNull();
      expect(before.publications).toHaveLength(0);
      expect(before.devices[0]!.authorizedAt).toBeNull();
      expect(before.bindings).toHaveLength(1);
      expect(await service.recoverReceipt(f.session.token, request, digest(text))).toEqual(result);
      expect(await service.activate(f.session.token, password, request, digest(text))).toEqual(
        result,
      );
      expect(await snapshot(f.account)).toEqual(before);
      const next = { ...f.request, operationId: randomUUID() };
      expect(await service.activate(f.session.token, password, next, f.digest)).toMatchObject({
        status: 'committed',
      });
      expect(await service.recoverReceipt(f.session.token, request, digest(text))).toEqual(result);
    },
  );

  it('recovers the exact committed receipt after lost response and client recreation without writes or KDF', async () => {
    const f = await fixture();
    const result = await f.activate();
    const before = await snapshot(f.account);
    const recreated = db.createClient();
    const recovering = new PostgresInitialDeviceBootstrap(
      recreated,
      new PostgresVaultRepository(recreated, keys),
      clock,
    );
    const mock = vi.spyOn(passwords, 'verifyPassword');
    try {
      expect(await recovering.recoverReceipt(f.session.token, f.request, f.digest)).toEqual(result);
      expect(mock).not.toHaveBeenCalled();
    } finally {
      mock.mockRestore();
    }
    expect(await snapshot(f.account)).toEqual(before);
    expect(await f.activate()).toEqual(result);
    expect(await snapshot(f.account)).toEqual(before);
  });

  it('uses current authentication for recovery after password change and session renewal on the same device', async () => {
    const f = await fixture();
    const result = await f.activate();
    await client.passwordCredential.update({
      where: { accountId: f.account },
      data: { revision: 2 },
    });
    const renewed = await sessions.createAfterAuthentication(f.account, f.session.session.deviceId);
    await sessions.revokeSession(f.session.token, f.session.session.id);
    await expect(f.recover()).rejects.toThrow('INVALID_SESSION');
    expect(await service.recoverReceipt(renewed.token, f.request, f.digest)).toEqual(result);
  });

  it('never creates an absent receipt through the recovery path, before or after activation', async () => {
    const f = await fixture();
    for (const active of [false, true]) {
      if (active) await f.activate();
      const before = await snapshot(f.account);
      expect(
        await service.recoverReceipt(
          f.session.token,
          { ...f.request, operationId: randomUUID() },
          f.digest,
        ),
      ).toEqual({ transportVersion: 1, status: 'unknown' });
      expect(await snapshot(f.account)).toEqual(before);
    }
  });

  it('requires identical request identity and bytes, and cannot restart with a new operation', async () => {
    const f = await fixture();
    await f.activate();
    const before = await snapshot(f.account);
    for (const changed of [
      { request: { ...f.request, expectedCredentialRevision: '2' }, digest: f.digest },
      {
        request: { ...f.request, publicationBase64Url: encode(publication(f.account, 2)) },
        digest: digest(publication(f.account, 2)),
      },
    ]) {
      expect(
        await service.recoverReceipt(f.session.token, changed.request, changed.digest),
      ).toMatchObject({ status: 'rejected', code: 'IDEMPOTENCY_MISMATCH' });
      expect(
        await service.activate(f.session.token, password, changed.request, changed.digest),
      ).toMatchObject({ status: 'rejected', code: 'IDEMPOTENCY_MISMATCH' });
    }
    await expect(
      service.activate(
        f.session.token,
        password,
        { ...f.request, operationId: randomUUID() },
        f.digest,
      ),
    ).rejects.toThrow('NOT_ELIGIBLE');
    expect(await snapshot(f.account)).toEqual(before);
  });

  it.each([false, true])(
    'prevents receipt appropriation by another device (committed=%s)',
    async (committed) => {
      const f = await fixture();
      if (!committed) f.request = { ...f.request, expectedCredentialRevision: '2' };
      await service.activate(f.session.token, password, f.request, f.digest);
      const other = await sessions.createAfterAuthentication(f.account);
      const before = await snapshot(f.account);
      await expect(service.recoverReceipt(other.token, f.request, f.digest)).rejects.toThrow(
        'REPLAY_FORBIDDEN',
      );
      await expect(service.activate(other.token, password, f.request, f.digest)).rejects.toThrow(
        'REPLAY_FORBIDDEN',
      );
      expect(await snapshot(f.account)).toEqual(before);
    },
  );

  it('refuses rebootstrap after all devices are revoked and a new pending device logs in', async () => {
    const f = await fixture();
    await f.activate();
    await sessions.revokeDevicesAfterAuthorization(f.account, [f.session.session.deviceId]);
    const next = await sessions.createAfterAuthentication(f.account);
    const before = await snapshot(f.account);
    await expect(f.recover()).rejects.toThrow('INVALID_SESSION');
    await expect(f.activate()).rejects.toThrow('INVALID_SESSION');
    await expect(
      service.activate(next.token, password, { ...f.request, operationId: randomUUID() }, f.digest),
    ).rejects.toThrow('NOT_ELIGIBLE');
    expect((await sessions.read(next.token)).deviceState).toBe('pending');
    expect(await snapshot(f.account)).toEqual(before);
  });

  it.each([
    'vault',
    'publication-history',
    'success-receipt',
    'authorized-device',
    'revoked-authorized-device',
  ] as const)('fails closed on historical %s without an identifiable bootstrap', async (kind) => {
    const f = await fixture();
    if (['vault', 'publication-history', 'success-receipt'].includes(kind)) {
      await vault.publishInitial(f.request, f.digest);
      if (kind !== 'vault') await client.vaultState.delete({ where: { accountId: f.account } });
      if (kind === 'success-receipt')
        await client.vaultPublication.deleteMany({ where: { accountId: f.account } });
    } else {
      await client.device.update({
        where: { id: f.session.session.deviceId },
        data: { authorizedAt: clock() },
      });
      if (kind === 'revoked-authorized-device') {
        await sessions.revokeDevicesAfterAuthorization(f.account, [f.session.session.deviceId]);
        f.session = await sessions.createAfterAuthentication(f.account);
      }
    }
    const before = await snapshot(f.account);
    await expect(
      service.activate(
        f.session.token,
        password,
        { ...f.request, operationId: randomUUID() },
        f.digest,
      ),
    ).rejects.toThrow('HISTORICAL_STATE');
    if (kind === 'vault') await expect(f.recover()).rejects.toThrow('HISTORICAL_STATE');
    expect(await snapshot(f.account)).toEqual(before);
  });

  it.each([
    'different-operation',
    'same-operation-different-bytes',
    'same-device-exact-replay',
    'same-device-different-bytes',
  ] as const)('serializes real competing activations: %s', async (kind) => {
    const f = await fixture();
    const other = kind.startsWith('same-device-')
      ? f.session
      : await sessions.createAfterAuthentication(f.account);
    const entered = gate();
    const release = gate();
    const first = new PostgresInitialDeviceBootstrap(
      intercept(db.createClient(), f.account, async () => {
        entered.resolve();
        await release.promise;
      }),
      vault,
      clock,
    );
    const name = `bootstrap-race-${randomUUID()}`;
    const competing = new PostgresInitialDeviceBootstrap(db.createClient(name), vault, clock);
    const secondText = kind.endsWith('different-bytes') ? publication(f.account, 2) : f.text;
    const secondRequest = {
      ...f.request,
      operationId: kind === 'different-operation' ? randomUUID() : f.request.operationId,
      publicationBase64Url: encode(secondText),
    };
    const firstKdf = gate();
    const secondKdf = gate();
    const releaseFirstKdf = gate();
    const releaseSecondKdf = gate();
    const original = passwords.verifyPassword;
    const mock = vi
      .spyOn(passwords, 'verifyPassword')
      .mockImplementationOnce(async (p, v) => {
        const valid = await original(p, v);
        firstKdf.resolve();
        await releaseFirstKdf.promise;
        return valid;
      })
      .mockImplementationOnce(async (p, v) => {
        const valid = await original(p, v);
        secondKdf.resolve();
        await releaseSecondKdf.promise;
        return valid;
      });
    const a = first.activate(f.session.token, password, f.request, f.digest);
    let settled:
      | Promise<{ value: Awaited<ReturnType<typeof competing.activate>> | null; error: unknown }>
      | undefined;
    try {
      await firstKdf.promise;
      const b = competing.activate(other.token, password, secondRequest, digest(secondText));
      settled = b.then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
      await secondKdf.promise;
      // Both devices have completed real Argon2id before either activation transaction starts.
      releaseFirstKdf.resolve();
      await entered.promise;
      releaseSecondKdf.resolve();
      await waitForLock(name);
      release.resolve();
      const result = await a;
      const second = await settled;
      expect(result.status).toBe('committed');
      if (kind === 'same-device-exact-replay') expect(second.value).toEqual(result);
      else if (kind === 'same-device-different-bytes')
        expect(second.value).toMatchObject({ status: 'rejected', code: 'IDEMPOTENCY_MISMATCH' });
      else
        expect(second.error).toMatchObject({
          code: kind === 'different-operation' ? 'NOT_ELIGIBLE' : 'REPLAY_FORBIDDEN',
        });
      const after = await snapshot(f.account);
      expect(after.publications).toHaveLength(1);
      expect(after.bindings).toHaveLength(1);
      expect(after.devices.filter((d) => d.authorizedAt !== null)).toHaveLength(1);
      if (other !== f.session)
        expect((await sessions.read(other.token)).deviceState).toBe('pending');
      // Discard the original response and recover the first success.
      expect(await f.recover()).toEqual(result);
    } finally {
      releaseFirstKdf.resolve();
      releaseSecondKdf.resolve();
      release.resolve();
      await a.catch(() => undefined);
      await settled;
      mock.mockRestore();
    }
  });

  it('classifies two candidates with the same operation on the same device without replacing the first', async () => {
    const f = await fixture();
    await f.activate();
    const before = await snapshot(f.account);
    expect(
      await service.activate(
        f.session.token,
        password,
        { ...f.request, publicationBase64Url: encode(publication(f.account, 2)) },
        digest(publication(f.account, 2)),
      ),
    ).toMatchObject({ status: 'rejected', code: 'IDEMPOTENCY_MISMATCH' });
    expect(await snapshot(f.account)).toEqual(before);
  });

  it.each(['before-commit', 'after-commit'] as const)(
    'handles injected %s failure without assuming rollback',
    async (kind) => {
      const f = await fixture();
      const before = await snapshot(f.account);
      const fail = () => {
        throw new Error(`${password}:private-fixture-failure`);
      };
      const broken = intercept(
        db.createClient(),
        f.account,
        async () => {
          if (kind === 'before-commit') fail();
        },
        kind === 'after-commit' ? fail : undefined,
      );
      const interrupted = new PostgresInitialDeviceBootstrap(broken, vault, clock);
      await expect(
        interrupted.activate(f.session.token, password, f.request, f.digest),
      ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', message: 'OUTCOME_UNKNOWN' });
      if (kind === 'before-commit') {
        expect(await snapshot(f.account)).toEqual(before);
        expect(await f.recover()).toMatchObject({ status: 'unknown' });
        expect(await f.activate()).toMatchObject({ status: 'committed' });
      } else {
        const after = await snapshot(f.account);
        expect(after.vault).not.toBeNull();
        expect(after.devices[0]!.authorizedAt).not.toBeNull();
        expect(await f.recover()).toMatchObject({ status: 'committed' });
        expect(await f.activate()).toMatchObject({ status: 'committed' });
        expect(await snapshot(f.account)).toEqual(after);
      }
    },
  );

  it('retains immutable device bindings and receipts without passwords, tokens or secret error details', async () => {
    const f = await fixture();
    await f.activate();
    const other = await sessions.createAfterAuthentication(f.account);
    const where = {
      accountId_operationId: { accountId: f.account, operationId: f.request.operationId },
    };
    await expect(
      client.initialBootstrapOperation.update({
        where,
        data: { deviceId: other.session.deviceId },
      }),
    ).rejects.toBeDefined();
    await expect(client.initialBootstrapOperation.delete({ where })).rejects.toBeDefined();
    await expect(client.vaultOperation.delete({ where })).rejects.toBeDefined();
    await expect(
      client.vaultOperation.update({ where, data: { fingerprintKeyId: 'substituted' } }),
    ).rejects.toBeDefined();
    const stored = await snapshot(f.account);
    const serialized = JSON.stringify(
      { receipts: stored.receipts, bindings: stored.bindings },
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    );
    for (const secret of [password, verifier, f.session.token, 'private-fixture-failure'])
      expect(serialized).not.toContain(secret);
  });

  it('rejects a session from another verified account and registration-style identifiers', async () => {
    const f = await fixture();
    const other = await fixture();
    const before = await snapshot(f.account);
    for (const token of [
      f.account,
      f.session.session.deviceId,
      { status: 'account-created', accountId: f.account },
    ]) {
      await expect(service.activate(token, password, f.request, f.digest)).rejects.toThrow(
        'INVALID_SESSION',
      );
    }
    await expect(
      service.activate(other.session.token, password, f.request, f.digest),
    ).rejects.toThrow('INVALID_AUTHENTICATION');
    await expect(service.recoverReceipt(other.session.token, f.request, f.digest)).rejects.toThrow(
      'INVALID_SESSION',
    );
    expect(await snapshot(f.account)).toEqual(before);
  });

  it('preserves the irreversible success independently of active vault and device flags', async () => {
    const f = await fixture();
    const result = await f.activate();
    // Simulate maintenance losing mutable state, without deleting immutable history.
    await client.vaultState.delete({ where: { accountId: f.account } });
    await client.vaultPublication.deleteMany({ where: { accountId: f.account } });
    await client.device.update({
      where: { id: f.session.session.deviceId },
      data: { authorizedAt: null },
    });
    const before = await snapshot(f.account);
    expect(await f.recover()).toEqual(result);
    expect(await f.activate()).toEqual(result);
    expect((await sessions.read(f.session.token)).deviceState).toBe('pending');
    await expect(
      service.activate(
        f.session.token,
        password,
        { ...f.request, operationId: randomUUID() },
        f.digest,
      ),
    ).rejects.toThrow('NOT_ELIGIBLE');
    expect(await snapshot(f.account)).toEqual(before);
  });

  it('enforces receipt kind, account/device binding and single-success insertion in SQL', async () => {
    const f = await fixture();
    await f.activate();
    const other = await fixture();
    const stored = await client.vaultOperation.findUniqueOrThrow({
      where: {
        accountId_operationId: { accountId: f.account, operationId: f.request.operationId },
      },
    });
    const secondId = randomUUID();
    await client.vaultOperation.create({ data: { ...stored, operationId: secondId } });
    await expect(
      client.initialBootstrapOperation.create({
        data: { accountId: f.account, operationId: secondId, deviceId: f.session.session.deviceId },
      }),
    ).rejects.toBeDefined();
    const rejectedId = randomUUID();
    await client.vaultOperation.create({
      data: {
        ...stored,
        operationId: rejectedId,
        status: 'REJECTED',
        resultStorageRevision: null,
        resultCredentialRevision: null,
        publicationDigest: null,
        rejectionCode: 'VERSION_CONFLICT',
      },
    });
    await expect(
      client.initialBootstrapOperation.create({
        data: {
          accountId: f.account,
          operationId: rejectedId,
          deviceId: other.session.session.deviceId,
        },
      }),
    ).rejects.toBeDefined();
    const passwordChangeId = randomUUID();
    await client.vaultOperation.create({
      data: {
        ...stored,
        operationId: passwordChangeId,
        kind: 'ordinary-password-change',
        expectedStorageRevision: 1,
      },
    });
    await expect(
      client.initialBootstrapOperation.create({
        data: {
          accountId: f.account,
          operationId: passwordChangeId,
          deviceId: f.session.session.deviceId,
        },
      }),
    ).rejects.toBeDefined();
    expect(await client.initialBootstrapOperation.count({ where: { accountId: f.account } })).toBe(
      1,
    );
  });

  it('uses historical HMAC keys and fails closed when they are unavailable', async () => {
    const f = await fixture();
    const result = await f.activate();
    const rotatedKey = createSecretKey(randomBytes(32));
    for (const available of [true, false]) {
      const rotated = new PostgresVaultRepository(client, {
        activeKeyId: 'rotated',
        getKey: (id) =>
          id === 'rotated' ? rotatedKey : available && id === keys.activeKeyId ? key : undefined,
      });
      const recovering = new PostgresInitialDeviceBootstrap(client, rotated, clock);
      if (available)
        expect(await recovering.recoverReceipt(f.session.token, f.request, f.digest)).toEqual(
          result,
        );
      else
        await expect(
          recovering.recoverReceipt(f.session.token, f.request, f.digest),
        ).rejects.toThrow('KEY_UNAVAILABLE');
    }
  });
});
