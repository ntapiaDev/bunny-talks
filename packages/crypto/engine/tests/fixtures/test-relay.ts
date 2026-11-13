import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { HostedSignalProtocolRelayHttpError } from '@open-e2ee/signal-protocol-sdk/client';
import type {
  CompositeIdentityV1,
  PreKeyBundle,
  PublicKey,
  Signature,
} from '@open-e2ee/signal-protocol-sdk/keys';
import type {
  DeviceInfo,
  Envelope,
  PreKeyInventory,
  PreKeyUpload,
  SignalProtocolRelayServer,
} from '@open-e2ee/signal-protocol-sdk/remote/signal-relay/types';

// Test-only relay: authenticated capabilities are fixture objects, not credentials.
// Group APIs and concurrent publication are deliberately unsupported.
type Device = {
  userId: string;
  deviceId: number;
  identity?: CompositeIdentityV1;
  registrationId?: number;
  keys: PreKeyUpload[];
  active: boolean;
};
type Callback = (envelope: Envelope) => void | Promise<void>;
const key = (userId: string, deviceId: number) => `${userId}:${deviceId}`;
const unsupported = async (): Promise<never> => {
  throw new Error('Unsupported by test relay');
};

export class TestRelay {
  private readonly devices = new Map<string, Device>();
  private readonly subscriptions = new Map<string, Callback>();
  private readonly mailbox = new Map<string, Envelope[]>();
  private readonly accepted = new Map<
    string,
    { request: Envelope; item: Envelope; messageId: string; serverTimestamp: number }
  >();
  private readonly lostResponses = new Set<string>();
  private terminalMissingDestination = false;
  readonly posts: Envelope[] = [];
  readonly duplicates: string[] = [];
  readonly discoveries: string[] = [];
  readonly bundleFetches: string[] = [];

