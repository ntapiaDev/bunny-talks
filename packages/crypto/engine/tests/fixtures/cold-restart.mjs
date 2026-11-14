import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { deserialize, serialize } from 'node:v8';

const sdk = process.argv[4] ?? '@open-e2ee/signal-protocol-sdk';
const { createSignalProtocolClient } = await import(`${sdk}/client`);
const { generateEcSignedPreKey, generateIdentityKeyPair, generateKyberLastResortPreKey } =
  await import(`${sdk}/keys`);
const { nodeStore } = await import(`${sdk}/local/store/node`);

// Test-only plaintext secret files, protected by the parent test's private temporary directory.
// This is not a production vault and is deliberately isolated per device.
const [directory, phase] = process.argv.slice(2);
const stores = [];
const clients = [];
const open = async (device) => {
  const path = join(directory, `${device}.secret`);
  const vault = {
    async getSecret() {
      try {
        if (phase === 'missing-key') return null;
        const secret = new Uint8Array(await readFile(path));
        if (phase === 'wrong-key') secret[0] ^= 1;
        return secret;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async setSecret(_name, value) {
      await writeFile(path, value, { mode: 0o600, flag: 'wx' });
    },
    async deleteSecret() {
      throw new Error('Unexpected secret deletion');
    },
  };
  const store = await nodeStore({ directory, name: `${device}.db`, vault });
  stores.push(store);
  return store;
};
const start = async (userId, storage) => {
  const client = await createSignalProtocolClient({ identity: { userId }, adapters: { storage } });
  clients.push(client);
  return client;
};
const check = (condition) => {
  if (!condition) throw new Error('Cold restart assertion failed');
};
const snapshot = async (a, b) =>
  Promise.all(
    [a, b].map(async (store, index) => ({
      identity: await store.getIdentityKey('aci'),
      signed: await store.getEcSignedPreKey(undefined, 'aci'),
      kem: await store.getKyberPreKey('aci'),
      session: await store.getSessionRecord({ userId: index === 0 ? 'bob' : 'alice', deviceId: 1 }),
    })),
  );
try {
  if (phase === 'missing-key' || phase === 'wrong-key') {
    let refused = false;
    try {
      await open('alice');
    } catch (error) {
      check(
        error.code === (phase === 'missing-key' ? 'LOCAL_STORE_KEY_LOST' : 'KEY_STORAGE_ERROR'),
      );
      refused = true;
    }
    check(refused);
  } else {
    const aliceStore = await open('alice');
    const bobStore = await open('bob');
    if (phase === 'prepare') {
      const aliceIdentity = { ...(await generateIdentityKeyPair()), registrationId: 41 };
      const bobIdentity = { ...(await generateIdentityKeyPair()), registrationId: 42 };
      await aliceStore.storeIdentityKey(aliceIdentity, 'aci');
      await bobStore.storeIdentityKey(bobIdentity, 'aci');
      const signed = await generateEcSignedPreKey(bobIdentity);
      const kem = await generateKyberLastResortPreKey(bobIdentity);
      await bobStore.storeEcSignedPreKey(signed, 'aci');
      await bobStore.storeKyberPreKey(kem, 'aci');
      const alice = await start('alice', aliceStore);
      const bob = await start('bob', bobStore);
      await alice.establishSession(bob.address(), {
        registrationId: 42,
        deviceId: 1,
        identity: {
          version: 1,
          x25519PublicKey: bobIdentity.dhKey.publicKey,
          ed25519PublicKey: bobIdentity.signingKey.publicKey,
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
      check(
        (await bob.decryptMessage(
          alice.address(),
          await alice.encryptMessage(bob.address(), 'before restart'),
        )) === 'before restart',
      );
      check(
        (await alice.decryptMessage(
          bob.address(),
          await bob.encryptMessage(alice.address(), 'before reply'),
        )) === 'before reply',
      );
      await writeFile(
        join(directory, 'snapshot.bin'),
        serialize(await snapshot(aliceStore, bobStore)),
        { mode: 0o600 },
      );
    } else if (phase === 'resume') {
      check(
        (await aliceStore.getLocalRegistrationId('aci')) === 41 &&
          (await bobStore.getLocalRegistrationId('aci')) === 42,
      );
      const expected = deserialize(await readFile(join(directory, 'snapshot.bin')));
      const actual = await snapshot(aliceStore, bobStore);
      check(isDeepStrictEqual(actual, expected));
      const alice = await start('alice', aliceStore);
      const bob = await start('bob', bobStore);
      check((await alice.hasSession(bob.address())) && (await bob.hasSession(alice.address())));
      check(
        (await bob.decryptMessage(
          alice.address(),
          await alice.encryptMessage(bob.address(), 'after restart'),
        )) === 'after restart',
      );
      check(
        (await alice.decryptMessage(
          bob.address(),
          await bob.encryptMessage(alice.address(), 'after reply'),
        )) === 'after reply',
      );
    } else throw new Error('Invalid phase');
  }
} finally {
  for (const client of clients) await client.stop();
  for (const store of stores) await store.close();
}
