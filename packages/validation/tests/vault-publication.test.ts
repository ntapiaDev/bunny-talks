import { describe, expect, it } from 'vitest';
import {
  databaseRevisionSchema,
  initialVaultPublicationSchema,
  ordinaryPasswordChangeSchema,
  publicationDigestSchema,
  vaultOperationResultSchema,
  vaultReadStateSchema,
} from '../src/index.js';
const input = {
  transportVersion: 1,
  operationId: 'd9428888-122b-4f4e-8cfa-9d120d2b9939',
  account: 'account',
  vaultId: 'AAECAwQFBgcICQoLDA0ODw',
  expectedCredentialRevision: '1',
  expectedStorageRevision: null,
  publicationBase64Url: 'AA',
};
describe('vault transport schemas', () => {
  it('accepts canonical encodings and rejects ambiguity, oversized payloads and unsafe counters', () => {
    expect(initialVaultPublicationSchema.safeParse(input).success).toBe(true);
    for (const invalid of ['0', '01', '-1', '9223372036854775808', '1.0'])
      expect(databaseRevisionSchema.safeParse(invalid).success).toBe(false);
    expect(databaseRevisionSchema.safeParse('9223372036854775807').success).toBe(true);
    for (const publicationBase64Url of ['AB', 'A', 'AA=', 'A'.repeat(174764)])
      expect(
        initialVaultPublicationSchema.safeParse({ ...input, publicationBase64Url }).success,
      ).toBe(false);
    expect(
      initialVaultPublicationSchema.safeParse({
        ...input,
        operationId: input.operationId.toUpperCase(),
      }).success,
    ).toBe(false);
    expect(initialVaultPublicationSchema.safeParse({ ...input, unknown: true }).success).toBe(
      false,
    );
    expect(initialVaultPublicationSchema.safeParse({ ...input, transportVersion: 2 }).success).toBe(
      false,
    );
    expect(
      initialVaultPublicationSchema.safeParse({ ...input, vaultId: 'AAECAwQFBgcICQoLDA0ODx' })
        .success,
    ).toBe(false);
    expect(
      ordinaryPasswordChangeSchema.safeParse({
        transportVersion: 1,
        operationId: input.operationId,
        account: input.account,
        vaultId: input.vaultId,
        expected: { storageRevision: '1', credentialRevision: '2' },
        publicationBase64Url: 'AA',
      }).success,
    ).toBe(true);
  });
});

it('validates read states and each public operation result without exposing internal fields', () => {
  const cas = { storageRevision: '1', credentialRevision: '2' };
  const identity = {
    account: input.account,
    operationId: input.operationId,
    kind: 'initial-publication',
    expectedStorageRevision: null,
    expectedCredentialRevision: '2',
  };
  const state = {
    transportVersion: 1,
    account: input.account,
    vaultId: input.vaultId,
    cryptographicFormatVersion: 1,
    publicationBase64Url: 'AA',
    publicationDigest: 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0',
    cas,
    revisions: { generation: 1, contentRevision: 1, passwordRevision: 1, recoveryRevision: 1 },
    envelopeCredentialRevision: '2',
  };
  expect(vaultReadStateSchema.safeParse(state).success).toBe(true);
  expect(vaultReadStateSchema.safeParse({ ...state, publicationDigest: undefined }).success).toBe(
    false,
  );
  expect(
    vaultReadStateSchema.safeParse({
      ...state,
      revisions: { ...state.revisions, generation: Number.MAX_SAFE_INTEGER + 1 },
    }).success,
  ).toBe(false);
  expect(
    vaultReadStateSchema.safeParse({ ...state, cas: { ...cas, storageRevision: '01' } }).success,
  ).toBe(false);
  expect(vaultReadStateSchema.safeParse({ ...state, extra: true }).success).toBe(false);
  const committed = {
    transportVersion: 1,
    status: 'committed',
    identity,
    cas,
    publicationDigest: 'A'.repeat(43),
  };
  for (const invalidDigest of ['A'.repeat(42), `${'A'.repeat(42)}B`, `${'A'.repeat(42)}+`]) {
    expect(
      vaultReadStateSchema.safeParse({ ...state, publicationDigest: invalidDigest }).success,
    ).toBe(false);
    expect(
      vaultOperationResultSchema.safeParse({ ...committed, publicationDigest: invalidDigest })
        .success,
    ).toBe(false);
  }
  expect(
    vaultOperationResultSchema.safeParse({ transportVersion: 1, status: 'unknown' }).success,
  ).toBe(true);
  expect(vaultOperationResultSchema.safeParse(committed).success).toBe(true);
  expect(
    vaultOperationResultSchema.safeParse({
      transportVersion: 1,
      status: 'rejected',
      identity,
      code: 'VERSION_CONFLICT',
    }).success,
  ).toBe(true);
  expect(
    vaultOperationResultSchema.safeParse({
      ...committed,
      identity: { ...identity, fingerprint: 'secret' },
    }).success,
  ).toBe(false);
  expect(vaultOperationResultSchema.safeParse({ ...committed, password: 'secret' }).success).toBe(
    false,
  );
  expect(
    vaultOperationResultSchema.safeParse({
      ...committed,
      identity: { ...identity, operationId: input.operationId.toUpperCase() },
    }).success,
  ).toBe(false);
  expect(
    vaultOperationResultSchema.safeParse({
      transportVersion: 1,
      status: 'rejected',
      identity,
      code: 'UNKNOWN',
    }).success,
  ).toBe(false);
  expect(
    vaultOperationResultSchema.safeParse({ transportVersion: 1, status: 'unknown', identity })
      .success,
  ).toBe(false);
});

it('requires a canonical unpadded 32-byte publication digest', () => {
  expect(publicationDigestSchema.safeParse('A'.repeat(43)).success).toBe(true);
  for (const digest of [
    '',
    'A'.repeat(42),
    'A'.repeat(44),
    `${'A'.repeat(42)}B`,
    `${'A'.repeat(43)}=`,
    `${'A'.repeat(42)}+`,
    `${'A'.repeat(42)}/`,
    `${'A'.repeat(41)} A`,
  ]) {
    expect(publicationDigestSchema.safeParse(digest).success).toBe(false);
  }
});
