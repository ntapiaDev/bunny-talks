import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createSignalProtocolClient } from '@open-e2ee/signal-protocol-sdk/client';
import { bytesToBase64 } from '@open-e2ee/signal-protocol-sdk/encoding';
import {
  generateEcSignedPreKey,
  generateIdentityKeyPair,
  generateKyberLastResortPreKey,
} from '@open-e2ee/signal-protocol-sdk/keys';
import type { ExpoSignalProtocolStore } from '@open-e2ee/signal-protocol-sdk/local/store/expo';
import { inMemoryStore } from '@open-e2ee/signal-protocol-sdk/local/store/memory';
import { Directory, File } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { defaultDatabaseDirectory, openDatabaseAsync } from 'expo-sqlite';
import {
  ExpoLocalStoreError,
  localExpoStorePaths,
  openExistingStore,
  openFreshStore,
} from '../../../src/infrastructure/crypto/expo-local-store';
import {
  initializeLocalCrypto,
  LocalCryptoInitializationError,
} from '../../../src/infrastructure/crypto/local-crypto-initialization';
import { initializationMetadataKey } from '../../../src/infrastructure/crypto/restricted-signal-store';
import { applicationVaultArgon2Provider } from '../composition/crypto-composition';
import type { DiagnosticEntry } from './diagnostic-entry';

type Report = (entry: DiagnosticEntry) => void;
type Boundary = 'reservation' | 'identity' | 'ready';
type Operation = Boundary | 'allocation' | 'key';
type Event = 'attempt' | 'completed' | 'uncertain';
type Ready = Awaited<ReturnType<typeof initializeLocalCrypto>>;
type Corruption =
  'missing-file' | 'missing-key' | 'empty' | 'truncated' | 'aligned-corruption' | 'wrong-key';
const coordinationName = 'bunny-local-crypto-reservations.db';
type OpenFailure = ExpoLocalStoreError['code'] | 'FOREIGN' | null;

const password = 'Public synthetic first-device qualification password';
const keyOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const processToken = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
const encoder = new TextEncoder();

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('Initialization qualification assertion failed');
}

function contextFor(scenario: string) {
  return {
    account: '00000000-0000-4000-8000-000000000031',
    device: `qualification-3b-v2-${scenario}`,
    vaultId: 'AQEBAQEBAQEBAQEBAQEBAQ',
  };
}

function freshRecoveryFixture() {
  // Public input restricted to this qualification package, independent of the password.
  return new Uint8Array(32).fill(0xb3);
}

const digest = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
const publicIdentityDigest = async (store: Pick<ExpoSignalProtocolStore, 'getIdentityKey'>) => {
  const identity = await store.getIdentityKey('aci');
  return identity === null
    ? null
    : digest(
        encoder.encode(
          JSON.stringify([
            identity.dhKey.publicKey,
            identity.signingKey.publicKey,
            identity.registrationId,
          ]),
        ),
      );
};

