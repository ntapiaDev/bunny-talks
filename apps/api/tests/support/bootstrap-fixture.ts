import { Buffer } from 'node:buffer';
import { argon2, randomBytes, randomFillSync, randomUUID } from 'node:crypto';
import type { InitialVaultPublication } from '@bunny-talks/contracts';
import { createAccountVault } from '@bunny-talks/crypto-backup';
import { readBootstrapConfig } from '../../src/vault/bootstrap-config.js';
import { publicationDigest } from '../../src/vault/publication-digest.js';

export const bootstrapEnvironment = {
  VAULT_BOOTSTRAP_ENABLED: 'true',
  VAULT_BOOTSTRAP_QUOTA_KEY: 'd'.repeat(64),
  VAULT_RECEIPT_ACTIVE_KEY_ID: 'http-test',
  VAULT_RECEIPT_KEYS: JSON.stringify([{ id: 'http-test', key: 'e'.repeat(64) }]),
};
export const bootstrapTestConfig = () => readBootstrapConfig(bootstrapEnvironment)!;

/** Real client V1 encryption; native Argon2id uses the exact public client profile. */
export async function clientBootstrapInput(account: string, password: string, size = 32) {
  const vaultId = randomBytes(16).toString('base64url');
  const recovery = randomBytes(32);
  try {
    const publication = await createAccountVault(
      { account, vaultId },
      password,
      recovery,
      new Uint8Array(size),
      {
        async fill(buffer) {
          randomFillSync(buffer);
        },
      },
      {
        derive: (message, nonce, parameters) =>
          new Promise((resolve, reject) => {
            argon2(
              'argon2id',
              {
                message,
                nonce,
                memory: parameters.memoryKiB,
                passes: parameters.passes,
                parallelism: parameters.parallelism,
                tagLength: parameters.outputBytes,
              },
              (error, result) => (error ? reject(error) : resolve(result)),
            );
          }),
      },
    );
    const request: InitialVaultPublication = {
      transportVersion: 1,
      operationId: randomUUID(),
      account,
      vaultId,
      expectedCredentialRevision: '1',
      expectedStorageRevision: null,
      publicationBase64Url: Buffer.from(publication).toString('base64url'),
    };
    return { password, request, candidateDigest: publicationDigest(publication) };
  } finally {
    recovery.fill(0);
  }
}
