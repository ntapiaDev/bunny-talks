import { describe, expect, it } from 'vitest';
import { createBootstrapOperationPersistence } from '../src/composition/bootstrap-operation-persistence';
import { prepareInitialBootstrap } from '../src/composition/initial-device-bootstrap';
import type { BootstrapOperationMetadataStore } from '../src/infrastructure/crypto/bootstrap-operation-metadata';

const context = {
  account: 'account-fixture',
  device: 'd8c49125-e0fb-4a9e-bdc2-09c57ad4382a',
  vaultId: 'AQEBAQEBAQEBAQEBAQEBAQ',
  sessionId: 'cbbbf3b9-b6e3-41a2-8c6c-bbe37186625f',
};
const session = {
  accountId: context.account,
  sessionId: context.sessionId,
  deviceId: context.device,
  deviceState: 'pending' as const,
  expiresAt: '2026-12-16T12:00:00.000Z',
  credentialRevision: '17',
};
const publication = new TextEncoder().encode('{"encrypted":"candidate"}');

async function prepared(operationId = '77c612cf-753d-455a-9862-69059bab610a') {
  return prepareInitialBootstrap({
    account: context.account,
    vaultId: context.vaultId,
    operationId,
    expectedCredentialRevision: session.credentialRevision,
    publicationBytes: publication,
    recoveryKey: new Uint8Array(32).fill(8),
    recoveryVerifier: {
      async verifyRecoveryKey() {
        return {
          method: 'account-vault-v1-recovery-open',
          account: context.account,
          vaultId: context.vaultId,
          publicationDigest: 'gxik29tbMYkScanPmMNToC6zj3tkvKgSdIMOhsPg52w',
          recoveryRevision: 1,
        } as const;
      },
    },
    recoveryBackupConfirmation: {
      async confirmRecoveryBackup(input) {
        return { kind: 'user-confirmed-independent-recovery-backup', ...input } as const;
      },
    },
  });
}

function storage(): BootstrapOperationMetadataStore {
  let raw: string | null = null;
  return {
    assertAvailable() {},
    read: async () => raw,
    async compareAndSet(expected: string | null, next: string) {
      if (raw !== expected) return { acquired: false, observed: raw };
      raw = next;
      return { acquired: true, observed: raw };
    },
  };
}