function metrics(report: Report) {
  const operations = {
    reservation: { attempt: 0, completed: 0, uncertain: 0 },
    identity: { attempt: 0, completed: 0, uncertain: 0 },
    ready: { attempt: 0, completed: 0, uncertain: 0 },
    key: { attempt: 0, completed: 0, uncertain: 0 },
    allocation: { attempt: 0, completed: 0, uncertain: 0 },
  };
  const started = performance.now();
  let previousTick = started;
  let longestDelay = 0;
  let kdf = 0;
  let provisionStarted = 0;
  const timer = setInterval(() => {
    const time = performance.now();
    longestDelay = Math.max(longestDelay, time - previousTick - 40);
    previousTick = time;
  }, 40);
  let stopped = false;
  return {
    operations,
    count(operation: Operation, event: Event) {
      operations[operation][event]++;
      if (operation === 'key') {
        if (event === 'attempt') provisionStarted = performance.now();
        else
          report({
            label: `Provisionnement SQLCipher (${event})`,
            status: 'info',
            durationMs: Math.round(performance.now() - provisionStarted),
          });
      }
    },
    argon2: {
      derive(...args: Parameters<typeof applicationVaultArgon2Provider.derive>) {
        kdf++;
        return applicationVaultArgon2Provider.derive(...args);
      },
    },
    derivations: () => kdf,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      longestDelay = Math.max(longestDelay, performance.now() - previousTick - 40);
      for (const operation of ['allocation', 'key', 'reservation', 'identity', 'ready'] as const) {
        const count = operations[operation];
        report({
          label: `${operation} : ${count.attempt} tentative(s), ${count.completed} écriture(s) aboutie(s), ${count.uncertain} issue(s) incertaine(s)`,
          status: 'info',
        });
      }
      report({ label: `Argon2id : ${kdf} dérivation(s)`, status: 'info' });
      report({
        label: 'Retard maximal du minuteur JS',
        status: 'info',
        durationMs: Math.round(longestDelay),
      });
      report({
        label: 'Durée du scénario',
        status: 'info',
        durationMs: Math.round(performance.now() - started),
      });
    },
  };
}

type Metrics = ReturnType<typeof metrics>;

function monitor(
  store: ExpoSignalProtocolStore,
  measure: Metrics,
  checkpoint?: (boundary: Boundary) => Promise<void>,
) {
  const compare = store.compareAndSetMetadata.bind(store);
  store.compareAndSetMetadata = async (key, previous, next) => {
    if (key !== initializationMetadataKey) return compare(key, previous, next);
    const boundary = previous === null ? 'reservation' : 'ready';
    measure.count(boundary, 'attempt');
    let written: boolean;
    try {
      written = await compare(key, previous, next);
    } catch (error) {
      measure.count(boundary, 'uncertain');
      throw error;
    }
    if (written) {
      measure.count(boundary, 'completed');
      await checkpoint?.(boundary);
    }
    return written;
  };
  const write = store.storeIdentityKey.bind(store);
  store.storeIdentityKey = async (...args) => {
    measure.count('identity', 'attempt');
    try {
      await write(...args);
    } catch (error) {
      measure.count('identity', 'uncertain');
      throw error;
    }
    measure.count('identity', 'completed');
    await checkpoint?.('identity');
  };
  return store;
}

function dependencies(
  report: Report,
  measure: Metrics,
  checkpoint?: (store: ExpoSignalProtocolStore, boundary: Boundary) => Promise<void>,
  openFailure?: { value: OpenFailure },
) {
  async function open(context: ReturnType<typeof contextFor>, fresh: boolean) {
    const started = performance.now();
    try {
      let store: ExpoSignalProtocolStore;
      try {
        store = fresh
          ? await openFreshStore(context, measure.count)
          : await openExistingStore(context);
      } catch (error) {
        if (!fresh && openFailure) {
          openFailure.value = error instanceof ExpoLocalStoreError ? error.code : 'FOREIGN';
        }
        throw error;
      }
      return monitor(store, measure, checkpoint && ((boundary) => checkpoint(store, boundary)));
    } finally {
      report({
        label: fresh ? 'Ouverture en création' : 'Ouverture en reprise',
        status: 'info',
        durationMs: Math.round(performance.now() - started),
      });
    }
  }
  return {
    argon2: measure.argon2,
    random: {
      async fill(bytes: Uint8Array) {
        const sampled = crypto.getRandomValues(new Uint8Array(bytes.byteLength));
        bytes.set(sampled);
        sampled.fill(0);
      },
    },
    openFreshStore: (context: ReturnType<typeof contextFor>) => open(context, true),
    openExistingStore: (context: ReturnType<typeof contextFor>) => open(context, false),
  };
}

