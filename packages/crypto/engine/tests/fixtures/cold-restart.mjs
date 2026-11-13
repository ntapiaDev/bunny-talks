import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { createSignalProtocolClient } from '@open-e2ee/signal-protocol-sdk/client';
import {
  generateEcSignedPreKey,
  generateIdentityKeyPair,
  generateKyberLastResortPreKey,
} from '@open-e2ee/signal-protocol-sdk/keys';
import { nodeStore } from '@open-e2ee/signal-protocol-sdk/local/store/node';

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
        return new Uint8Array(await readFile(path));
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
try {
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
      kemLastResortPreKey: { keyId: kem.keyId, publicKey: kem.publicKey, signature: kem.signature },
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
  } else if (phase === 'resume') {
    check(
      (await aliceStore.getLocalRegistrationId('aci')) === 41 &&
        (await bobStore.getLocalRegistrationId('aci')) === 42,
    );
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
} finally {
  for (const client of clients) await client.stop();
  for (const store of stores) await store.close();
}
