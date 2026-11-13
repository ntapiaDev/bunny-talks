import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createSignalProtocolClient } from '@open-e2ee/signal-protocol-sdk/client';
import {
  generateEcSignedPreKey,
  generateIdentityKeyPair,
  generateKyberLastResortPreKey,
} from '@open-e2ee/signal-protocol-sdk/keys';
import { nodeStore } from '@open-e2ee/signal-protocol-sdk/local/store/node';
import type { SignalProtocolLocalSecretVault } from '@open-e2ee/signal-protocol-sdk/local/vault';
import { expect, it } from 'vitest';

it.each([16380, 16381, 16382, 16383])(
  'characterizes session operations with registration ID %i',
  async (id) => {
    const directory = await mkdtemp(join(tmpdir(), 'bunny-registration-session-'));
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
    const stores: Awaited<ReturnType<typeof nodeStore>>[] = [];
    const clients: Awaited<ReturnType<typeof createSignalProtocolClient>>[] = [];
    const open = async (name: string) => {
      const store = await nodeStore({ directory, name, vault });
      stores.push(store);
      return store;
    };
    const start = async (userId: string, storage: Awaited<ReturnType<typeof nodeStore>>) => {
      const client = await createSignalProtocolClient({
        identity: { userId },
        adapters: { storage },
      });
      clients.push(client);
      return client;
    };
    try {
      let senderStore = await open('sender.db');
      let targetStore = await open('target.db');
      const senderIdentity = { ...(await generateIdentityKeyPair()), registrationId: 1 };
      const targetIdentity = { ...(await generateIdentityKeyPair()), registrationId: id };
      await senderStore.storeIdentityKey(senderIdentity, 'aci');
      await targetStore.storeIdentityKey(targetIdentity, 'aci');
      const signed = await generateEcSignedPreKey(targetIdentity);
      const kem = await generateKyberLastResortPreKey(targetIdentity);
      await targetStore.storeEcSignedPreKey(signed, 'aci');
      await targetStore.storeKyberPreKey(kem, 'aci');
      let sender = await start('sender', senderStore);
      let target = await start('target', targetStore);
      await sender.establishSession(target.address(), {
        registrationId: id,
        deviceId: 1,
        identity: {
          version: 1,
          x25519PublicKey: targetIdentity.dhKey.publicKey,
          ed25519PublicKey: targetIdentity.signingKey.publicKey,
        },
        ecSignedPreKey: {
          keyId: signed.keyId,
          publicKey: signed.publicKey,
          signature: signed.signature,
        },
        kemLastResortPreKey: {
          keyId: kem.keyId,
          publicKey: kem.publicKey,
          signature: kem.signature,
        },
      });
      expect(
        await target.decryptMessage(
          sender.address(),
          await sender.encryptMessage(target.address(), 'before'),
        ),
      ).toBe('before');
      expect(
        await sender.decryptMessage(
          target.address(),
          await target.encryptMessage(sender.address(), 'reply'),
        ),
      ).toBe('reply');
      const record = await senderStore.getSessionRecord(target.address());
      for (const client of clients.splice(0)) await client.stop();
      for (const store of stores.splice(0)) await store.close();
      senderStore = await open('sender.db');
      targetStore = await open('target.db');
      expect(isDeepStrictEqual(await senderStore.getSessionRecord(target.address()), record)).toBe(
        true,
      );
      expect(await targetStore.getLocalRegistrationId('aci')).toBe(id);
      sender = await start('sender', senderStore);
      target = await start('target', targetStore);
      expect(
        await target.decryptMessage(
          sender.address(),
          await sender.encryptMessage(target.address(), 'after'),
        ),
      ).toBe('after');
      expect(
        await sender.decryptMessage(
          target.address(),
          await target.encryptMessage(sender.address(), 'after reply'),
        ),
      ).toBe('after reply');
    } finally {
      const stopped = await Promise.allSettled(clients.map((client) => client.stop()));
      const closed = await Promise.allSettled(stores.map((store) => store.close()));
      for (const secret of secrets.values()) secret.fill(0);
      const removed = await Promise.allSettled([rm(directory, { recursive: true, force: true })]);
      expect(
        [...stopped, ...closed, ...removed].every((result) => result.status === 'fulfilled'),
      ).toBe(true);
    }
  },
  60000,
);
