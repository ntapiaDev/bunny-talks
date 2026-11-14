import { createSignalProtocolClient } from '@open-e2ee/signal-protocol-sdk/client';
import { base64ToBytes, bytesToBase64 } from '@open-e2ee/signal-protocol-sdk/encoding';
import type { PreKeyBundle } from '@open-e2ee/signal-protocol-sdk/keys';
import {
  generateEcSignedPreKey,
  generateIdentityKeyPair,
  generateKyberLastResortPreKey,
} from '@open-e2ee/signal-protocol-sdk/keys';
import type { ExpoSignalProtocolStore } from '@open-e2ee/signal-protocol-sdk/local/store/expo';
import { expoStore } from '@open-e2ee/signal-protocol-sdk/local/store/expo';
import { ExpoSecureStoreSignalProtocolSecretVault } from '@open-e2ee/signal-protocol-sdk/local/vault/expo-secure-store';
import { asBase64 } from '@open-e2ee/signal-protocol-sdk/types/utils';
import { CryptoDigestAlgorithm, digestStringAsync, getRandomValues } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { openDatabaseAsync } from 'expo-sqlite';
import { importIdentity, validateExportedIdentity } from '@bunny-talks/crypto-engine';
import { assertFreshDiagnosticStores } from './initial-state';
import { checkWitness } from './witness';

type Client = Awaited<ReturnType<typeof createSignalProtocolClient>>;
type Device = {
  name: string;
  userId: string;
  deviceId: number;
  registrationId: number;
  store: ExpoSignalProtocolStore;
};
export type DiagnosticEntry = {
  label: string;
  status: 'pass' | 'fail' | 'info';
  durationMs?: number;
};

const witnessKey = 'bunny.diagnostic.witness.v1';
let processToken: string | undefined;

async function publicWitness(devices: Device[]): Promise<string> {
  const identities = await Promise.all(
    devices.map(async (device) => {
      const identity = await device.store.getIdentityKey('aci');
      const signed = await device.store.getEcSignedPreKey(undefined, 'aci');
      const kem = await device.store.getKyberPreKey('aci');
      requireCondition(identity && signed && kem);
      validateExportedIdentity(identity);
      requireCondition(
        identity.registrationId === device.registrationId &&
          (await device.store.getLocalRegistrationId('aci')) === device.registrationId,
      );
      return {
        registrationId: device.registrationId,
        dh: identity.dhKey.publicKey,
        signing: identity.signingKey.publicKey,
        ecId: signed.keyId,
        ec: signed.publicKey,
        kemId: kem.keyId,
        kem: kem.publicKey,
      };
    }),
  );
  const [a1, a2, b] = devices;
  requireCondition(a1 && a2 && b);
  requireCondition(
    identities[0]?.dh === identities[1]?.dh &&
      identities[0]?.signing === identities[1]?.signing &&
      identities[0]?.dh !== identities[2]?.dh &&
      identities[0]?.ec !== identities[1]?.ec &&
      identities[0]?.kem !== identities[1]?.kem,
  );
  const sessions = await Promise.all([
    a1.store.getSessionRecord({ userId: 'bob', deviceId: 1 }),
    a2.store.getSessionRecord({ userId: 'bob', deviceId: 1 }),
    b.store.getSessionRecord({ userId: 'alice', deviceId: 1 }),
    b.store.getSessionRecord({ userId: 'alice', deviceId: 2 }),
  ]);
  const markers = sessions.map((record) => {
    const session = record?.currentSession;
    requireCondition(session);
    return { baseKey: session.baseKey, ns: session.Ns, nr: session.Nr };
  });
  requireCondition(markers[0]?.baseKey !== markers[1]?.baseKey);
  return digestStringAsync(
    CryptoDigestAlgorithm.SHA256,
    JSON.stringify({ identities, sessions: markers }),
  );
}