describe('bootstrap operation durable metadata', () => {
  it('stores one canonical context-bound journal without bearer, password or publication bytes', async () => {
    const persistentStore = storage();
    const journal = createBootstrapOperationPersistence(persistentStore, context);
    const candidate = await prepared();
    const created = await journal.create(candidate, session);
    expect(created.status).toBe('saved');
    expect(created.record).toMatchObject({
      account: context.account,
      device: context.device,
      sessionId: context.sessionId,
      vaultId: context.vaultId,
      operationId: candidate.request.operationId,
      expectedCredentialRevision: '17',
      candidateDigest: candidate.candidateDigest,
      status: 'prepared',
    });
    expect(created.raw).not.toContain(candidate.request.publicationBase64Url);
    expect(created.raw).not.toContain('password');
    expect(created.raw).not.toContain('s1.');
    expect(await journal.create(candidate, session)).toMatchObject({
      status: 'found',
      record: created.record,
      raw: created.raw!,
    });
    await expect(
      journal.create(await prepared('b8599652-8588-4de6-9b69-82e775929fd8'), session),
    ).rejects.toThrow();
  });

  it('restores from local publication bytes, recalculates digest and keeps original operation/revision', async () => {
    const persistentStore = storage();
    const journal = createBootstrapOperationPersistence(persistentStore, context);
    const candidate = await prepared();
    const created = await journal.create(candidate, session);
    const restored = await journal.read(session, publication);
    expect(restored?.record).toEqual(created.record);
    expect(restored?.prepared).toEqual(candidate);
    await expect(journal.read({ ...session, accountId: 'other' }, publication)).rejects.toThrow();
    await expect(
      journal.read(session, new TextEncoder().encode('different bytes')),
    ).rejects.toThrow();
  });

  it('persists state transitions with compare-and-set and detects concurrent divergence', async () => {
    const persistentStore = storage();
    const journal = createBootstrapOperationPersistence(persistentStore, context);
    const candidate = await prepared();
    const created = await journal.create(candidate, session);
    const transitioned = await journal.transition(created.raw!, candidate, {
      status: 'emission-uncertain',
    });
    expect(transitioned.status).toBe('saved');
    expect((await journal.read(session, publication))?.record.status).toBe('emission-uncertain');
    await expect(
      journal.transition(created.raw!, candidate, { status: 'committed' }),
    ).rejects.toThrow();
  });

  it('reports durable but unowned CAS readback separately and refuses a terminal regression', async () => {
    let raw: string | null = null;
    const uncertainStorage = {
      assertAvailable() {},
      read: async () => raw,
      async compareAndSet(expected: string | null, next: string) {
        if (raw !== expected) return { acquired: false, observed: raw };
        raw = next;
        return { acquired: undefined, observed: raw };
      },
    };
    const journal = createBootstrapOperationPersistence(uncertainStorage, context);
    const candidate = await prepared();
    await expect(journal.create(candidate, session)).resolves.toMatchObject({
      status: 'found',
    });
    const record = JSON.parse(raw!) as { status: string };
    expect(record.status).toBe('prepared');

    let normalRaw: string | null = null;
    let normalCalls = 0;
    const normal = {
      assertAvailable() {},
      read: async () => normalRaw,
      async compareAndSet(expected: string | null, next: string) {
        if (normalRaw !== expected) return { acquired: false, observed: normalRaw };
        normalRaw = next;
        normalCalls++;
        return { acquired: normalCalls === 2 ? undefined : true, observed: normalRaw };
      },
    };
    const owned = createBootstrapOperationPersistence(normal, context);
    const created = await owned.create(candidate, session);
    const emitting = await owned.transition(created.raw!, candidate, {
      status: 'emission-uncertain',
    });
    expect(emitting).toMatchObject({ status: 'found' });
    const committed = await owned.transition(emitting.raw!, candidate, { status: 'committed' });
    expect(committed.status).toBe('saved');
    await expect(
      owned.transition(emitting.raw!, candidate, { status: 'unknown' }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect((await owned.read(session, publication))?.record.status).toBe('committed');
  });
  it('preserves a legacy terminal rejection when no durable business code exists', async () => {
    const candidate = await prepared();
    const backing = storage();
    const journal = createBootstrapOperationPersistence(backing, context);
    const created = await journal.create(candidate, session);
    const legacy = JSON.stringify({ ...created.record, status: 'rejected' });
    expect(await backing.compareAndSet(created.raw!, legacy, candidate.candidateDigest)).toEqual({
      acquired: true,
      observed: legacy,
    });
    const restored = await journal.read(session, publication);
    expect(restored?.record).toEqual({ ...created.record, status: 'rejected' });
    await expect(
      journal.transition(legacy, candidate, { status: 'emission-uncertain' }),
    ).rejects.toMatchObject({ code: 'STATE' });
    expect(await backing.read()).toBe(legacy);
  });

  it('distinguishes a refused CAS from an uncertain or divergent observation', async () => {
    const backing = storage();
    const candidate = await prepared();
    const journal = createBootstrapOperationPersistence(backing, context);
    const created = await journal.create(candidate, session);
    backing.compareAndSet = async () => ({ acquired: false, observed: created.raw! });
    await expect(
      journal.transition(created.raw!, candidate, { status: 'emission-uncertain' }),
    ).resolves.toEqual({ status: 'not-written' });
    backing.compareAndSet = async () => ({ acquired: true, observed: 'divergent' });
    await expect(
      journal.transition(created.raw!, candidate, { status: 'emission-uncertain' }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  });
});
