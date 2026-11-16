import { Buffer } from 'node:buffer';
import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { PostgresVaultRepository } from '../../../src/vault/postgres-vault-repository.js';
import { publicationDigest } from '../../../src/vault/publication-digest.js';

const vector = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../packages/crypto/backup/tests/fixtures/account-vault-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { publication: string; context: { account: string; vaultId: string } };
function fixture() {
  // Preparation is synchronous and must never access persistence.
  const transaction = vi.fn(() => {
    throw new Error('Unexpected database access');
  });
  const client = { $transaction: transaction } as unknown as PrismaClient;
  const key = createSecretKey(randomBytes(32));
  const vault = new PostgresVaultRepository(client, { activeKeyId: 'test', getKey: () => key });
  const request = {
    transportVersion: 1,
    operationId: randomUUID(),
    ...vector.context,
    expectedCredentialRevision: '1',
    expectedStorageRevision: null,
    publicationBase64Url: Buffer.from(vector.publication).toString('base64url'),
  };
  return {
    vault,
    transaction,
    request,
    digest: publicationDigest(Buffer.from(vector.publication)),
  };
}
describe('initial publication preparation for trusted transaction composition', () => {
  it('snapshots the strict request and exact decoded bytes without opening a transaction', () => {
    const f = fixture();
    const prepared = f.vault.prepareInitialPublication(f.request, f.digest);
    const id = f.request.operationId;
    f.request.operationId = randomUUID();
    f.request.publicationBase64Url = 'e30';
    expect(prepared.identity.operationId).toBe(id);
    expect(Buffer.from(prepared.candidate.bytes).toString()).toBe(vector.publication);
    expect(prepared.candidate.digest).toBe(f.digest);
    expect(prepared.identity.kind).toBe('initial-publication');
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each(['extra-field', 'digest', 'structure', 'context'] as const)(
    'rejects %s without persistence and with fixed errors',
    (kind) => {
      const f = fixture();
      const request = {
        ...f.request,
        ...(kind === 'extra-field' ? { authenticated: true } : {}),
        ...(kind === 'structure' ? { publicationBase64Url: 'e30' } : {}),
        ...(kind === 'context' ? { account: 'different-account' } : {}),
      };
      const digest =
        kind === 'digest'
          ? randomBytes(32).toString('base64url')
          : kind === 'structure'
            ? publicationDigest(Buffer.from('{}'))
            : f.digest;
      expect(() => f.vault.prepareInitialPublication(request, digest)).toThrow(
        kind === 'extra-field' ? 'INVALID_INPUT' : 'INVALID_PUBLICATION',
      );
      expect(f.transaction).not.toHaveBeenCalled();
    },
  );
});