async function useComposition(
  scenario: string,
  mode: 'create' | 'password' | 'recovery',
  report: Report,
  measure: Metrics,
  checkpoint?: Parameters<typeof dependencies>[2],
  openFailure?: { value: OpenFailure },
) {
  const recoveryKey = freshRecoveryFixture();
  try {
    return await initializeLocalCrypto(
      contextFor(scenario),
      mode === 'create'
        ? { mode, password, recoveryKey }
        : {
            mode: 'resume',
            access:
              mode === 'password'
                ? { type: 'password', password }
                : { type: 'recovery', recoveryKey },
          },
      dependencies(report, measure, checkpoint, openFailure),
    );
  } finally {
    recoveryKey.fill(0);
  }
}

async function proveProtectedStore(ready: Ready) {
  const storage = ready.storage;
  const original = await publicIdentityDigest(storage);
  const key = 'qualification:ordinary';
  await storage.setMetadata(key, 'original');
  const workId = 'qualification-work';
  assert(
    await storage.putReceiveWork(
      {
        workId,
        revision: 1,
        stage: 'receipt-due',
        origin: 'caller',
        arrivalSeq: 1,
        receivedAt: 1,
        dueAt: 1,
        sizeBytes: 0,
        senderUserId: 'synthetic-peer',
        senderDeviceId: 1,
        messageId: 'synthetic-message',
      },
      null,
    ),
  );
  for (const name of [initializationMetadataKey, 'registrationId:aci', 'registrationId:pni']) {
    await expectRefusal(() => storage.setMetadata(name, 'changed'));
    await expectRefusal(() => storage.deleteMetadata(name));
    await expectRefusal(() => storage.compareAndSetMetadata(name, null, 'changed'));
    await expectRefusal(() =>
      storage.completeReceiveWork(workId, 1, [
        { key, value: 'changed' },
        { key: name, value: null },
      ]),
    );
    assert((await storage.getMetadata(key)) === 'original');
    assert((await storage.getReceiveWork(workId)) !== null);
  }
  assert(await storage.completeReceiveWork(workId, 1, [{ key, value: 'completed' }]));
  assert((await storage.getMetadata(key)) === 'completed');
  assert((await publicIdentityDigest(storage)) === original);
}

async function expectRefusal(action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error('Expected qualification refusal');
}

async function expectOpenRefusal(open: () => Promise<{ close(): Promise<void> }>) {
  const unexpected = await open().catch(() => undefined);
  if (!unexpected) return;
  await unexpected.close();
  throw new Error('Unexpected open store');
}

async function expectClassifiedOpenRefusal(
  open: () => Promise<{ close(): Promise<void> }>,
  expected: ExpoLocalStoreError['code'],
  openFailure: { value: OpenFailure },
) {
  try {
    const unexpected = await open();
    await unexpected.close();
    throw new Error('Unexpected open store');
  } catch (error) {
    const observed =
      openFailure.value ?? (error instanceof ExpoLocalStoreError ? error.code : null);
    const wrappedByComposition =
      error instanceof LocalCryptoInitializationError && error.code === 'UNAVAILABLE';
    const directAdapterRefusal = error instanceof ExpoLocalStoreError;
    if ((!wrappedByComposition && !directAdapterRefusal) || observed !== expected) {
      throw new Error(`REFUSAL_CLASSIFICATION expected=${expected} observed=${observed ?? 'NONE'}`);
    }
  }
}

