import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as currentClient from '@open-e2ee/signal-protocol-sdk/client';
import * as currentKeys from '@open-e2ee/signal-protocol-sdk/keys';
import * as currentStore from '@open-e2ee/signal-protocol-sdk/local/store/node';
import { expect, it } from 'vitest';
import * as oldClient from '@bunny-talks/open-e2ee-14-4/client';
import * as oldKeys from '@bunny-talks/open-e2ee-14-4/keys';
import * as oldStore from '@bunny-talks/open-e2ee-14-4/local/store/node';
import { TestRelay } from './fixtures/test-relay.js';

for (const [version, api, keys, storage] of [
  // Version-local brands differ; only the common public test surface crosses this boundary.
  [
    '14.4.0',
    oldClient as unknown as typeof currentClient,
    oldKeys as unknown as typeof currentKeys,
    oldStore as unknown as typeof currentStore,
  ],
  ['14.5.0', currentClient, currentKeys, currentStore],
] as const) {
  it(`${version}: characterizes own-device substitution and stale own pins`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bunny-own-identity-'));
    const secrets = new Map<string, Uint8Array>();
    const vault = {
      async getSecret(name: string) {
        return secrets.get(name)?.slice() ?? null;
      },
      async setSecret(name: string, value: Uint8Array) {
        secrets.set(name, value.slice());
      },
      async deleteSecret(name: string) {
        secrets.delete(name);
      },
    };
    const stores: Awaited<ReturnType<typeof storage.nodeStore>>[] = [];
    const clients: Awaited<ReturnType<typeof api.createSignalProtocolClient>>[] = [];
    const relay = new TestRelay();
    const identity = await keys.generateIdentityKeyPair();
    const other = await keys.generateIdentityKeyPair();
    const composite = (value: typeof identity) => ({
      version: 1 as const,
      x25519PublicKey: value.dhKey.publicKey,
      ed25519PublicKey: value.signingKey.publicKey,
    });
    const make = async (
      name: string,
      userId: string,
      deviceId: number,
      material: typeof identity,
      transport?: ReturnType<TestRelay['capability']>,
    ) => {
      const store = await storage.nodeStore({ directory, name: `${name}.db`, vault });
      stores.push(store);
      await store.storeIdentityKey({ ...material, registrationId: deviceId + 10 }, 'aci');
      const client = await api.createSignalProtocolClient({
        identity: { userId, deviceId },
        adapters: { storage: store, ...(transport ? { relay: transport } : {}) },
      });
      clients.push(client);
      return { store, client };
    };
    try {
      const aRelay = relay.capability('alice', 1);
      const a2Relay = relay.capability('alice', 2);
      const bRelay = relay.capability('bob', 1);
      await aRelay.registerDevice('alice', { deviceId: 1 });
      await a2Relay.registerDevice('alice', { deviceId: 2 });
      await bRelay.registerDevice('bob', { deviceId: 1 });
      const rogue = await make('rogue', 'alice', 2, other);
      const signed = await keys.generateEcSignedPreKey({ ...other, registrationId: 12 });
      const kem = await keys.generateKyberLastResortPreKey({ ...other, registrationId: 12 });
      await rogue.store.storeEcSignedPreKey(signed, 'aci');
      await rogue.store.storeKyberPreKey(kem, 'aci');
      let substitute = true;
      let substitutions = 0;
      const maliciousRelay = {
        ...aRelay,
        async fetchPreKeyBundle(user: string, device: number) {
          if (substitute && user === 'alice' && device === 2) {
            substitutions++;
            return {
              registrationId: 12,
              deviceId: 2,
              identity: composite(other),
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
            };
          }
          return aRelay.fetchPreKeyBundle(user, device);
        },
      };
      const a = await make('a1', 'alice', 1, identity, maliciousRelay);
      const a2 = await make('a2', 'alice', 2, identity, a2Relay);
      const b = await make('b1', 'bob', 1, await keys.generateIdentityKeyPair(), bRelay);
      for (const item of [a, a2, b]) await item.client.syncToServer();
      await a.client.send('bob', 'substitution probe');
      expect(substitutions).toBeGreaterThan(0);
      const syncPosts = relay.posts.filter(
        (p) => p.senderUserId === 'alice' && p.targetUserId === 'alice' && p.targetDeviceId === 2,
      );
      if (version === '14.4.0') {
        expect(await a.client.hasSession(a2.client.address())).toBe(true);
        expect((await a.store.getContactIdentity(a2.client.address()))?.identity).toEqual(
          composite(other),
        );
        expect(syncPosts.length).toBeGreaterThan(0);
        // Real SDK decryption proves that the substituted identity received the sync content.
        const wire = syncPosts[0]!.ciphertext;
        const decoded = typeof wire === 'string' ? Buffer.from(wire, 'base64') : Buffer.from(wire);
        const clear = await rogue.client.decryptMessage(
          a.client.address(),
          decoded.toString('utf8') as Parameters<typeof rogue.client.decryptMessage>[1],
        );
        const sync = JSON.parse(clear) as { syncMessage: { sent: { serializedContent: string } } };
        expect(
          Buffer.from(sync.syncMessage.sent.serializedContent, 'base64').toString('utf8'),
        ).toBe('substitution probe');
      } else {
        expect(await a.client.hasSession(a2.client.address())).toBe(false);
        expect(await a.store.getContactIdentity(a2.client.address())).toBeNull();
        expect(syncPosts).toHaveLength(0);
        await expect(
          a.client.establishSession(
            a2.client.address(),
            (await maliciousRelay.fetchPreKeyBundle('alice', 2))!,
          ),
        ).rejects.toMatchObject({ name: 'UntrustedIdentityError' });
      }
      if (version === '14.5.0') {
        const sender = await oldClient.createSignalProtocolClient({
          identity: { userId: 'alice', deviceId: 2 },
          adapters: {
            storage: rogue.store as unknown as Parameters<
              typeof oldClient.createSignalProtocolClient
            >[0]['adapters']['storage'],
          },
        });
        try {
          await sender.establishSession(
            a.client.address(),
            (await aRelay.fetchPreKeyBundle('alice', 1))! as unknown as Parameters<
              typeof sender.establishSession
            >[1],
          );
          const incoming = await sender.encryptMessage(a.client.address(), 'hostile incoming');
          await expect(
            a.client.decryptMessage(
              sender.address(),
              incoming as unknown as Parameters<typeof a.client.decryptMessage>[1],
            ),
          ).rejects.toMatchObject({ name: 'UntrustedIdentityError' });
          expect(await a.client.hasSession(a2.client.address())).toBe(false);
          expect(await a.store.getContactIdentity(a2.client.address())).toBeNull();
        } finally {
          await sender.stop();
        }
      }
      expect(
        isDeepStrictEqual(await a.store.getIdentityKey('aci'), { ...identity, registrationId: 11 }),
      ).toBe(true);
      expect((await a.store.getContactIdentity(b.client.address()))?.identity).not.toEqual(
        composite(other),
      );
      // Reproduce the stale own pin through the public store API, without editing SQL tables.
      if (version === '14.5.0') {
        // Create genuinely stale sessions with 14.4.0 through its public API.
        const legacy = await oldClient.createSignalProtocolClient({
          identity: { userId: 'alice', deviceId: 1 },
          adapters: {
            storage: a.store as unknown as Parameters<
              typeof oldClient.createSignalProtocolClient
            >[0]['adapters']['storage'],
          },
        });
        try {
          const attackBundle = (await maliciousRelay.fetchPreKeyBundle('alice', 2))!;
          await legacy.establishSession(
            a2.client.address(),
            attackBundle as unknown as Parameters<typeof legacy.establishSession>[1],
          );
          await legacy.establishSession({ userId: 'alice', deviceId: 3 }, {
            ...attackBundle,
            deviceId: 3,
          } as unknown as Parameters<typeof legacy.establishSession>[1]);
        } finally {
          await legacy.stop();
        }
        expect(await a.client.hasSession({ userId: 'alice', deviceId: 3 })).toBe(true);
        expect((await a.store.getContactIdentity(a2.client.address()))?.identity).toEqual(
          composite(other),
        );
      }
      substitute = false;
      const legitimate = await aRelay.fetchPreKeyBundle('alice', 2);
      if (!legitimate) throw new Error('Missing legitimate bundle');
      if (version === '14.4.0') {
        await expect(
          a.client.establishSession(a2.client.address(), legitimate),
        ).rejects.toMatchObject({ name: 'UntrustedIdentityError' });
        expect((await a.store.getContactIdentity(a2.client.address()))?.identity).toEqual(
          composite(other),
        );
      } else {
        await a.client.establishSession(a2.client.address(), legitimate);
        expect((await a.store.getContactIdentity(a2.client.address()))?.identity).toEqual(
          composite(identity),
        );
        expect(await a.client.hasSession({ userId: 'alice', deviceId: 3 })).toBe(false);
        expect(await a.client.hasSession(b.client.address())).toBe(true);
        expect(
          await a2.client.decryptMessage(
            a.client.address(),
            await a.client.encryptMessage(a2.client.address(), 'legitimate recovery'),
          ),
        ).toBe('legitimate recovery');
      }
      // The contact conversation survives both the failed attack and own-pin repair.
      expect(
        await b.client.decryptMessage(
          a.client.address(),
          await a.client.encryptMessage(b.client.address(), 'contact continuity'),
        ),
      ).toBe('contact continuity');
    } finally {
      for (const client of clients) await client.stop();
      for (const store of stores) await store.close();
      for (const value of secrets.values()) value.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
}
