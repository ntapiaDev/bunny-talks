import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createSignalProtocolClient } from '@open-e2ee/signal-protocol-sdk/client';
import type { PreKeyBundle } from '@open-e2ee/signal-protocol-sdk/keys';
import {
  generateEcSignedPreKey,
  generateIdentityKeyPair,
  generateKyberLastResortPreKey,
} from '@open-e2ee/signal-protocol-sdk/keys';
import { nodeStore } from '@open-e2ee/signal-protocol-sdk/local/store/node';
import type { SignalProtocolLocalSecretVault } from '@open-e2ee/signal-protocol-sdk/local/vault';
import { SessionRecord } from '@open-e2ee/signal-protocol-sdk/types';
import { expect, it } from 'vitest';
import { importIdentity, prepareImportedIdentity } from '../src/index.js';

it('exchanges and resumes direct device sessions using independent SQLCipher stores', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bunny-multidevice-'));
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
  const open = async (name: string, userId: string, deviceId: number) => {
    const store = await nodeStore({ directory, name, vault });
    stores.push(store);
    return { store, userId, deviceId };
  };
  const start = async (device: Awaited<ReturnType<typeof open>>) => {
    const client = await createSignalProtocolClient({
      identity: { userId: device.userId, deviceId: device.deviceId },
      adapters: { storage: device.store },
    });
    clients.push(client);
    return client;
  };
  const bundle = async (device: Awaited<ReturnType<typeof open>>): Promise<PreKeyBundle> => {
    const identity = await device.store.getIdentityKey('aci');
    const signed = await device.store.getEcSignedPreKey(undefined, 'aci');
    const kem = await device.store.getKyberPreKey('aci');
    if (!identity || !signed || !kem) throw new Error('Missing prekeys');
    return {
      registrationId: identity.registrationId,
      deviceId: device.deviceId,
      identity: {
        version: 1,
        x25519PublicKey: identity.dhKey.publicKey,
        ed25519PublicKey: identity.signingKey.publicKey,
      },
      ecSignedPreKey: {
        keyId: signed.keyId,
        publicKey: signed.publicKey,
        signature: signed.signature,
      },
      kemLastResortPreKey: { keyId: kem.keyId, publicKey: kem.publicKey, signature: kem.signature },
    };
  };
  try {
    let a1 = await open('a1.db', 'alice', 1);
    let a2 = await open('a2.db', 'alice', 2);
    let b1 = await open('b1.db', 'bob', 1);
    const aliceIdentity = await generateIdentityKeyPair();
    const bobIdentity = await generateIdentityKeyPair();
    await importIdentity(a1.store, aliceIdentity, 1);
    await importIdentity(a2.store, aliceIdentity, 2);
    await importIdentity(b1.store, bobIdentity, 3);
    for (const device of [a1, a2, b1]) {
      const identity = await device.store.getIdentityKey('aci');
      if (!identity) throw new Error('Missing identity');
      await device.store.storeEcSignedPreKey(await generateEcSignedPreKey(identity), 'aci');
      await device.store.storeKyberPreKey(await generateKyberLastResortPreKey(identity), 'aci');
    }
    let alice1 = await start(a1);
    let alice2 = await start(a2);
    let bob = await start(b1);
    expect(
      new Set(Array.from(secrets.values(), (key) => Buffer.from(key).toString('hex'))).size,
    ).toBe(3);
    expect(
      isDeepStrictEqual(
        (await a1.store.getIdentityKey('aci'))?.dhKey,
        (await a2.store.getIdentityKey('aci'))?.dhKey,
      ),
    ).toBe(true);
    expect(
      isDeepStrictEqual(
        (await a1.store.getIdentityKey('aci'))?.signingKey,
        (await a2.store.getIdentityKey('aci'))?.signingKey,
      ),
    ).toBe(true);
    expect(
      isDeepStrictEqual(
        await a1.store.getEcSignedPreKey(undefined, 'aci'),
        await a2.store.getEcSignedPreKey(undefined, 'aci'),
      ),
    ).toBe(false);
    await expect(alice1.encryptMessage(bob.address(), 'missing session')).rejects.toThrow();
    const bobBundle = await bundle(b1);
    await expect(
      alice1.establishSession(bob.address(), { ...bobBundle, kemLastResortPreKey: null }),
    ).rejects.toThrow();
    expect(await alice1.hasSession(bob.address())).toBe(false);
    await alice1.establishSession(bob.address(), bobBundle);
    expect(
      await bob.decryptMessage(
        alice1.address(),
        await alice1.encryptMessage(bob.address(), 'a1-b'),
      ),
    ).toBe('a1-b');
    expect(
      await alice1.decryptMessage(
        bob.address(),
        await bob.encryptMessage(alice1.address(), 'b-a1'),
      ),
    ).toBe('b-a1');
    await alice2.establishSession(bob.address(), await bundle(b1));
    expect(
      await bob.decryptMessage(
        alice2.address(),
        await alice2.encryptMessage(bob.address(), 'a2-b'),
      ),
    ).toBe('a2-b');
    expect(
      await alice2.decryptMessage(
        bob.address(),
        await bob.encryptMessage(alice2.address(), 'b-a2'),
      ),
    ).toBe('b-a2');
    const forA1 = await bob.encryptMessage(alice1.address(), 'account message');
    const forA2 = await bob.encryptMessage(alice2.address(), 'account message');
    expect(await alice1.decryptMessage(bob.address(), forA1)).toBe('account message');
    expect(await alice2.decryptMessage(bob.address(), forA2)).toBe('account message');
    const authentic = await bob.encryptMessage(alice2.address(), 'authenticated');
    const alteredBytes = Buffer.from(authentic, 'base64');
    alteredBytes[alteredBytes.length - 1] = alteredBytes[alteredBytes.length - 1]! ^ 1;
    const altered = alteredBytes.toString('base64') as typeof authentic;
    await expect(alice2.decryptMessage(bob.address(), altered)).rejects.toThrow();
    expect(await alice2.decryptMessage(bob.address(), authentic)).toBe('authenticated');
    const delayed = await bob.encryptMessage(alice1.address(), 'delayed');
    const later = await bob.encryptMessage(alice1.address(), 'later');
    expect(await alice1.decryptMessage(bob.address(), later)).toBe('later');
    expect(await alice1.decryptMessage(bob.address(), delayed)).toBe('delayed');
    await expect(alice1.decryptMessage(bob.address(), delayed)).rejects.toThrow();
    // This fixture is an authorization model, not an authenticated production relay.
    const authorized = new Set(['alice:1', 'alice:2', 'bob:1']);
    const requireAuthorized = (device: string) => {
      if (!authorized.has(device)) throw new Error('Device is revoked');
    };
    const relay = {
      send(sender: string) {
        requireAuthorized(sender);
      },
      publishPrekeys(device: string) {
        requireAuthorized(device);
      },
      fetch(device: string) {
        requireAuthorized(device);
      },
    };
    const distribute = async (message: string) => {
      requireAuthorized('bob:1');
      const targets = [alice1, alice2].filter((client) =>
        authorized.has(`alice:${client.address().deviceId}`),
      );
      return Promise.all(
        targets.map(async (client) => ({
          client,
          ciphertext: await bob.encryptMessage(client.address(), message),
        })),
      );
    };
    const queuedForA2 = await bob.encryptMessage(alice2.address(), 'queued before revocation');
    const preparedByA2 = await alice2.encryptMessage(bob.address(), 'prepared before revocation');
    authorized.delete('alice:2');
    expect(() => relay.send('alice:2')).toThrow();
    expect(() => relay.publishPrekeys('alice:2')).toThrow();
    expect(() => relay.fetch('alice:2')).toThrow();
    const deliveries = await distribute('authorized distribution');
    expect(deliveries).toHaveLength(1);
    expect(
      await deliveries[0]!.client.decryptMessage(bob.address(), deliveries[0]!.ciphertext),
    ).toBe('authorized distribution');
    expect(await bob.decryptMessage(alice2.address(), preparedByA2)).toBe(
      'prepared before revocation',
    );
    // A stale device list and a cached session still permit local encryption.
    const staleDelivery = await bob.encryptMessage(alice2.address(), 'stale device list');
    const originalRecord = await a1.store.getSessionRecord(bob.address());
    expect(originalRecord?.currentSession).toBeTruthy();
    const kinds = { bigint: 0, map: 0, bytes: 0 };
    const inspect = (value: unknown): void => {
      if (typeof value === 'bigint') kinds.bigint++;
      else if (value instanceof Uint8Array) kinds.bytes++;
      else if (value instanceof Map) {
        kinds.map++;
        for (const entry of value.values()) inspect(entry);
      } else if (value && typeof value === 'object')
        for (const entry of Object.values(value)) inspect(entry);
    };
    inspect(originalRecord);
    expect(kinds.bigint).toBeGreaterThan(0);
    expect(kinds.map).toBe(0);
    expect(kinds.bytes).toBeGreaterThan(0);
    expect(() => SessionRecord.serialize(originalRecord!)).toThrow();
    const retainedPrekey = await a1.store.getEcSignedPreKey(undefined, 'aci');
    for (const client of clients.splice(0)) await client.stop();
    for (const store of stores.splice(0)) await store.close();
    a1 = await open('a1.db', 'alice', 1);
    a2 = await open('a2.db', 'alice', 2);
    b1 = await open('b1.db', 'bob', 1);
    expect(isDeepStrictEqual(await a1.store.getSessionRecord(bob.address()), originalRecord)).toBe(
      true,
    );
    expect(
      isDeepStrictEqual(await a1.store.getEcSignedPreKey(undefined, 'aci'), retainedPrekey),
    ).toBe(true);
    expect(await a1.store.getLocalRegistrationId('aci')).toBe(1);
    expect(await a2.store.getLocalRegistrationId('aci')).toBe(2);
    expect(await b1.store.getLocalRegistrationId('aci')).toBe(3);
    alice1 = await start(a1);
    alice2 = await start(a2);
    bob = await start(b1);
    expect(await alice2.decryptMessage(bob.address(), queuedForA2)).toBe(
      'queued before revocation',
    );
    expect(await alice2.decryptMessage(bob.address(), staleDelivery)).toBe('stale device list');
    expect(() => relay.fetch('alice:2')).toThrow();
    expect(await alice1.hasSession(bob.address())).toBe(true);
    expect(await alice2.hasSession(bob.address())).toBe(true);
    expect(await bob.hasSession(alice1.address())).toBe(true);
    expect(await bob.hasSession(alice2.address())).toBe(true);
    expect(
      await bob.decryptMessage(
        alice1.address(),
        await alice1.encryptMessage(bob.address(), 'resumed-a1'),
      ),
    ).toBe('resumed-a1');
    expect(
      await bob.decryptMessage(
        alice2.address(),
        await alice2.encryptMessage(bob.address(), 'resumed-a2'),
      ),
    ).toBe('resumed-a2');
    expect(
      await alice1.decryptMessage(
        bob.address(),
        await bob.encryptMessage(alice1.address(), 'fanout-a1'),
      ),
    ).toBe('fanout-a1');
    expect(
      await alice2.decryptMessage(
        bob.address(),
        await bob.encryptMessage(alice2.address(), 'fanout-a2'),
      ),
    ).toBe('fanout-a2');
  } finally {
    const stopped = await Promise.allSettled(clients.map((client) => client.stop()));
    const closed = await Promise.allSettled(stores.map((store) => store.close()));
    for (const secret of secrets.values()) secret.fill(0);
    const removed = await Promise.allSettled([rm(directory, { recursive: true, force: true })]);
    expect(
      [...stopped, ...closed, ...removed].every((result) => result.status === 'fulfilled'),
    ).toBe(true);
  }
}, 60000);

it('characterizes registration ID limits without changing SDK or import policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bunny-registration-'));
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
  try {
    const identity = await generateIdentityKeyPair();
    for (const id of [16380, 16381, 16382, 16383]) {
      if (id === 16380) expect(prepareImportedIdentity(identity, id).registrationId).toBe(id);
      else expect(() => prepareImportedIdentity(identity, id)).toThrow();
      const store = await nodeStore({ directory, name: `${id}.db`, vault });
      stores.push(store);
      await store.storeIdentityKey({ ...identity, registrationId: id }, 'aci');
      expect(await store.getLocalRegistrationId('aci')).toBe(id);
      expect((await store.getIdentityKey('aci'))?.registrationId).toBe(id);
    }
  } finally {
    const closed = await Promise.allSettled(stores.map((store) => store.close()));
    for (const secret of secrets.values()) secret.fill(0);
    const removed = await Promise.allSettled([rm(directory, { recursive: true, force: true })]);
    expect([...closed, ...removed].every((result) => result.status === 'fulfilled')).toBe(true);
  }
});
