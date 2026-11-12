import { timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateEcOneTimePreKeys,
  generateIdentityKeyPair,
} from '@open-e2ee/signal-protocol-sdk/keys';
import { nodeStore } from '@open-e2ee/signal-protocol-sdk/local/store/node';
import type { SignalProtocolLocalSecretVault } from '@open-e2ee/signal-protocol-sdk/local/vault';
import { expect, it } from 'vitest';
import { importIdentity } from '../src/index.js';

it('persists an identity in an independent encrypted Node store after reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bunny-crypto002-'));
  const secrets = new Map<string, Uint8Array>();
  const vault: SignalProtocolLocalSecretVault = {
    async getSecret(name) {
      return secrets.get(name)?.slice() ?? null;
    },
    async setSecret(name, value) {
      secrets.set(name, value.slice());
    },
    async deleteSecret(name) {
      secrets.delete(name);
    },
  };
  let source: Awaited<ReturnType<typeof nodeStore>> | undefined;
  let destination: Awaited<ReturnType<typeof nodeStore>> | undefined;
  let initialized: Awaited<ReturnType<typeof nodeStore>> | undefined;
  const cleanup = async () => {
    const results = await Promise.allSettled([
      initialized?.close(),
      destination?.close(),
      source?.close(),
    ]);
    for (const secret of secrets.values()) secret.fill(0);
    const removal = await Promise.allSettled([rm(directory, { recursive: true, force: true })]);
    if ([...results, ...removal].some((result) => result.status === 'rejected')) {
      throw new Error('Failed to clean up test stores');
    }
  };
  try {
    source = await nodeStore({ directory, name: 'source.db', vault });
    expect(secrets.size).toBe(1);
    const sourceDatabaseKey = Array.from(secrets.values())[0];
    expect(sourceDatabaseKey).toBeDefined();
    destination = await nodeStore({ directory, name: 'destination.db', vault });
    expect(secrets.size).toBe(2);
    const destinationDatabaseKey = Array.from(secrets.values())[1];
    expect(destinationDatabaseKey).toBeDefined();
    expect(timingSafeEqual(sourceDatabaseKey!, destinationDatabaseKey!)).toBe(false);
    const identity = await generateIdentityKeyPair();
    await source.storeIdentityKey(identity, 'aci');
    const stored = await source.getIdentityKey('aci');
    expect(stored).not.toBeNull();
    const registrationId = identity.registrationId === 1 ? 2 : 1;
    expect(await destination.getIdentityKey('aci')).toBeNull();
    const prekeys = await generateEcOneTimePreKeys(1);
    await destination.storeEcOneTimePreKeys(prekeys, 'aci');
    await expect(importIdentity(destination, {}, registrationId)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(await destination.getIdentityKey('aci')).toBeNull();
    expect(await destination.getLocalRegistrationId('aci')).toBe(0);
    initialized = await nodeStore({ directory, name: 'initialized.db', vault });
    await initialized.setLocalRegistrationId(42, 'aci');
    await expect(importIdentity(initialized, stored, registrationId)).rejects.toMatchObject({
      code: 'KEY_ACCESS_DENIED',
    });
    expect(await initialized.getLocalRegistrationId('aci')).toBe(42);
    expect(await initialized.getIdentityKey('aci')).toBeNull();
    const concurrent = await Promise.allSettled([
      importIdentity(destination, stored, registrationId),
      importIdentity(destination, stored, registrationId),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = concurrent.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.code === 'KEY_ACCESS_DENIED').toBe(
      true,
    );
    await expect(importIdentity(destination, stored, registrationId)).rejects.toMatchObject({
      code: 'KEY_ACCESS_DENIED',
    });
    const other = await generateIdentityKeyPair();
    await expect(importIdentity(destination, other, registrationId)).rejects.toMatchObject({
      code: 'KEY_ACCESS_DENIED',
    });
    await destination.close();
    destination = undefined;
    const bytes = await readFile(join(directory, 'destination.db'));
    expect(bytes.subarray(0, 16).toString('ascii')).not.toBe('SQLite format 3\u0000');
    const wrongVault: SignalProtocolLocalSecretVault = {
      ...vault,
      async getSecret() {
        return sourceDatabaseKey!.slice();
      },
    };
    await expect(
      nodeStore({ directory, name: 'destination.db', vault: wrongVault }),
    ).rejects.toThrow();
    destination = await nodeStore({ directory, name: 'destination.db', vault });
    const restored = await destination.getIdentityKey('aci');
    expect(restored?.dhKey.publicKey === identity.dhKey.publicKey).toBe(true);
    expect(restored?.dhKey.privateKey === identity.dhKey.privateKey).toBe(true);
    expect(restored?.signingKey.publicKey === identity.signingKey.publicKey).toBe(true);
    expect(restored?.signingKey.privateKey === identity.signingKey.privateKey).toBe(true);
    expect(restored?.registrationId).toBe(registrationId);
    expect(await destination.getLocalRegistrationId('aci')).toBe(registrationId);
    expect(await destination.getSessionCount()).toBe(0);
    const restoredPrekeys = await destination.getEcOneTimePreKeys('aci');
    expect(restoredPrekeys).toHaveLength(1);
    expect(restoredPrekeys[0]?.publicKey === prekeys[0]?.publicKey).toBe(true);
    expect(await destination.getEcSignedPreKey(undefined, 'aci')).toBeNull();
    expect(await destination.getKyberPreKey('aci')).toBeNull();
  } finally {
    await cleanup();
  }
});
