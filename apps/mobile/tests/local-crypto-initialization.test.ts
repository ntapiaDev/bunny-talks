import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSignalProtocolClient } from '@open-e2ee/signal-protocol-sdk/client';
import {
  generateEcOneTimePreKeys,
  generateEcSignedPreKey,
  generateIdentityKeyPair,
  generateKyberLastResortPreKey,
} from '@open-e2ee/signal-protocol-sdk/keys';
import { inMemoryStore } from '@open-e2ee/signal-protocol-sdk/local/store/memory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateRecoveryKey,
  openAccountVaultWithPassword,
  openAccountVaultWithRecoveryKey,
} from '@bunny-talks/crypto-backup';
import { decodeRecoveryPayloadV1 } from '@bunny-talks/crypto-backup/experimental';
import { matchesLocalIdentity, readLocalIdentity } from '@bunny-talks/crypto-engine';
import { initializeLocalCrypto } from '../src/infrastructure/crypto/local-crypto-initialization';
import { initializationMetadataKey as key } from '../src/infrastructure/crypto/restricted-signal-store';
import { context, nodeInitializationFixture, password } from './fixtures/node-local-initialization';

type Fixture = ReturnType<typeof nodeInitializationFixture>;
type Store = Awaited<ReturnType<Fixture['openFreshStore']>>;
type Phase = 'reservation' | 'identity' | 'ready';
type Fault = (phase: Phase, timing: 'before' | 'after', value?: string | null) => void;

function monitor(store: Store, fault: Fault) {
  const compare = store.compareAndSetMetadata.bind(store);
  vi.spyOn(store, 'compareAndSetMetadata').mockImplementation(async (name, previous, next) => {
    const phase = previous === null ? 'reservation' : 'ready';
    fault(phase, 'before', next);
    const result = await compare(name, previous, next);
    fault(phase, 'after', next);
    return result;
  });
  const write = store.storeIdentityKey.bind(store);
  vi.spyOn(store, 'storeIdentityKey').mockImplementation(async (...input) => {
    fault('identity', 'before');
    await write(...input);
    fault('identity', 'after');
  });
  return store;
}

async function startFixtureProcess(directory: string, phase: Phase | 'busy') {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./fixtures/local-initialization-interruption.mjs', import.meta.url)),
      directory,
      phase,
    ],
    { stdio: 'ignore' },
  );
  return once(child, 'exit');
}

function fields(raw: string | null) {
  return JSON.parse(raw ?? '{}') as {
    publication?: string;
    status?: string;
    registrationId?: number;
    device?: string;
  };
}