function requireCondition(condition: unknown): asserts condition {
  if (!condition) throw new Error('Diagnostic assertion failed');
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

async function bundle(device: Device): Promise<PreKeyBundle> {
  const identity = await device.store.getIdentityKey('aci');
  const signed = await device.store.getEcSignedPreKey(undefined, 'aci');
  const kem = await device.store.getKyberPreKey('aci');
  requireCondition(identity && signed && kem);
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
}

// Diagnostics use isolated persistent test databases, never account data.
export async function runDiagnostics(report: (entry: DiagnosticEntry) => void): Promise<void> {
  const openStores = new Set<ExpoSignalProtocolStore>();
  const clients = new Set<Client>();
  let stage = 'Runtime Hermes';
  const complete = (label: string, started?: number) =>
    report({
      label,
      status: 'pass',
      ...(started === undefined ? {} : { durationMs: Math.round(performance.now() - started) }),
    });
  const open = async (
    name: string,
    userId: string,
    deviceId: number,
    registrationId: number,
  ): Promise<Device> => {
    const store = await expoStore({ name });
    openStores.add(store);
    return { name, userId, deviceId, registrationId, store };
  };
  const start = async (device: Device) => {
    const client = await createSignalProtocolClient({
      identity: { userId: device.userId, deviceId: device.deviceId },
      adapters: { storage: device.store },
    });
    clients.add(client);
    return client;
  };
  const closeAll = async () => {
    let failed = false;
    for (const client of clients) {
      try {
        await client.stop();
        clients.delete(client);
      } catch {
        failed = true;
      }
    }
    for (const store of openStores) {
      try {
        await store.close();
        openStores.delete(store);
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error('Resource cleanup failed');
  };
  try {
    requireCondition('HermesInternal' in globalThis);
    requireCondition(globalThis.crypto?.getRandomValues === getRandomValues);
    const bytes = new Uint8Array(32);
    requireCondition(crypto.getRandomValues(bytes) === bytes && bytes.some((value) => value !== 0));
    requireCondition(typeof BigInt === 'function' && BigInt(7) + BigInt(1) === BigInt(8));
    const map = new Map([['test', Uint8Array.of(1, 2)]]);
    requireCondition(map.get('test')?.[1] === 2);
    const encoded = bytesToBase64(Uint8Array.of(0, 127, 255));
    requireCondition(encoded === 'AH//' && base64ToBytes(asBase64(encoded))[2] === 255);
    processToken ??= bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
    complete(stage);

    stage = 'UTF-8 strict';
    try {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      requireCondition(decoder.decode(encoder.encode('Bunny 🐇')) === 'Bunny 🐇');
      let invalidUtf8Rejected = false;
      try {
        decoder.decode(Uint8Array.of(0xff));
      } catch {
        invalidUtf8Rejected = true;
      }
      requireCondition(invalidUtf8Rejected);
      complete(stage);
    } catch {
      report({ label: stage, status: 'fail' });
    }

    stage = 'Présence de SQLCipher';
    const probe = await openDatabaseAsync(':memory:', { useNewConnection: true });
    try {
      const version = await probe.getFirstAsync<{ cipher_version: string }>(
        'PRAGMA cipher_version',
      );
      requireCondition(
        typeof version?.cipher_version === 'string' && version.cipher_version.length > 0,
      );
    } finally {
      await probe.closeAsync();
    }
    complete(stage);

    stage = 'Témoin SecureStore';
    const saved = await SecureStore.getItemAsync(witnessKey);
    const witness = saved;

    stage = 'Ouverture SQLCipher et identité';
    const opening = performance.now();
    let a1 = await open('bunny-diagnostic-a1.db', 'alice', 1, 101);
    let a2 = await open('bunny-diagnostic-a2.db', 'alice', 2, 102);
    let b = await open('bunny-diagnostic-b.db', 'bob', 1, 103);
    const existing = await Promise.all([a1, a2, b].map((d) => d.store.getIdentityKey('aci')));
    if (existing.every((identity) => identity === null)) {
      requireCondition(witness === null);
      // Do not overwrite a store left partially initialized by an interrupted run.
      await assertFreshDiagnosticStores(a1.store, a2.store, b.store);
      const alice = await generateIdentityKeyPair();
      const bob = await generateIdentityKeyPair();
      await importIdentity(a1.store, alice, a1.registrationId);
      await importIdentity(a2.store, alice, a2.registrationId);
      await importIdentity(b.store, bob, b.registrationId);
      for (const device of [a1, a2, b]) {
        const identity = await device.store.getIdentityKey('aci');
        requireCondition(identity);
        await device.store.storeEcSignedPreKey(await generateEcSignedPreKey(identity), 'aci');
        await device.store.storeKyberPreKey(await generateKyberLastResortPreKey(identity), 'aci');
      }
    } else requireCondition(existing.every((identity) => identity !== null));
    const alice1Identity = await a1.store.getIdentityKey('aci');
    const alice2Identity = await a2.store.getIdentityKey('aci');
    requireCondition(alice1Identity && alice2Identity);
    validateExportedIdentity(alice1Identity);
    validateExportedIdentity(alice2Identity);
    requireCondition(
      alice1Identity.dhKey.publicKey === alice2Identity.dhKey.publicKey &&
        alice1Identity.signingKey.publicKey === alice2Identity.signingKey.publicKey,
    );
    for (const device of [a1, a2, b]) {
      requireCondition(
        (await device.store.getLocalRegistrationId('aci')) === device.registrationId,
      );
      requireCondition(await device.store.getEcSignedPreKey(undefined, 'aci'));
      requireCondition(await device.store.getKyberPreKey('aci'));
    }
    let replacementRejected = false;
    try {
      await importIdentity(a2.store, alice1Identity, a2.registrationId);
    } catch (error) {
      replacementRejected = errorCode(error) === 'KEY_ACCESS_DENIED';
    }
    requireCondition(replacementRejected);
    complete(stage, opening);

    stage = 'Vérification du témoin';
    if (witness !== null) {
      const result = checkWitness(witness, await publicWitness([a1, a2, b]), processToken);
      report({
        label:
          result === 'same-process'
            ? 'Témoin vérifié dans le même processus'
            : 'Témoin vérifié après nouveau runtime JS',
        status: result === 'same-process' ? 'info' : 'pass',
      });
    } else {
      report({
        label: 'Premier témoin : redémarrage requis pour vérifier la persistance',
        status: 'info',
      });
    }

    stage = 'Session et échanges locaux';
    let alice = await start(a1);
    let alice2 = await start(a2);
    let bob = await start(b);
    if (!(await alice.hasSession(bob.address()))) {
      requireCondition(witness === null);
      const begin = performance.now();
      await alice.establishSession(bob.address(), await bundle(b));
      complete('Établissement de session', begin);
    }
    if (!(await alice2.hasSession(bob.address()))) {
      requireCondition(witness === null);
      await alice2.establishSession(bob.address(), await bundle(b));
    }
    for (let i = 0; i < 3; i++) {
      const begin = performance.now();
      const encrypted = await alice.encryptMessage(bob.address(), `diagnostic ${i}`);
      const encryptionMs = Math.round(performance.now() - begin);
      const decryptBegin = performance.now();
      requireCondition(
        (await bob.decryptMessage(alice.address(), encrypted)) === `diagnostic ${i}`,
      );
      if (i === 0) {
        report({ label: 'Chiffrement', status: 'pass', durationMs: encryptionMs });
        complete('Déchiffrement', decryptBegin);
      }
    }
    requireCondition(
      (await alice.decryptMessage(
        bob.address(),
        await bob.encryptMessage(alice.address(), 'réponse'),
      )) === 'réponse',
    );
    requireCondition(
      (await bob.decryptMessage(
        alice2.address(),
        await alice2.encryptMessage(bob.address(), 'initialisation a2'),
      )) === 'initialisation a2',
    );
    const toA1 = await bob.encryptMessage(alice.address(), 'fanout');
    const toA2 = await bob.encryptMessage(alice2.address(), 'fanout');
    requireCondition((await alice.decryptMessage(bob.address(), toA1)) === 'fanout');
    requireCondition((await alice2.decryptMessage(bob.address(), toA2)) === 'fanout');
    complete(stage);

    stage = 'Fermeture et refus des clés invalides';
    await closeAll();
    const noKeyConnection = await openDatabaseAsync(a1.name, { useNewConnection: true });
    try {
      let rejected = false;
      try {
        await noKeyConnection.getFirstAsync('SELECT count(*) FROM sqlite_master');
      } catch (error) {
        rejected = error instanceof Error && /not a database|SQLITE_NOTADB/i.test(error.message);
      }
      requireCondition(rejected);
    } finally {
      await noKeyConnection.closeAsync();
    }
    const secureVault = new ExpoSecureStoreSignalProtocolSecretVault();
    for (const mode of ['missing', 'wrong'] as const) {
      const vault = {
        async getSecret(name: string) {
          if (mode === 'missing') return null;
          const key = await secureVault.getSecret(name);
          requireCondition(key && key.length > 0);
          const wrong = key.slice();
          wrong[0] = wrong[0]! ^ 1;
          return wrong;
        },
        async setSecret(): Promise<void> {
          throw new Error('Unexpected vault write');
        },
        async deleteSecret(): Promise<void> {
          throw new Error('Unexpected vault deletion');
        },
      };
      let refused = false;
      let unexpected: ExpoSignalProtocolStore | undefined;
      try {
        unexpected = await expoStore({ name: a1.name, vault });
      } catch (error) {
        refused =
          errorCode(error) === (mode === 'missing' ? 'LOCAL_STORE_KEY_LOST' : 'KEY_STORAGE_ERROR');
      }
      if (unexpected) await unexpected.close();
      requireCondition(refused);
    }
    complete(stage);

    stage = 'Refus d’une base de test non chiffrée';
    // This dedicated fixture contains no account data and is never reset or deleted.
    const plaintextName = 'bunny-diagnostic-plaintext-fixture-v1.db';
    const plaintext = await openDatabaseAsync(plaintextName, { useNewConnection: true });
    try {
      const pages = await plaintext.getFirstAsync<{ page_count: number }>('PRAGMA page_count');
      if (pages?.page_count === 0) {
        await plaintext.execAsync('CREATE TABLE bunny_plaintext_fixture (marker INTEGER NOT NULL)');
        await plaintext.execAsync('PRAGMA application_id = 1112821321');
      }
      const id = await plaintext.getFirstAsync<{ application_id: number }>('PRAGMA application_id');
      const tables = await plaintext.getAllAsync<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      );
      requireCondition(
        id?.application_id === 1112821321 &&
          tables.length === 1 &&
          tables[0]?.name === 'bunny_plaintext_fixture',
      );
    } finally {
      await plaintext.closeAsync();
    }
    const fixtureKey = crypto.getRandomValues(new Uint8Array(32));
    let plaintextRefused = false;
    let unexpectedPlaintext: ExpoSignalProtocolStore | undefined;
    try {
      unexpectedPlaintext = await expoStore({
        name: plaintextName,
        vault: {
          async getSecret() {
            return fixtureKey.slice();
          },
          async setSecret() {
            throw new Error('Unexpected vault write');
          },
          async deleteSecret() {
            throw new Error('Unexpected vault deletion');
          },
        },
      });
    } catch (error) {
      plaintextRefused = errorCode(error) === 'KEY_STORAGE_ERROR';
    } finally {
      fixtureKey.fill(0);
      if (unexpectedPlaintext) await unexpectedPlaintext.close();
    }
    requireCondition(plaintextRefused);
    const plaintextReopen = await openDatabaseAsync(plaintextName, { useNewConnection: true });
    try {
      const id = await plaintextReopen.getFirstAsync<{ application_id: number }>(
        'PRAGMA application_id',
      );
      requireCondition(id?.application_id === 1112821321);
    } finally {
      await plaintextReopen.closeAsync();
    }
    complete(stage);

    stage = 'Réouverture et reprise';
    a1 = await open(a1.name, a1.userId, a1.deviceId, a1.registrationId);
    a2 = await open(a2.name, a2.userId, a2.deviceId, a2.registrationId);
    b = await open(b.name, b.userId, b.deviceId, b.registrationId);
    for (const device of [a1, a2, b])
      requireCondition(
        (await device.store.getLocalRegistrationId('aci')) === device.registrationId,
      );
    const reloaded = await a2.store.getIdentityKey('aci');
    requireCondition(
      reloaded &&
        reloaded.dhKey.publicKey === alice1Identity.dhKey.publicKey &&
        reloaded.signingKey.publicKey === alice1Identity.signingKey.publicKey,
    );
    validateExportedIdentity(reloaded);
    for (const device of [a1, a2, b]) {
      requireCondition(await device.store.getEcSignedPreKey(undefined, 'aci'));
      requireCondition(await device.store.getKyberPreKey('aci'));
    }
    alice = await start(a1);
    alice2 = await start(a2);
    bob = await start(b);
    requireCondition(
      (await alice.hasSession(bob.address())) && (await bob.hasSession(alice.address())),
    );
    requireCondition(
      (await bob.decryptMessage(
        alice.address(),
        await alice.encryptMessage(bob.address(), 'reprise'),
      )) === 'reprise',
    );
    requireCondition(
      (await alice.decryptMessage(
        bob.address(),
        await bob.encryptMessage(alice.address(), 'réponse reprise'),
      )) === 'réponse reprise',
    );
    requireCondition(
      (await alice2.hasSession(bob.address())) && (await bob.hasSession(alice2.address())),
    );
    requireCondition(
      (await alice2.decryptMessage(
        bob.address(),
        await bob.encryptMessage(alice2.address(), 'reprise a2'),
      )) === 'reprise a2',
    );
    const state = await publicWitness([a1, a2, b]);
    complete(stage);
    stage = 'Libération des ressources';
    await closeAll();
    complete(stage);
    stage = 'Enregistrement du témoin';
    await SecureStore.setItemAsync(witnessKey, JSON.stringify({ process: processToken, state }));
    requireCondition(
      (await SecureStore.getItemAsync(witnessKey)) ===
        JSON.stringify({ process: processToken, state }),
    );
    complete(stage);
  } catch {
    report({ label: stage, status: 'fail' });
  } finally {
    try {
      await closeAll();
    } catch {
      report({ label: 'Libération des ressources', status: 'fail' });
    }
  }
}
