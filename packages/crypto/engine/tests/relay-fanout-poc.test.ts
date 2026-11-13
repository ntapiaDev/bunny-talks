import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SendOutcomeEvent } from '@open-e2ee/signal-protocol-sdk/client';
import {
  createSignalProtocolClient,
  isOutgoingMessageError,
} from '@open-e2ee/signal-protocol-sdk/client';
import { generateIdentityKeyPair } from '@open-e2ee/signal-protocol-sdk/keys';
import { nodeStore } from '@open-e2ee/signal-protocol-sdk/local/store/node';
import type { SignalProtocolLocalSecretVault } from '@open-e2ee/signal-protocol-sdk/local/vault';
import { expect, it } from 'vitest';
import { importIdentity } from '../src/index.js';
import { TestRelay } from './fixtures/test-relay.js';

it('fans out with the public client and enforces test relay device capabilities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bunny-relay-'));
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
  const relay = new TestRelay();
  const a1Relay = relay.capability('alice', 1);
  const a2Relay = relay.capability('alice', 2);
  const bRelay = relay.capability('bob', 1);
  const received: Record<string, string[]> = { a1: [], a2: [], b: [] };
  const outcomes: SendOutcomeEvent[] = [];
  try {
    await a1Relay.registerDevice('alice', { deviceId: 1 });
    await a2Relay.registerDevice('alice', { deviceId: 2 });
    await bRelay.registerDevice('bob', { deviceId: 1 });
    const alice = await generateIdentityKeyPair();
    const bob = await generateIdentityKeyPair();
    const make = async (
      name: string,
      userId: string,
      deviceId: number,
      identity: typeof alice,
      id: number,
      transport: typeof a1Relay,
    ) => {
      const store = await nodeStore({ directory, name: `${name}.db`, vault });
      stores.push(store);
      await importIdentity(store, identity, id);
      const client = await createSignalProtocolClient({
        identity: { userId, deviceId },
        adapters: { storage: store, relay: transport },
        hooks: {
          onMessageDecrypted: (message) => {
            received[name]!.push(message.content);
          },
          onSendOutcome: (event) => {
            if (name === 'b') outcomes.push(event);
          },
        },
      });
      clients.push(client);
      await client.syncToServer();
      return { store, client };
    };
    const a1 = await make('a1', 'alice', 1, alice, 11, a1Relay);
    const a2 = await make('a2', 'alice', 2, alice, 12, a2Relay);
    const b = await make('b', 'bob', 1, bob, 13, bRelay);
    expect((await bRelay.getDevices('alice')).map((device) => device.deviceId)).toEqual([1, 2]);
    expect((await bRelay.getPreKeyInventory('alice', 1)).ecOneTimePreKeyCount).toBeGreaterThan(0);
    expect((await bRelay.getPreKeyInventory('alice', 2)).kemOneTimePreKeyCount).toBeGreaterThan(0);
    await expect(a2Relay.uploadPreKeys('alice', 1, [])).rejects.toThrow('Device impersonation');
    await expect(
      a2Relay.send({
        senderUserId: 'alice',
        senderDeviceId: 1,
        targetUserId: 'bob',
        targetDeviceId: 1,
        ciphertext: 'x',
        messageType: 'ciphertext',
        deliveryClass: 'user-visible',
        timestamp: Date.now(),
      }),
    ).rejects.toThrow('Device impersonation');
    const sent = await b.client.send('alice', 'hello alice');
    expect(sent.recipientDeviceCount).toBe(2);
    expect(
      relay.posts
        .filter(
          (post) =>
            post.senderUserId === 'bob' &&
            post.targetUserId === 'alice' &&
            post.contentKind !== 'receipt',
        )
        .map((post) => post.targetDeviceId)
        .sort(),
    ).toEqual([1, 2]);
    expect(relay.bundleFetches).toEqual(expect.arrayContaining(['alice:1', 'alice:2']));
    await relay.deliver('alice', 1);
    await relay.deliver('alice', 2);
    await viWait(() => received.a1!.length === 1 && received.a2!.length === 1);
    expect(received.a1).toContain('hello alice');
    expect(received.a2).toContain('hello alice');
    await a1.client.send('bob', 'from a1');
    await a2.client.send('bob', 'from a2');
    await relay.deliver('bob', 1);
    await viWait(() => received.b!.includes('from a1') && received.b!.includes('from a2'));
    expect(await b.client.hasSession(a1.client.address())).toBe(true);
    expect(await b.client.hasSession(a2.client.address())).toBe(true);
    const lostId = randomUUID();
    relay.loseNextResponse('alice', 1);
    await expect(
      b.client.send('alice', 'response lost', { clientMessageId: lostId }),
    ).rejects.toThrow('Simulated response loss');
    const lostPosts = relay.posts
      .filter(
        (post) =>
          post.senderUserId === 'bob' &&
          post.targetUserId === 'alice' &&
          post.clientMessageId &&
          post.contentKind !== 'receipt',
      )
      .slice(-2);
    expect(lostPosts).toHaveLength(2);
    const lostA1 = lostPosts.find((post) => post.targetDeviceId === 1)!;
    const repeatRequest = structuredClone(lostA1);
    delete repeatRequest.id;
    delete repeatRequest.serverTimestamp;
    const duplicateBeforeAck = await bRelay.send(repeatRequest);
    expect(duplicateBeforeAck.messageId).toBe(lostA1.id);
    expect(duplicateBeforeAck.duplicate).toBe(true);
    await expect(bRelay.send({ ...repeatRequest, ciphertext: 'conflict' })).rejects.toThrow(
      'Conflicting idempotency key',
    );
    expect(relay.pending('alice', 1).filter((envelope) => envelope.id === lostA1.id)).toHaveLength(
      1,
    );
    const countAfterLost = relay.posts.length;
    const duplicatesBeforeRetry = relay.duplicates.length;
    const retried = await b.client.send('alice', 'response lost', { clientMessageId: lostId });
    expect(retried.clientMessageId).toBe(lostId);
    expect(relay.duplicates.slice(duplicatesBeforeRetry)).toEqual([lostA1.id]);
    expect(relay.posts.length).toBe(countAfterLost);
    await relay.deliver('alice', 1);
    await relay.deliver('alice', 2);
    await viWait(
      () => received.a1!.includes('response lost') && received.a2!.includes('response lost'),
    );
    expect(received.a1!.filter((body) => body === 'response lost')).toHaveLength(1);
    await viWait(() => !relay.pending('alice', 1).some((envelope) => envelope.id === lostA1.id));
    const duplicateAfterAck = await bRelay.send(repeatRequest);
    expect(duplicateAfterAck.messageId).toBe(lostA1.id);
    expect(duplicateAfterAck.duplicate).toBe(true);
    expect(relay.pending('alice', 1).some((envelope) => envelope.id === lostA1.id)).toBe(false);
    const pending = await b.client.send('alice', 'pending');
    expect(pending.recipientDeviceCount).toBe(2);
    expect(relay.pending('alice', 2).length).toBeGreaterThan(0);
    const retained = await b.client.encryptMessage(a2.client.address(), 'retained ciphertext');
    const queued = relay.pending('alice', 2)[0]!;
    await a1Relay.removeDevice('alice', 2);
    expect((await bRelay.getDevices('alice')).map((device) => device.deviceId)).toEqual([1]);
    expect(await bRelay.fetchPreKeyBundle('alice', 2)).toBeNull();
    expect(relay.pending('alice', 2)).toHaveLength(0);
    await expect(
      bRelay.send({ ...repeatRequest, clientMessageId: randomUUID(), declaredDeviceIds: [1, 2] }),
    ).rejects.toThrow('Device set mismatch');
    await expect(
      bRelay.send({
        ...repeatRequest,
        clientMessageId: randomUUID(),
        recipientRegistrationId: 999,
      }),
    ).rejects.toThrow('Stale registration');
    const acceptedBeforeRevocation = structuredClone(queued);
    delete acceptedBeforeRevocation.id;
    delete acceptedBeforeRevocation.serverTimestamp;
    const countBeforeHistoricalReplay = relay.posts.length;
    const historical = await bRelay.send(acceptedBeforeRevocation);
    expect(historical.duplicate).toBe(true);
    expect(historical.messageId).toBe(queued.id);
    expect(relay.posts.length).toBe(countBeforeHistoricalReplay);
    expect(relay.pending('alice', 2)).toHaveLength(0);
    await expect(
      bRelay.send({ ...acceptedBeforeRevocation, ciphertext: 'conflict' }),
    ).rejects.toThrow('Conflicting idempotency key');
    await expect(
      bRelay.send({ ...acceptedBeforeRevocation, clientMessageId: randomUUID() }),
    ).rejects.toThrow('Unknown target');
    await expect(a2Relay.send(acceptedBeforeRevocation)).rejects.toThrow();
    await expect(a2Relay.uploadPreKeys('alice', 2, [])).rejects.toThrow();
    await expect(a2Relay.uploadPreKeys('alice', 1, [])).rejects.toThrow();
    await expect(a2Relay.getDevices('alice')).rejects.toThrow();
    await expect(relay.deliver('alice', 2)).rejects.toThrow();
    await expect(
      a2Relay.send({
        senderUserId: 'alice',
        senderDeviceId: 1,
        targetUserId: 'bob',
        targetDeviceId: 1,
        ciphertext: 'x',
        messageType: 'ciphertext',
        deliveryClass: 'user-visible',
        timestamp: Date.now(),
      }),
    ).rejects.toThrow();
    expect(await a2.client.decryptMessage(b.client.address(), retained)).toBe(
      'retained ciphertext',
    );
    expect(await b.client.hasSession(a2.client.address())).toBe(true);
    await a2.client.stop();
    clients.splice(clients.indexOf(a2.client), 1);
    await a2.store.close();
    stores.splice(stores.indexOf(a2.store), 1);
    const reopened = await nodeStore({ directory, name: 'a2.db', vault });
    stores.push(reopened);
    const resumedA2 = await createSignalProtocolClient({
      identity: { userId: 'alice', deviceId: 2 },
      adapters: { storage: reopened, relay: a2Relay },
    });
    clients.push(resumedA2);
    await expect(resumedA2.syncToServer()).rejects.toThrow();
    expect(() => a2Relay.subscribe('alice', 2, () => {})).toThrow();
    await expect(a2Relay.registerDevice('alice', { deviceId: 2 })).rejects.toThrow();
    await relay.deliver('alice', 1);
    await viWait(() => received.a1!.includes('pending'));
    const partialId = randomUUID();
    const postsBeforeFailure = relay.posts.length;
    let failure: unknown;
    try {
      await b.client.send('alice', 'after revocation', { clientMessageId: partialId });
    } catch (error) {
      failure = error;
    }
    expect(isOutgoingMessageError(failure)).toBe(true);
    if (!isOutgoingMessageError(failure)) throw new Error('Missing outgoing error');
    expect(failure.message).toContain('Unknown target');
    expect(failure.clientMessageId).toBe(partialId);
    expect(failure.retryable).toBe(true);
    expect(failure.acceptedDevices).toBeUndefined();
    expect(
      relay.posts
        .slice(postsBeforeFailure)
        .some((post) => post.targetUserId === 'alice' && post.targetDeviceId === 1),
    ).toBe(true);
    const partialPosts = relay.posts
      .slice(postsBeforeFailure)
      .filter(
        (post) =>
          post.targetUserId === 'alice' &&
          post.targetDeviceId === 1 &&
          post.contentKind !== 'receipt',
      );
    expect(partialPosts).toHaveLength(1);
    const firstCopy = partialPosts[0]!;
    expect(firstCopy.id).toBeTruthy();
    expect(firstCopy.clientMessageId).toBeTruthy();
    await relay.deliver('alice', 1);
    await viWait(() => received.a1!.includes('after revocation'));
    expect(received.a1!.filter((body) => body === 'after revocation')).toHaveLength(1);
    await relay.redeliver('alice', 1, firstCopy);
    expect(received.a1!.filter((body) => body === 'after revocation')).toHaveLength(1);
    const beforeRetry = relay.posts.length;
    const duplicatesBeforePartialRetry = relay.duplicates.length;
    await expect(
      b.client.send('alice', 'after revocation', { clientMessageId: partialId }),
    ).rejects.toThrow('Unknown target');
    expect(relay.posts.length).toBe(beforeRetry);
    expect(relay.duplicates.length).toBe(duplicatesBeforePartialRetry);
    expect(received.a1!.filter((body) => body === 'after revocation')).toHaveLength(1);
    relay.useTerminalMissingDestination(true);
    const terminalId = randomUUID();
    let terminalFailure: unknown;
    try {
      await b.client.send('alice', 'terminal refusal', { clientMessageId: terminalId });
    } catch (error) {
      terminalFailure = error;
    }
    expect(isOutgoingMessageError(terminalFailure)).toBe(true);
    if (!isOutgoingMessageError(terminalFailure)) throw new Error('Missing terminal error');
    expect(terminalFailure).toMatchObject({
      code: 'NOT_FOUND',
      clientMessageId: terminalId,
      retryable: false,
      acceptedDevices: [{ userId: 'alice', deviceId: 1 }],
      refusedDevices: [{ userId: 'alice', deviceId: 2 }],
    });
    await relay.deliver('alice', 1);
    await viWait(() => received.a1!.includes('terminal refusal'));
    const beforeTerminalRetry = relay.posts.length;
    await expect(
      b.client.send('alice', 'terminal refusal', { clientMessageId: terminalId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', retryable: false });
    expect(relay.posts.length).toBe(beforeTerminalRetry);
    expect(received.a1!.filter((message) => message === 'terminal refusal')).toHaveLength(1);
    expect(
      outcomes
        .filter((event) => event.clientMessageId === terminalId)
        .map((event) => event.outcome),
    ).toEqual(['failed']);
    await expect(b.client.resendMessage(terminalId)).rejects.toThrow(
      'A new manual resend needs the content',
    );
    expect(await b.client.forgetSentContent(terminalId)).toBe(false);
    relay.useTerminalMissingDestination(false);
    await b.client.stop();
    clients.splice(clients.indexOf(b.client), 1);
    await b.store.close();
    stores.splice(stores.indexOf(b.store), 1);
    const reopenedBobStore = await nodeStore({ directory, name: 'b.db', vault });
    stores.push(reopenedBobStore);
    const resumedBob = await createSignalProtocolClient({
      identity: { userId: 'bob', deviceId: 1 },
      adapters: { storage: reopenedBobStore, relay: bRelay },
      hooks: {
        onMessageDecrypted: (message) => {
          received.b!.push(message.content);
        },
      },
    });
    clients.push(resumedBob);
    await expect(
      resumedBob.send('alice', 'after revocation', { clientMessageId: partialId }),
    ).rejects.toThrow('Unknown target');
    await expect(
      resumedBob.send('alice', 'terminal refusal', { clientMessageId: terminalId }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      retryable: false,
      acceptedDevices: [{ userId: 'alice', deviceId: 1 }],
      refusedDevices: [{ userId: 'alice', deviceId: 2 }],
    });
    const beforeFresh = relay.posts.length;
    const fresh = await resumedBob.send('alice', 'after revocation');
    expect(fresh.clientMessageId).not.toBe(partialId);
    expect(fresh.recipientDeviceCount).toBe(1);
    expect(
      relay.posts
        .slice(beforeFresh)
        .filter((post) => post.targetUserId === 'alice')
        .map((post) => post.targetDeviceId),
    ).toEqual([1]);
    await relay.deliver('alice', 1);
    await viWait(() => received.a1!.filter((body) => body === 'after revocation').length === 2);
    const afterRefreshPosts = relay.posts.length;
    await expect(
      resumedBob.send('alice', 'after revocation', { clientMessageId: partialId }),
    ).rejects.toThrow('Unknown target');
    expect(relay.posts.length).toBe(afterRefreshPosts);
    await a1.client.send('bob', 'a1 remains authorized');
    await relay.deliver('bob', 1);
    await viWait(() => received.b!.includes('a1 remains authorized'));
  } finally {
    const stopped = await Promise.allSettled(clients.map((client) => client.stop()));
    const closed = await Promise.allSettled(stores.map((store) => store.close()));
    for (const secret of secrets.values()) secret.fill(0);
    const removed = await Promise.allSettled([rm(directory, { recursive: true, force: true })]);
    expect(
      [...stopped, ...closed, ...removed].every((result) => result.status === 'fulfilled'),
    ).toBe(true);
  }
}, 120000);

async function viWait(predicate: () => boolean): Promise<void> {
  await expect.poll(predicate, { timeout: 10000, interval: 20 }).toBe(true);
}