describe('local cryptographic initialization with SQLCipher', () => {
  let directory: string;
  let fixture: Fixture;
  let recoveryKey: Uint8Array;
  const close: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'bunny-local-initialization-'));
    fixture = nodeInitializationFixture(directory);
    recoveryKey = await generateRecoveryKey(fixture.random);
  });

  afterEach(async () => {
    try {
      await Promise.allSettled(close.splice(0).map((cleanup) => cleanup()));
    } finally {
      recoveryKey.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  });

  const create = (dependencies = fixture, secret = recoveryKey) =>
    initializeLocalCrypto(context, { mode: 'create', password, recoveryKey: secret }, dependencies);
  const resume = (dependencies = fixture) =>
    initializeLocalCrypto(
      context,
      { mode: 'resume', access: { type: 'password', password } },
      dependencies,
    );

  async function inspect() {
    const store = await fixture.openExistingStore();
    try {
      return { raw: await store.getMetadata(key), local: await readLocalIdentity(store) };
    } finally {
      await store.close();
    }
  }

  it('reserves one of two candidates and opens the exact publication through both real envelopes', async () => {
    const argon2 = { derive: vi.fn(fixture.argon2.derive) };
    let reserved: string | null | undefined;
    let store: Store | undefined;
    const dependencies = {
      ...fixture,
      argon2,
      async openFreshStore() {
        store = monitor(await fixture.openFreshStore(), (phase, timing, value) => {
          if (phase === 'reservation' && timing === 'after') reserved = value;
        });
        const setLogger = store.setLogger.bind(store);
        vi.spyOn(store, 'setLogger').mockImplementation((logger) => {
          expect(store?.storeIdentityKey).toHaveBeenCalledTimes(1);
          expect(store?.compareAndSetMetadata).toHaveBeenCalledTimes(2);
          setLogger(logger);
        });
        return store;
      },
    };
    const otherKey = await generateRecoveryKey(fixture.random);
    try {
      const results = await Promise.allSettled([
        create(dependencies),
        create(dependencies, otherKey),
      ]);
      const [winner] = results.filter((item) => item.status === 'fulfilled');
      if (winner) close.push(winner.value.close);
      expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
      expect(winner).toBeDefined();
      const ready = winner!.value;
      expect(ready.client.address().deviceId).toBe(1);
      await expect(fixture.openExistingStore()).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(await startFixtureProcess(directory, 'busy')).toEqual([0, null]);
      expect(argon2.derive).toHaveBeenCalledTimes(2);
      const publication = new TextDecoder().decode(ready.publication);
      expect(publication === fields(reserved ?? null).publication).toBe(true);
      const opened = await openAccountVaultWithPassword(
        ready.publication,
        password,
        context,
        fixture.argon2,
      );
      const keyResults = await Promise.all([
        openAccountVaultWithRecoveryKey(ready.publication, recoveryKey, context),
        openAccountVaultWithRecoveryKey(ready.publication, otherKey, context),
      ]);
      expect(keyResults.map((item) => item.ok)).toEqual([
        results[0]?.status === 'fulfilled',
        results[1]?.status === 'fulfilled',
      ]);
      try {
        expect(opened.ok).toBe(true);
        if (opened.ok) {
          const decoded = decodeRecoveryPayloadV1(opened.plaintext);
          expect(decoded.ok && decoded.payload.archiveKeys.length === 0).toBe(true);
          if (decoded.ok)
            for (const bytes of Object.values(decoded.payload.identity)) bytes.fill(0);
        }
      } finally {
        for (const item of [opened, ...keyResults]) if (item.ok) item.plaintext.fill(0);
      }
      await ready.close();
      const durable = await inspect();
      expect(fields(durable.raw).publication === publication).toBe(true);
      expect(fields(durable.raw).status).toBe('ready');
    } finally {
      otherKey.fill(0);
    }
  }, 15000);

  it.each(['reservation', 'identity', 'ready'] as const)(
    'reopens after SIGKILL immediately after %s and performs only the missing writes',
    async (phase) => {
      const result = await startFixtureProcess(directory, phase);
      expect(result).toEqual([null, 'SIGKILL']);
      const before = await inspect();
      expect(fields(before.raw).status).toBe(phase === 'ready' ? 'ready' : 'pending');
      expect(before.local.identity !== null).toBe(phase !== 'reservation');
      const writes: Phase[] = [];
      const ready = await resume({
        ...fixture,
        openExistingStore: async () =>
          monitor(await fixture.openExistingStore(), (name, timing) => {
            if (timing === 'after') writes.push(name);
          }),
      });
      close.push(ready.close);
      expect(writes).toEqual(
        phase === 'reservation' ? ['identity', 'ready'] : phase === 'identity' ? ['ready'] : [],
      );
      expect(new TextDecoder().decode(ready.publication) === fields(before.raw).publication).toBe(
        true,
      );
      await ready.close();
      const after = await inspect();
      expect(fields(after.raw).status).toBe('ready');
      expect(after.local.registrationId).toBe(fields(before.raw).registrationId);
      if (before.local.identity)
        expect(matchesLocalIdentity(after.local, before.local.identity)).toBe(true);
    },
    15000,
  );

  it.each([
    ['reservation', 'before'],
    ['reservation', 'after'],
    ['identity', 'before'],
    ['identity', 'after'],
    ['ready', 'before'],
    ['ready', 'after'],
  ] as const)(
    'reconciles uncertainty on %s %s the write',
    async (phase, timing) => {
      const dependency = {
        ...fixture,
        openFreshStore: async () =>
          monitor(await fixture.openFreshStore(), (candidate, when) => {
            if (candidate === phase && when === timing) throw new Error('Synthetic write fault');
          }),
      };
      if (timing === 'after') {
        const result = await create(dependency);
        close.push(result.close);
        await result.close();
        expect(fields((await inspect()).raw).status).toBe('ready');
        return;
      }
      await expect(create(dependency)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
      const before = await inspect();
      if (phase === 'reservation') {
        expect(before.raw).toBeNull();
        expect(before.local.identity).toBeNull();
        await expect(resume()).rejects.toMatchObject({ code: 'STATE' });
        return;
      }
      expect(fields(before.raw).status).toBe('pending');
      expect(before.local.hasIdentity).toBe(phase === 'ready');
      const result = await resume();
      close.push(result.close);
      expect(new TextDecoder().decode(result.publication) === fields(before.raw).publication).toBe(
        true,
      );
    },
    15000,
  );

  it.each(['reservation', 'identity', 'ready'] as const)(
    'leaves an unreadable %s outcome for the next owner to reconcile',
    async (phase) => {
      let started = false;
      const dependencies = {
        ...fixture,
        async openFreshStore() {
          let unreadable = false;
          const store = monitor(await fixture.openFreshStore(), (current, timing) => {
            if (current === phase && timing === 'after') {
              unreadable = true;
              throw new Error('Synthetic lost write response');
            }
          });
          const metadata = store.getMetadata.bind(store);
          vi.spyOn(store, 'getMetadata').mockImplementation(async (name) => {
            if (unreadable) throw new Error('Synthetic lost connection');
            return metadata(name);
          });
          const identity = store.getIdentityKey.bind(store);
          vi.spyOn(store, 'getIdentityKey').mockImplementation(async (type) => {
            if (unreadable) throw new Error('Synthetic lost connection');
            return identity(type);
          });
          vi.spyOn(store, 'setLogger').mockImplementation(() => {
            started = true;
          });
          return store;
        },
      };
      await expect(create(dependencies)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
      expect(started).toBe(false);
      const durable = await inspect();
      const ready = await resume();
      close.push(ready.close);
      expect(new TextDecoder().decode(ready.publication) === fields(durable.raw).publication).toBe(
        true,
      );
      if (durable.local.identity) {
        expect(
          matchesLocalIdentity(await readLocalIdentity(ready.storage), durable.local.identity),
        ).toBe(true);
      }
    },
    15000,
  );

  it('refuses an absent store on resume and leaves its namespace available for creation', async () => {
    await expect(resume()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const ready = await create();
    close.push(ready.close);
    expect(ready.status).toBe('ready');
  });

  it('rejects a present identity and registration-only state without modifying either', async () => {
    const store = await fixture.openFreshStore();
    const identity = { ...(await generateIdentityKeyPair()), registrationId: 41 };
    try {
      await store.setLocalRegistrationId(41);
    } finally {
      await store.close();
    }
    await expect(resume()).rejects.toMatchObject({ code: 'STATE' });
    const partial = await inspect();
    expect(partial.local.identity).toBeNull();
    expect(partial.local.registrationId).toBe(41);
    const opened = await fixture.openExistingStore();
    await opened.storeIdentityKey(identity);
    await opened.close();
    await expect(
      create({ ...fixture, openFreshStore: fixture.openExistingStore }),
    ).rejects.toMatchObject({ code: 'STATE' });
    await expect(resume()).rejects.toMatchObject({ code: 'STATE' });
    expect(matchesLocalIdentity((await inspect()).local, identity)).toBe(true);
  });

  it('refuses wrong credentials, contexts and damaged records, then resumes by recovery key', async () => {
    const ready = await create();
    close.push(ready.close);
    await ready.close();
    const before = await inspect();
    const attempt = before.raw!;
    for (const access of [
      { type: 'password', password: 'incorrect' },
      { type: 'recovery', recoveryKey: new Uint8Array(32) },
    ] as const) {
      await expect(
        initializeLocalCrypto(context, { mode: 'resume', access }, fixture),
      ).rejects.toMatchObject({ code: 'ACCESS' });
    }
    for (const wrong of [
      { ...context, device: 'wrong-device' },
      { ...context, account: context.vaultId },
      { ...context, vaultId: context.account },
    ]) {
      await expect(
        initializeLocalCrypto(
          wrong,
          { mode: 'resume', access: { type: 'password', password } },
          fixture,
        ),
      ).rejects.toMatchObject({ code: 'CONTEXT' });
    }
    const damagedRecords = [
      ['{', 'STATE'],
      [attempt.replace('{"version":1,', '{"version":1,"version":1,'), 'STATE'],
      [JSON.stringify({ ...fields(attempt), extra: 0 }), 'STATE'],
      [attempt.replace('"publication":"', '"publication":"altered'), 'ACCESS'],
      [attempt.replace(/"registrationId":\d+/u, '"registrationId":0'), 'STATE'],
    ] as const;
    for (const [raw, code] of damagedRecords) {
      const store = await fixture.openExistingStore();
      await store.setMetadata(key, raw);
      await store.close();
      await expect(resume()).rejects.toMatchObject({ code });
      const unchanged = await inspect();
      expect(
        unchanged.raw === raw && matchesLocalIdentity(unchanged.local, before.local.identity!),
      ).toBe(true);
    }
    const store = await fixture.openExistingStore();
    await store.setMetadata(key, attempt);
    await store.close();
    const resumed = await initializeLocalCrypto(
      context,
      { mode: 'resume', access: { type: 'recovery', recoveryKey } },
      fixture,
    );
    close.push(resumed.close);
    expect(new TextDecoder().decode(resumed.publication) === fields(attempt).publication).toBe(
      true,
    );
  }, 15000);

  it.each(['missing identity', 'different identity', 'different ID', 'read failure'] as const)(
    'preserves durable state on %s under ready',
    async (scenario) => {
      const ready = await create();
      close.push(ready.close);
      await ready.close();
      const store = await fixture.openExistingStore();
      const raw = await store.getMetadata(key);
      if (scenario === 'missing identity') await store.deleteIdentityKey('aci');
      if (scenario === 'different identity')
        await store.storeIdentityKey({
          ...(await generateIdentityKeyPair()),
          registrationId: fields(raw).registrationId!,
        });
      if (scenario === 'different ID') {
        await store.setLocalRegistrationId(fields(raw).registrationId === 1 ? 2 : 1);
      }
      await store.close();
      const before = await inspect();
      await expect(
        resume({
          ...fixture,
          async openExistingStore() {
            const opened = await fixture.openExistingStore();
            if (scenario === 'read failure')
              vi.spyOn(opened, 'getIdentityKey').mockRejectedValueOnce(
                new Error('Synthetic read failure'),
              );
            return opened;
          },
        }),
      ).rejects.toMatchObject({ code: scenario === 'read failure' ? 'UNAVAILABLE' : 'STATE' });
      const after = await inspect();
      expect(after.raw === before.raw).toBe(true);
      expect(after.local.registrationId).toBe(before.local.registrationId);
      if (before.local.identity)
        expect(matchesLocalIdentity(after.local, before.local.identity)).toBe(true);
      else expect(after.local.identity).toBeNull();
    },
    15000,
  );

  it('rejects a failed startup read without forwarding the SDK fallback identity write', async () => {
    let writes = 0;
    let startupReads = 0;
    await expect(
      create({
        ...fixture,
        async openFreshStore() {
          const store = monitor(await fixture.openFreshStore(), (phase, timing) => {
            if (phase === 'identity' && timing === 'after') writes++;
          });
          let start = false;
          const hasIdentityKey = store.hasIdentityKey.bind(store);
          vi.spyOn(store, 'hasIdentityKey').mockImplementation(async (...args) => {
            if (!start) return hasIdentityKey(...args);
            startupReads++;
            return false;
          });
          const setLogger = store.setLogger.bind(store);
          vi.spyOn(store, 'setLogger').mockImplementation((logger) => {
            start = true;
            setLogger(logger);
          });
          return store;
        },
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(writes).toBe(1);
    expect(startupReads).toBe(1);
    const durable = await inspect();
    expect(fields(durable.raw).status).toBe('ready');
    const resumed = await resume();
    close.push(resumed.close);
    expect(
      matchesLocalIdentity(await readLocalIdentity(resumed.storage), durable.local.identity!),
    ).toBe(true);
  }, 15000);

  it('protects SDK registration metadata and rejects a mixed batch without applying any part', async () => {
    const initial = await create();
    await initial.close();
    const rawStore = await fixture.openExistingStore();
    await rawStore.setLocalRegistrationId(57, 'pni');
    const protectedKeys = [key, 'registrationId:aci', 'registrationId:pni'];
    const rawBefore = await Promise.all(protectedKeys.map((name) => rawStore.getMetadata(name)));
    const identityBefore = await readLocalIdentity(rawStore);
    expect(rawBefore[1] === String(identityBefore.registrationId) && rawBefore[2] === '57').toBe(
      true,
    );
    await rawStore.close();

    const ready = await resume();
    close.push(ready.close);
    const { storage } = ready;
    const ordinary = 'synthetic:receive-state';
    await storage.setMetadata(ordinary, 'before');
    const work = {
      workId: 'synthetic-work',
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
    } as const;
    expect(await storage.putReceiveWork(work, null)).toBe(true);

    for (const [index, name] of protectedKeys.entries()) {
      for (const call of [
        () => storage.getMetadata(name),
        () => storage.setMetadata(name, '61'),
        () => storage.deleteMetadata(name),
        () => storage.compareAndSetMetadata(name, rawBefore[index]!, '61'),
        () =>
          storage.completeReceiveWork(work.workId, work.revision, [
            { key: ordinary, value: 'changed' },
            { key: name, value: null },
          ]),
      ])
        await expect(call()).rejects.toThrow('Local identity store access denied');
      expect(await storage.getMetadata(ordinary)).toBe('before');
      expect(await storage.getReceiveWork(work.workId)).toMatchObject(work);
    }
    expect(await storage.listMetadataKeys?.({ prefix: 'registrationId:' })).toEqual([]);
    expect(await storage.compareAndSetMetadata(ordinary, 'before', 'changed')).toBe(true);
    expect(
      await storage.completeReceiveWork(work.workId, work.revision, [
        { key: ordinary, value: 'completed' },
      ]),
    ).toBe(true);
    expect(await storage.getReceiveWork(work.workId)).toBeNull();
    expect(await storage.getMetadata(ordinary)).toBe('completed');
    await storage.deleteMetadata(ordinary);
    expect(await storage.getMetadata(ordinary)).toBeNull();
    await ready.close();

    const reopened = await fixture.openExistingStore();
    try {
      const after = await Promise.all(protectedKeys.map((name) => reopened.getMetadata(name)));
      expect(after.every((value, index) => value === rawBefore[index])).toBe(true);
      expect(
        matchesLocalIdentity(await readLocalIdentity(reopened), identityBefore.identity!),
      ).toBe(true);
      expect(await reopened.getLocalRegistrationId('pni')).toBe(57);
    } finally {
      await reopened.close();
    }
  }, 15000);

  it('refuses a ready store with a missing registration ID and preserves the hidden identity', async () => {
    const ready = await create();
    await ready.close();
    const store = await fixture.openExistingStore();
    const identity = (await readLocalIdentity(store)).identity!;
    const reservation = await store.getMetadata(key);
    await store.deleteMetadata('registrationId:aci');
    await store.close();

    await expect(resume()).rejects.toMatchObject({ code: 'STATE' });
    const reopened = await fixture.openExistingStore();
    try {
      expect((await reopened.getMetadata(key)) === reservation).toBe(true);
      expect(await reopened.getMetadata('registrationId:aci')).toBeNull();
      // Reveal the hidden keys in the synthetic store without writing either pair.
      await reopened.setLocalRegistrationId(identity.registrationId, 'aci');
      expect(matchesLocalIdentity(await readLocalIdentity(reopened), identity)).toBe(true);
    } finally {
      await reopened.close();
    }
  }, 15000);

  it('refuses a pending store with only a registration ID and keeps the original attempt', async () => {
    expect(await startFixtureProcess(directory, 'reservation')).toEqual([null, 'SIGKILL']);
    const store = await fixture.openExistingStore();
    const reservation = await store.getMetadata(key);
    const registrationId = fields(reservation).registrationId!;
    await store.setLocalRegistrationId(registrationId, 'aci');
    await store.close();

    await expect(resume()).rejects.toMatchObject({ code: 'STATE' });
    const after = await inspect();
    expect(after.raw === reservation).toBe(true);
    expect(after.local.identity).toBeNull();
    expect(after.local.registrationId).toBe(registrationId);
  }, 15000);

  it('characterizes hidden pending keys after a raw writer removes the registration ID', async () => {
    expect(await startFixtureProcess(directory, 'reservation')).toEqual([null, 'SIGKILL']);
    const store = await fixture.openExistingStore();
    const empty = await readLocalIdentity(store);
    const reservation = await store.getMetadata(key);
    const foreign = { ...(await generateIdentityKeyPair()), registrationId: 59 };
    await store.storeIdentityKey(foreign, 'aci');
    expect(matchesLocalIdentity(await readLocalIdentity(store), foreign)).toBe(true);
    // This store access deliberately violates the exclusive writer contract.
    await store.deleteMetadata('registrationId:aci');
    const hidden = await readLocalIdentity(store);
    expect(
      hidden.identity === empty.identity &&
        hidden.hasIdentity === empty.hasIdentity &&
        hidden.registrationId === empty.registrationId,
    ).toBe(true);
    expect(empty).toEqual({ identity: null, hasIdentity: false, registrationId: 0 });
    expect((await store.getMetadata(key)) === reservation).toBe(true);
    await store.close();

    const ready = await resume();
    close.push(ready.close);
    const after = await readLocalIdentity(ready.storage);
    expect(after.identity?.dhKey.publicKey !== foreign.dhKey.publicKey).toBe(true);
    expect(after.registrationId).toBe(fields(reservation).registrationId);
    expect(new TextDecoder().decode(ready.publication) === fields(reservation).publication).toBe(
      true,
    );
  }, 15000);

  it('blocks replacement, reset and metadata paths and allows real sessions and prekeys', async () => {
    const ready = await create();
    close.push(ready.close);
    const { storage, client } = ready;
    const before = await readLocalIdentity(storage);
    const otherIdentity = { ...(await generateIdentityKeyPair()), registrationId: 40 };
    for (const call of [
      () => storage.storeIdentityKey(otherIdentity, 'aci'),
      () => storage.deleteIdentityKey('aci'),
      () => storage.setLocalRegistrationId(12, 'aci'),
      () => storage.clearAllKeys(),
      () => storage.clearAllSessions(),
      () => storage.getMetadata(key),
      () => storage.setMetadata(key, 'other'),
      () => storage.deleteMetadata(key),
      () => storage.compareAndSetMetadata(key, null, 'other'),
      () => storage.completeReceiveWork('work', 1, [{ key, value: null }]),
    ])
      await expect(call()).rejects.toThrow('Local identity store access denied');
    expect(Reflect.get(storage, 'close')).toBeUndefined();
    expect(Reflect.get(storage, 'storage')).toBeUndefined();
    expect(await storage.listMetadataKeys?.({ prefix: key })).toEqual([]);
    await storage.setMetadata('synthetic:key', 'kept');
    expect(await storage.getMetadata('synthetic:key')).toBe('kept');
    const ownPrekeys = await generateEcOneTimePreKeys(1);
    await storage.storeEcOneTimePreKeys(ownPrekeys, 'aci');
    expect((await storage.getEcOneTimePreKeys('aci')).length).toBeGreaterThan(0);

    const peerStore = inMemoryStore();
    await peerStore.storeIdentityKey(otherIdentity, 'aci');
    await peerStore.setLocalRegistrationId(otherIdentity.registrationId, 'aci');
    const signed = await generateEcSignedPreKey(otherIdentity);
    const kem = await generateKyberLastResortPreKey(otherIdentity);
    await peerStore.storeEcSignedPreKey(signed, 'aci');
    await peerStore.storeKyberPreKey(kem, 'aci');
    const peer = await createSignalProtocolClient({
      identity: { userId: 'synthetic-peer' },
      adapters: { storage: peerStore },
      protocol: { contentRecovery: { mode: 'off' } },
    });
    close.push(() => peer.stop());
    await client.establishSession(peer.address(), {
      registrationId: otherIdentity.registrationId,
      deviceId: 1,
      identity: {
        version: 1,
        x25519PublicKey: otherIdentity.dhKey.publicKey,
        ed25519PublicKey: otherIdentity.signingKey.publicKey,
      },
      ecSignedPreKey: {
        keyId: signed.keyId,
        publicKey: signed.publicKey,
        signature: signed.signature,
      },
      kemLastResortPreKey: { keyId: kem.keyId, publicKey: kem.publicKey, signature: kem.signature },
    });
    expect(
      await peer.decryptMessage(
        client.address(),
        await client.encryptMessage(peer.address(), 'synthetic message'),
      ),
    ).toBe('synthetic message');
    await expect(client.clearAllData()).rejects.toThrow('Local identity store access denied');
    await expect(client.forceCompleteKeyReset()).rejects.toThrow('relay not configured');
    expect(await storage.hasSession(peer.address())).toBe(true);
    expect(matchesLocalIdentity(await readLocalIdentity(storage), before.identity!)).toBe(true);
    await ready.close();
    expect(fields((await inspect()).raw).status).toBe('ready');
  }, 15000);
});
