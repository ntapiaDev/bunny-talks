import type { ExpoSignalProtocolStore } from '@open-e2ee/signal-protocol-sdk/local/store/expo';

type Store = Pick<
  ExpoSignalProtocolStore,
  | 'hasIdentityKey'
  | 'getLocalRegistrationId'
  | 'getEcSignedPreKey'
  | 'getKyberPreKey'
  | 'getSessionRecord'
>;

// Only the addresses and key kinds owned by this diagnostic are checked.
export async function assertFreshDiagnosticStores(a1: Store, a2: Store, b: Store): Promise<void> {
  for (const store of [a1, a2, b]) {
    if (
      (await store.hasIdentityKey('aci')) ||
      (await store.getLocalRegistrationId('aci')) !== 0 ||
      (await store.getEcSignedPreKey(undefined, 'aci')) !== null ||
      (await store.getKyberPreKey('aci')) !== null
    ) {
      throw new Error('Diagnostic store is partially initialized');
    }
  }
  for (const [store, userId, deviceId] of [
    [a1, 'bob', 1],
    [a2, 'bob', 1],
    [b, 'alice', 1],
    [b, 'alice', 2],
  ] as const) {
    if ((await store.getSessionRecord({ userId, deviceId })) !== null) {
      throw new Error('Diagnostic store contains a session');
    }
  }
}