async function proveExchange(ready: Ready) {
  const storage = inMemoryStore();
  const identity = { ...(await generateIdentityKeyPair()), registrationId: 41 };
  await storage.storeIdentityKey(identity, 'aci');
  await storage.setLocalRegistrationId(41, 'aci');
  const signed = await generateEcSignedPreKey(identity);
  const kem = await generateKyberLastResortPreKey(identity);
  await storage.storeEcSignedPreKey(signed, 'aci');
  await storage.storeKyberPreKey(kem, 'aci');
  const peer = await createSignalProtocolClient({
    identity: { userId: 'synthetic-peer' },
    adapters: { storage },
    protocol: { contentRecovery: { mode: 'off' } },
  });
  try {
    await ready.client.establishSession(peer.address(), {
      registrationId: 41,
      deviceId: 1,
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
    });
    const message = 'synthetic SQLCipher initialization exchange';
    const ciphertext = await ready.client.encryptMessage(peer.address(), message);
    assert((await peer.decryptMessage(ready.client.address(), ciphertext)) === message);
    assert(await ready.storage.hasSession(peer.address()));
  } finally {
    await peer.stop();
  }
}

async function nominal(report: Report, measure: Metrics) {
  const results = await Promise.allSettled([
    useComposition('nominal', 'create', report, measure),
    useComposition('nominal', 'create', report, measure),
  ]);
  const winners = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  let publication: string;
  let identity: string | null;
  try {
    assert(winners.length === 1);
    const [ready] = winners;
    assert(ready);
    const { operations } = measure;
    assert(
      operations.key.completed === 1 &&
        operations.reservation.completed === 1 &&
        operations.identity.completed === 1 &&
        operations.ready.completed === 1 &&
        measure.derivations() === 2,
    );
    await expectOpenRefusal(() => openExistingStore(contextFor('nominal')));
    await proveProtectedStore(ready);
    await proveExchange(ready);
    publication = digest(ready.publication);
    identity = await publicIdentityDigest(ready.storage);
  } finally {
    await Promise.all(winners.map((winner) => winner.close()));
  }
  for (const [mode, expectedKdf] of [
    ['password', 1],
    ['recovery', 0],
  ] as const) {
    const before = measure.derivations();
    const restored = await useComposition('nominal', mode, report, measure);
    try {
      assert(digest(restored.publication) === publication);
      assert((await publicIdentityDigest(restored.storage)) === identity);
      assert(await restored.storage.hasSession({ userId: 'synthetic-peer', deviceId: 1 }));
      assert(measure.derivations() - before === expectedKdf);
    } finally {
      await restored.close();
    }
  }
  assert(
    Object.entries(measure.operations).every(
      ([operation, count]) =>
        (count.attempt === 1 || (operation === 'allocation' && count.attempt === 2)) &&
        count.completed === 1 &&
        count.uncertain === 0,
    ),
  );
}

