import { describe, expect, it, vi } from 'vitest';
import { parseBootstrapOperationRecord } from '../src/composition/bootstrap-operation-record';
import {
  InitialBootstrapProtocolError,
  prepareInitialBootstrap,
  restorePreparedInitialBootstrap,
  validateInitialBootstrapResult,
} from '../src/composition/initial-device-bootstrap';

const publication = new TextEncoder().encode('{"fixture":"exact local publication"}');
const recoveryVerifier = {
  async verifyRecoveryKey(input: { account: string; vaultId: string }): Promise<{
    method: 'account-vault-v1-recovery-open';
    account: string;
    vaultId: string;
    publicationDigest: string;
    recoveryRevision: 1;
  }> {
    return {
      method: 'account-vault-v1-recovery-open',
      account: input.account,
      vaultId: input.vaultId,
      publicationDigest: 'V8thZSVE1sag7nQf4uL-YmjJUmMrlIVShrgmNZdAfq4',
      recoveryRevision: 1,
    };
  },
};
const backupConfirmation = {
  async confirmRecoveryBackup(input: {
    account: string;
    vaultId: string;
    publicationDigest: string;
  }) {
    return {
      kind: 'user-confirmed-independent-recovery-backup' as const,
      ...input,
    };
  },
};

const prepared = () =>
  prepareInitialBootstrap({
    account: 'account-fixture',
    vaultId: 'AQEBAQEBAQEBAQEBAQEBAQ',
    operationId: 'cbbbf3b9-b6e3-41a2-8c6c-bbe37186625f',
    expectedCredentialRevision: '17',
    publicationBytes: publication,
    recoveryKey: new Uint8Array(32).fill(7),
    recoveryVerifier,
    recoveryBackupConfirmation: backupConfirmation,
  });