  capability(userId: string, deviceId: number): SignalProtocolRelayServer {
    const caller = key(userId, deviceId);
    const requireActive = () => {
      if (!this.devices.get(caller)?.active) throw new Error('Unauthorized device');
    };
    const requireSelf = (user: string, device: number) => {
      requireActive();
      if (key(user, device) !== caller) throw new Error('Device impersonation');
    };
    const inventory = (user: string, deviceId: number): PreKeyInventory => {
      const keys = this.devices.get(key(user, deviceId))?.keys ?? [];
      const metadata = (type: PreKeyUpload['type']) => {
        const item = keys.find((entry) => entry.type === type);
        return item
          ? {
              keyId: item.keyId,
              publicKey: item.publicKey,
              createdAt: Date.now(),
              expiresAt: Date.now() + 86400000,
            }
          : null;
      };
      return {
        ecSignedPreKey: metadata('ecSignedPreKey'),
        kemLastResortPreKey: metadata('kemLastResortPreKey'),
        ecOneTimePreKeyCount: keys.filter((entry) => entry.type === 'ecPreKey').length,
        kemOneTimePreKeyCount: keys.filter((entry) => entry.type === 'kemOneTimePreKey').length,
      };
    };
    const relay: SignalProtocolRelayServer = {
      relayConnectionState: { state: 'connected', since: Date.now() },
      subscribeRelayConnectionState() {
        return () => {};
      },
      registerDevice: async (user, registration) => {
        if (user !== userId || registration.deviceId !== deviceId || this.devices.has(caller))
          throw new Error('Invalid registration');
        this.devices.set(caller, { userId, deviceId, keys: [], active: true });
        return deviceId;
      },
      removeDevice: async (user, device) => {
        requireActive();
        if (user !== userId) throw new Error('Unauthorized account');
        const removed = this.devices.get(key(user, device));
        if (!removed?.active) throw new Error('Unknown device');
        removed.active = false;
        removed.keys = [];
        this.mailbox.delete(key(user, device));
        this.subscriptions.delete(key(user, device));
      },
      getDevices: async (user) => {
        requireActive();
        this.discoveries.push(user);
        return [...this.devices.values()]
          .filter((d) => d.active && d.userId === user)
          .map((d): DeviceInfo => ({
            deviceId: d.deviceId,
            registered: true,
            linked: d.deviceId !== 1,
            enabled: true,
          }));
      },
      provisionIdentityKey: async (request) => {
        requireSelf(request.userId, request.deviceId);
        const peers = [...this.devices.values()].filter((d) => d.userId === userId && d.identity);
        if (peers.some((d) => JSON.stringify(d.identity) !== JSON.stringify(request.identity)))
          throw new Error('Identity mismatch');
        const device = this.devices.get(caller)!;
        device.identity = request.identity;
        device.registrationId = request.registrationId;
      },
      rotateIdentityKey: unsupported,
      getIdentityKey: async (user) => {
        requireActive();
        return (
          [...this.devices.values()].find((d) => d.active && d.userId === user && d.identity)
            ?.identity ?? null
        );
      },
      uploadPreKeys: async (user, device, keys) => {
        requireSelf(user, device);
        const stored = this.devices.get(caller)!;
        for (const entry of keys) {
          stored.keys = stored.keys.filter(
            (old) =>
              !(
                old.type === entry.type &&
                (old.keyId === entry.keyId ||
                  entry.type === 'ecSignedPreKey' ||
                  entry.type === 'kemLastResortPreKey')
              ),
          );
          stored.keys.push({ ...entry });
        }
      },
      fetchPreKeyBundle: async (user, device) => {
        requireActive();
        this.bundleFetches.push(key(user, device));
        const target = this.devices.get(key(user, device));
        if (!target?.active || !target.identity || target.registrationId === undefined) return null;
        const signed = target.keys.find((entry) => entry.type === 'ecSignedPreKey');
        const kem =
          target.keys.find((entry) => entry.type === 'kemOneTimePreKey') ??
          target.keys.find((entry) => entry.type === 'kemLastResortPreKey');
        const ec = target.keys.find((entry) => entry.type === 'ecPreKey');
        if (!signed?.signature || !kem?.signature) return null;
        const signedPublic = {
          keyId: signed.keyId,
          publicKey: signed.publicKey as PublicKey,
          signature: signed.signature as Signature,
        };
        const kemPublic = {
          keyId: kem.keyId,
          publicKey: kem.publicKey as PublicKey,
          signature: kem.signature as Signature,
        };
        const result: PreKeyBundle = {
          registrationId: target.registrationId,
          deviceId: device,
          identity: target.identity,
          ecSignedPreKey: signedPublic,
          ...(ec
            ? { ecOneTimePreKey: { keyId: ec.keyId, publicKey: ec.publicKey as PublicKey } }
            : {}),
          ...(kem.type === 'kemOneTimePreKey'
            ? { kemOneTimePreKey: kemPublic }
            : { kemLastResortPreKey: kemPublic }),
        };
        target.keys = target.keys.filter(
          (entry) => entry !== ec && (entry !== kem || kem.type !== 'kemOneTimePreKey'),
        );
        return result;
      },
      getPreKeyInventory: async (user, device) => {
        requireActive();
        return inventory(user, device);
      },
      getPreKeyCount: async (user, device, type) => {
        requireActive();
        const value = inventory(user, device);
        return type === 'ec' ? value.ecOneTimePreKeyCount : value.kemOneTimePreKeyCount;
      },
      getEcSignedPreKeyMetadata: async (user, device) => {
        requireActive();
        return inventory(user, device).ecSignedPreKey;
      },
      getKemLastResortPreKeyMetadata: async (user, device) => {
        requireActive();
        return inventory(user, device).kemLastResortPreKey;
      },
      clearStaleKemPreKeys: async (user, device) => {
        requireSelf(user, device);
        const target = this.devices.get(caller)!;
        const before = target.keys.length;
        target.keys = target.keys.filter((entry) => entry.type !== 'kemOneTimePreKey');
        return { cleared: before - target.keys.length };
      },
      publishPlannedPreKeys: async (user, device, plan) => {
        requireSelf(user, device);
        await relay.uploadPreKeys(user, device, [...(await plan(inventory(user, device)))]);
      },
      send: async (envelope) => {
        requireSelf(envelope.senderUserId, envelope.senderDeviceId);
        const dedupKey =
          envelope.clientMessageId === undefined
            ? undefined
            : JSON.stringify([
                caller,
                envelope.targetUserId,
                envelope.targetDeviceId,
                envelope.clientMessageId,
              ]);
        const previous = dedupKey === undefined ? undefined : this.accepted.get(dedupKey);
        if (previous) {
          if (!isDeepStrictEqual(previous.request, envelope))
            throw new Error('Conflicting idempotency key');
          this.duplicates.push(previous.messageId);
          return {
            messageId: previous.messageId,
            serverTimestamp: previous.serverTimestamp,
            duplicate: true,
            ...(envelope.declaredDeviceIds ? { deviceSetChecked: true, needsSync: false } : {}),
          };
        }
        const target = this.devices.get(key(envelope.targetUserId, envelope.targetDeviceId));
        if (!target?.active) {
          if (this.terminalMissingDestination)
            throw new HostedSignalProtocolRelayHttpError(404, 'NOT_FOUND', 'Unknown target');
          throw new Error('Unknown target');
        }
        if (envelope.declaredDeviceIds) {
          const expected = [...this.devices.values()]
            .filter(
              (d) =>
                d.active &&
                d.userId === envelope.targetUserId &&
                !(d.userId === userId && d.deviceId === deviceId),
            )
            .map((d) => d.deviceId)
            .sort();
          if (JSON.stringify([...envelope.declaredDeviceIds].sort()) !== JSON.stringify(expected))
            throw new Error('Device set mismatch');
        }
        if (
          envelope.recipientRegistrationId !== undefined &&
          envelope.recipientRegistrationId !== target.registrationId
        )
          throw new Error('Stale registration');
        const id = randomUUID();
        const serverTimestamp = Date.now();
        const item = { ...envelope, id, serverTimestamp };
        this.posts.push(item);
        const targetKey = key(envelope.targetUserId, envelope.targetDeviceId);
        this.mailbox.set(targetKey, [...(this.mailbox.get(targetKey) ?? []), item]);
        if (dedupKey !== undefined)
          this.accepted.set(dedupKey, {
            request: structuredClone(envelope),
            item,
            messageId: id,
            serverTimestamp,
          });
        if (this.lostResponses.delete(targetKey))
          throw new Error('Simulated response loss after acceptance');
        return {
          ...(dedupKey !== undefined ? { duplicate: false } : {}),
          messageId: id,
          serverTimestamp,
          ...(envelope.declaredDeviceIds ? { deviceSetChecked: true, needsSync: false } : {}),
        };
      },
      subscribe: (user, device, callback) => {
        requireSelf(user, device);
        this.subscriptions.set(caller, callback);
        return () => {
          if (this.subscriptions.get(caller) === callback) this.subscriptions.delete(caller);
        };
      },
      markDelivered: async (id) => {
        requireActive();
        const items = this.mailbox.get(caller) ?? [];
        this.mailbox.set(
          caller,
          items.filter((entry) => entry.id !== id),
        );
      },
      getActiveDevices: async (user) =>
        (await relay.getDevices(user)).map((d) => ({ userId: user, deviceId: d.deviceId })),
      createGroupState: unsupported,
      getGroupState: unsupported,
      getGroupJoinInfo: unsupported,
      getGroupChanges: unsupported,
      submitGroupChange: unsupported,
      issueAuthCredential: unsupported,
    };
    return relay;
  }
  useTerminalMissingDestination(value: boolean): void {
    this.terminalMissingDestination = value;
  }
  loseNextResponse(userId: string, deviceId: number): void {
    this.lostResponses.add(key(userId, deviceId));
  }
  async redeliver(userId: string, deviceId: number, envelope: Envelope): Promise<void> {
    const id = key(userId, deviceId);
    if (!this.devices.get(id)?.active) throw new Error('Unauthorized device');
    const callback = this.subscriptions.get(id);
    if (!callback) throw new Error('No subscription');
    if (envelope.targetUserId !== userId || envelope.targetDeviceId !== deviceId)
      throw new Error('Wrong target');
    await callback(envelope);
  }
  async deliver(userId: string, deviceId: number): Promise<void> {
    const id = key(userId, deviceId);
    if (!this.devices.get(id)?.active) throw new Error('Unauthorized device');
    const callback = this.subscriptions.get(id);
    if (!callback) throw new Error('No subscription');
    for (const envelope of [...(this.mailbox.get(id) ?? [])]) await callback(envelope);
  }
  pending(userId: string, deviceId: number): readonly Envelope[] {
    return [...(this.mailbox.get(key(userId, deviceId)) ?? [])];
  }
}