async function nativeCoordination(report: Report, measure: Metrics) {
  let owner: Ready | undefined;
  let contender: Ready | undefined;
  let lock: Awaited<ReturnType<typeof openDatabaseAsync>> | undefined;
  try {
    owner = await useComposition('transfer-owner', 'create', report, measure);
    contender = await useComposition('transfer-contender', 'create', report, measure);
    await contender.close();
    contender = undefined;
    report({ label: 'Ouverture d’un autre contexte après transfert de garde', status: 'pass' });

    lock = await openDatabaseAsync(coordinationName, { useNewConnection: true });
    await lock.execAsync('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
    const contentionFailure = { value: null as OpenFailure };
    await expectClassifiedOpenRefusal(
      () => openExistingStore(contextFor('transfer-contender')),
      'UNAVAILABLE',
      contentionFailure,
    );
    await lock.execAsync('ROLLBACK');
    await lock.closeAsync();
    lock = undefined;

    contender = await initializeLocalCrypto(
      contextFor('transfer-contender'),
      { mode: 'resume', access: { type: 'password', password } },
      dependencies(report, measure),
    );
    report({ label: 'Contention entre connexions SQLite natives indépendantes', status: 'pass' });
  } finally {
    await lock?.execAsync('ROLLBACK').catch(() => undefined);
    await lock?.closeAsync().catch(() => undefined);
    await Promise.all([owner?.close(), contender?.close()]);
  }
}

const witnessSlot = (boundary: Boundary) => `bunny.crypto-initialization.${boundary}.witness`;

async function prepareStop(boundary: Boundary, report: Report, measure: Metrics) {
  const ready = await useComposition(
    `stop-${boundary}`,
    'create',
    report,
    measure,
    async (store, current) => {
      if (current !== boundary) return;
      const raw = await store.getMetadata(initializationMetadataKey);
      assert(raw);
      const attempt = JSON.parse(raw) as { publication: string; status: string };
      assert(attempt.status === (boundary === 'ready' ? 'ready' : 'pending'));
      const identity = await publicIdentityDigest(store);
      assert((identity === null) === (boundary === 'reservation'));
      await SecureStore.setItemAsync(
        witnessSlot(boundary),
        JSON.stringify({
          process: processToken,
          publication: digest(encoder.encode(attempt.publication)),
          identity,
        }),
        keyOptions,
      );
      measure.stop();
      report({
        label: `Frontière ${boundary} persistée. Arrêter uniquement ce paquet.`,
        status: 'info',
      });
      // Invocation intentionally parked until Android stops this process.
      await new Promise<never>(() => undefined);
    },
  );
  await ready.close();
  throw new Error('Checkpoint not reached');
}

async function resumeStop(boundary: Boundary, report: Report, measure: Metrics) {
  const raw = await SecureStore.getItemAsync(witnessSlot(boundary), keyOptions);
  assert(raw);
  const witness = JSON.parse(raw) as {
    process: string;
    publication: string;
    identity: string | null;
  };
  assert(/^[a-f0-9]{32}$/u.test(witness.process) && witness.process !== processToken);
  assert(
    /^[a-f0-9]{64}$/u.test(witness.publication) &&
      (boundary === 'reservation'
        ? witness.identity === null
        : typeof witness.identity === 'string' && /^[a-f0-9]{64}$/u.test(witness.identity)),
  );
  const restored = await useComposition(`stop-${boundary}`, 'password', report, measure);
  try {
    assert(digest(restored.publication) === witness.publication);
    const identity = await publicIdentityDigest(restored.storage);
    assert(identity !== null && (witness.identity === null || identity === witness.identity));
    const expected: Record<Operation, number> = {
      reservation: 0,
      allocation: 0,
      key: 0,
      identity: boundary === 'reservation' ? 1 : 0,
      ready: boundary === 'ready' ? 0 : 1,
    };
    for (const operation of Object.keys(expected) as Operation[]) {
      const count = measure.operations[operation];
      assert(
        count.attempt === expected[operation] &&
          count.completed === expected[operation] &&
          count.uncertain === 0,
      );
    }
    assert(measure.derivations() === 1);
  } finally {
    await restored.close();
  }
}

async function fileOracle(root: Directory, name: string) {
  const result: Record<string, string> = {};
  const entries = root.list();
  assert(entries.some((entry) => entry instanceof File && entry.name === coordinationName));
  let targetWitness = false;
  for (const entry of entries) {
    if (
      entry.name !== name &&
      !entry.name.startsWith(`${name}-`) &&
      !entry.name.startsWith(`${name}.`)
    )
      continue;
    assert(entry instanceof File);
    targetWitness = true;
    const info = entry.info();
    assert(info.exists && info.size !== undefined && info.size <= 1048576);
    result[entry.name] = digest(new Uint8Array(await entry.arrayBuffer()));
  }
  assert(targetWitness);
  return JSON.stringify(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

async function refuseCorruption(scenario: Corruption, report: Report, measure: Metrics) {
  const initial = await useComposition(scenario, 'create', report, measure);
  await initial.close();
  const paths = localExpoStorePaths(contextFor(scenario));
  const root = new Directory(`file://${String(defaultDatabaseDirectory)}`);
  const file = new File(root, paths.name);
  // All mutations below are explicit fixtures in the initialization-only Android package.
  if (scenario === 'missing-file') {
    await file.move(new File(root, `${paths.name}.fixture-held`));
    assert(!new File(root, paths.name).info().exists);
  } else if (scenario === 'missing-key') {
    await SecureStore.deleteItemAsync(paths.slot, keyOptions);
    assert((await SecureStore.getItemAsync(paths.slot, keyOptions)) === null);
  } else if (scenario === 'wrong-key') {
    const wrongKey = crypto.getRandomValues(new Uint8Array(32));
    try {
      const encoded = bytesToBase64(wrongKey);
      assert(encoded !== (await SecureStore.getItemAsync(paths.slot, keyOptions)));
      await SecureStore.setItemAsync(paths.slot, encoded, keyOptions);
    } finally {
      wrongKey.fill(0);
    }
  } else {
    const size = scenario === 'empty' ? 0 : scenario === 'truncated' ? 17 : 512;
    const bytes = new Uint8Array(size);
    if (scenario === 'aligned-corruption') bytes.fill(0xa5);
    file.write(bytes);
    const info = file.info();
    assert(info.exists && info.size === size);
  }
  const expectedFiles = await fileOracle(root, paths.name);
  const expectedKey = await SecureStore.getItemAsync(paths.slot, keyOptions);
  const expectedPending = await SecureStore.getItemAsync(paths.pendingSlot, keyOptions);
  const kdfBefore = measure.derivations();
  const expectedCode =
    scenario === 'missing-key'
      ? 'KEY'
      : scenario === 'wrong-key' || scenario === 'aligned-corruption'
        ? 'SDK'
        : 'FILE';
  const openFailure = { value: null as OpenFailure };
  await expectClassifiedOpenRefusal(
    () => useComposition(scenario, 'password', report, measure, undefined, openFailure),
    expectedCode,
    openFailure,
  );
  report({ label: `Refus classifié : ${expectedCode}`, status: 'info' });
  assert((await fileOracle(root, paths.name)) === expectedFiles);
  assert((await SecureStore.getItemAsync(paths.slot, keyOptions)) === expectedKey);
  assert((await SecureStore.getItemAsync(paths.pendingSlot, keyOptions)) === expectedPending);
  assert(measure.derivations() === kdfBefore);
  assert(
    Object.values(measure.operations).every(
      (count) => count.attempt === 1 && count.completed === 1 && count.uncertain === 0,
    ),
  );
}

function action(label: string, run: (report: Report, measure: Metrics) => Promise<void>) {
  return {
    label,
    async run(report: Report) {
      const measure = metrics(report);
      try {
        await run(report, measure);
        report({ label, status: 'pass' });
      } catch {
        report({ label, status: 'fail' });
      } finally {
        measure.stop();
      }
    },
  };
}

export const initializationActions = [
  action('Création concurrente, reprise et échange', nominal),
  action('Transfert de garde et contention SQLite native', nativeCoordination),
  ...(['reservation', 'identity', 'ready'] as const).flatMap((boundary) => [
    action(`Préparer un arrêt après ${boundary}`, (report, measure) =>
      prepareStop(boundary, report, measure),
    ),
    action(`Reprendre après ${boundary}`, (report, measure) =>
      resumeStop(boundary, report, measure),
    ),
  ]),
  action('Refuser un fichier absent', (report, measure) =>
    refuseCorruption('missing-file', report, measure),
  ),
  action('Refuser une clé absente', (report, measure) =>
    refuseCorruption('missing-key', report, measure),
  ),
  action('Refuser un fichier vide', (report, measure) =>
    refuseCorruption('empty', report, measure),
  ),
  action('Refuser un fichier tronqué', (report, measure) =>
    refuseCorruption('truncated', report, measure),
  ),
  action('Observer le refus d’une corruption SQLite alignée', (report, measure) =>
    refuseCorruption('aligned-corruption', report, measure),
  ),
  action('Observer un refus avec une clé erronée', (report, measure) =>
    refuseCorruption('wrong-key', report, measure),
  ),
];