describe('first-device bootstrap protocol composition', () => {
  it('encodes and hashes a copy of the exact local publication with supplied business revisions', async () => {
    const bytes = Uint8Array.from(publication);
    const result = await prepareInitialBootstrap({
      account: 'account-fixture',
      vaultId: 'AQEBAQEBAQEBAQEBAQEBAQ',
      operationId: 'cbbbf3b9-b6e3-41a2-8c6c-bbe37186625f',
      expectedCredentialRevision: '17',
      publicationBytes: bytes,
      recoveryKey: new Uint8Array(32).fill(7),
      recoveryVerifier,
      recoveryBackupConfirmation: backupConfirmation,
    });
    bytes.fill(0);
    expect(result.request).toEqual({
      transportVersion: 1,
      operationId: 'cbbbf3b9-b6e3-41a2-8c6c-bbe37186625f',
      account: 'account-fixture',
      vaultId: 'AQEBAQEBAQEBAQEBAQEBAQ',
      expectedCredentialRevision: '17',
      expectedStorageRevision: null,
      publicationBase64Url: 'eyJmaXh0dXJlIjoiZXhhY3QgbG9jYWwgcHVibGljYXRpb24ifQ',
    });
    expect(result.candidateDigest).toBe('V8thZSVE1sag7nQf4uL-YmjJUmMrlIVShrgmNZdAfq4');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.request)).toBe(true);
  });

  it.each([
    ['missing credential revision', { expectedCredentialRevision: '' }],
    ['noncanonical operation UUID', { operationId: 'CBBBF3B9-B6E3-41A2-8C6C-BBE37186625F' }],
    ['missing publication', { publicationBytes: new Uint8Array() }],
  ])('rejects %s before any transport operation', async (_name, override) => {
    await expect(
      prepareInitialBootstrap({
        account: 'account-fixture',
        vaultId: 'AQEBAQEBAQEBAQEBAQEBAQ',
        operationId: 'cbbbf3b9-b6e3-41a2-8c6c-bbe37186625f',
        expectedCredentialRevision: '17',
        publicationBytes: publication,
        recoveryKey: new Uint8Array(32).fill(7),
        recoveryVerifier,
        recoveryBackupConfirmation: backupConfirmation,
        ...override,
      }),
    ).rejects.toThrow(InitialBootstrapProtocolError);
  });

  it('refuses a recovery verifier result that is not bound to the exact publication', async () => {
    await expect(
      prepareInitialBootstrap({
        account: 'account-fixture',
        vaultId: 'AQEBAQEBAQEBAQEBAQEBAQ',
        operationId: 'cbbbf3b9-b6e3-41a2-8c6c-bbe37186625f',
        expectedCredentialRevision: '17',
        publicationBytes: publication,
        recoveryKey: new Uint8Array(32).fill(7),
        recoveryVerifier: {
          async verifyRecoveryKey(input) {
            return {
              method: 'account-vault-v1-recovery-open',
              account: input.account,
              vaultId: input.vaultId,
              publicationDigest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              recoveryRevision: 1,
            };
          },
        },
        recoveryBackupConfirmation: backupConfirmation,
      }),
    ).rejects.toThrow(InitialBootstrapProtocolError);
  });

  it('does not prepare a publication if local recovery verification is interrupted', async () => {
    let verifierKey: Uint8Array | undefined;
    await expect(
      prepareInitialBootstrap({
        account: 'account-fixture',
        vaultId: 'AQEBAQEBAQEBAQEBAQEBAQ',
        operationId: 'cbbbf3b9-b6e3-41a2-8c6c-bbe37186625f',
        expectedCredentialRevision: '17',
        publicationBytes: publication,
        recoveryKey: new Uint8Array(32).fill(7),
        recoveryVerifier: {
          async verifyRecoveryKey(input) {
            verifierKey = input.recoveryKey;
            throw new Error('interrupted');
          },
        },
        recoveryBackupConfirmation: backupConfirmation,
      }),
    ).rejects.toThrow(InitialBootstrapProtocolError);
    expect(verifierKey?.every((byte) => byte === 0)).toBe(true);
  });

  it('refuses to prepare activation when the user does not confirm the independent backup', async () => {
    const verify = vi.fn(recoveryVerifier.verifyRecoveryKey);
    await expect(
      prepareInitialBootstrap({
        account: 'account-fixture',
        vaultId: 'AQEBAQEBAQEBAQEBAQEBAQ',
        operationId: 'cbbbf3b9-b6e3-41a2-8c6c-bbe37186625f',
        expectedCredentialRevision: '17',
        publicationBytes: publication,
        recoveryKey: new Uint8Array(32).fill(7),
        recoveryVerifier: { verifyRecoveryKey: verify },
        recoveryBackupConfirmation: {
          async confirmRecoveryBackup() {
            return null;
          },
        },
      }),
    ).rejects.toThrow(InitialBootstrapProtocolError);
    expect(verify).toHaveBeenCalledOnce();
  });

  it('keeps an unknown receipt inconclusive and does not change the prepared operation', async () => {
    const operation = await prepared();
    expect(
      validateInitialBootstrapResult({ transportVersion: 1, status: 'unknown' }, operation),
    ).toEqual({ status: 'unknown' });
    expect(operation.request.operationId).toBe('cbbbf3b9-b6e3-41a2-8c6c-bbe37186625f');
  });

  it('accepts only a committed receipt correlated with the saved operation and digest', async () => {
    const operation = await prepared();
    const result = {
      transportVersion: 1,
      status: 'committed',
      identity: {
        account: operation.request.account,
        operationId: operation.request.operationId,
        kind: 'initial-publication',
        expectedStorageRevision: null,
        expectedCredentialRevision: operation.request.expectedCredentialRevision,
      },
      cas: { storageRevision: '1', credentialRevision: '17' },
      publicationDigest: operation.candidateDigest,
    };
    expect(validateInitialBootstrapResult(result, operation)).toEqual({
      status: 'committed',
      result,
    });
  });

  it('accepts a correlated terminal business rejection without treating it as authorization', async () => {
    const operation = await prepared();
    const result = {
      transportVersion: 1,
      status: 'rejected',
      identity: {
        account: operation.request.account,
        operationId: operation.request.operationId,
        kind: 'initial-publication',
        expectedStorageRevision: null,
        expectedCredentialRevision: operation.request.expectedCredentialRevision,
      },
      code: 'VERSION_CONFLICT',
    };
    expect(validateInitialBootstrapResult(result, operation)).toEqual({
      status: 'rejected',
      result,
    });
  });

  it('classifies idempotency mismatch as a conflict without calling it a terminal rejection', async () => {
    const operation = await prepared();
    const result = {
      transportVersion: 1,
      status: 'rejected',
      identity: {
        account: operation.request.account,
        operationId: operation.request.operationId,
        kind: 'initial-publication',
        expectedStorageRevision: null,
        expectedCredentialRevision: operation.request.expectedCredentialRevision,
      },
      code: 'IDEMPOTENCY_MISMATCH',
    };
    expect(validateInitialBootstrapResult(result, operation)).toEqual({
      status: 'conflict',
      result,
    });
  });

  it('restores the journaled operation only with its independent context and exact publication digest', async () => {
    const operation = await prepared();
    const record = {
      version: 1,
      account: 'account-fixture',
      device: 'device-fixture',
      sessionId: 'd8c49125-e0fb-4a9e-bdc2-09c57ad4382a',
      vaultId: operation.request.vaultId,
      operationId: operation.request.operationId,
      expectedCredentialRevision: operation.request.expectedCredentialRevision,
      candidateDigest: operation.candidateDigest,
      status: 'unknown',
    };
    const context = {
      account: record.account,
      device: record.device,
      vaultId: record.vaultId,
      sessionId: record.sessionId,
    };
    const saved = parseBootstrapOperationRecord(JSON.stringify(record), context);
    expect(saved).toBeDefined();
    expect(restorePreparedInitialBootstrap(saved!, publication)).toEqual(operation);
    expect(
      parseBootstrapOperationRecord(JSON.stringify(record), { ...context, device: 'other-device' }),
    ).toBeUndefined();
    expect(() =>
      restorePreparedInitialBootstrap(
        { ...saved!, candidateDigest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        publication,
      ),
    ).toThrow(InitialBootstrapProtocolError);
  });

  it.each([
    [
      'different account',
      (r: Record<string, unknown>) => ((r.identity as Record<string, unknown>).account = 'other'),
    ],
    [
      'different operation',
      (r: Record<string, unknown>) =>
        ((r.identity as Record<string, unknown>).operationId =
          'd8c49125-e0fb-4a9e-bdc2-09c57ad4382a'),
    ],
    [
      'different credential revision',
      (r: Record<string, unknown>) =>
        ((r.identity as Record<string, unknown>).expectedCredentialRevision = '18'),
    ],
    [
      'different digest',
      (r: Record<string, unknown>) =>
        (r.publicationDigest = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    ],
    [
      'different committed credential revision',
      (r: Record<string, unknown>) =>
        ((r.cas as Record<string, unknown>).credentialRevision = '18'),
    ],
    [
      'different initial storage revision',
      (r: Record<string, unknown>) => ((r.cas as Record<string, unknown>).storageRevision = '2'),
    ],
    ['extra response field', (r: Record<string, unknown>) => (r.private = true)],
  ])('rejects a divergent confirmed result: %s', async (_name, mutate) => {
    const operation = await prepared();
    const result: Record<string, unknown> = {
      transportVersion: 1,
      status: 'committed',
      identity: {
        account: operation.request.account,
        operationId: operation.request.operationId,
        kind: 'initial-publication',
        expectedStorageRevision: null,
        expectedCredentialRevision: operation.request.expectedCredentialRevision,
      },
      cas: { storageRevision: '1', credentialRevision: '17' },
      publicationDigest: operation.candidateDigest,
    };
    mutate(result);
    expect(() => validateInitialBootstrapResult(result, operation)).toThrow(
      InitialBootstrapProtocolError,
    );
  });
});
