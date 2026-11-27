import { MAX_REGISTRATION_ID, MIN_REGISTRATION_ID } from '@open-e2ee/signal-protocol-sdk';
import type { IdentityKeyPair } from '@open-e2ee/signal-protocol-sdk/keys';
import type { ExpoSignalProtocolStore } from '@open-e2ee/signal-protocol-sdk/local/store/expo';
import type { NodeSignalProtocolStore } from '@open-e2ee/signal-protocol-sdk/local/store/node';
import type { ReactNativeSignalProtocolStore } from '@open-e2ee/signal-protocol-sdk/local/store/react-native';
import type { IdentityKeyStore } from '@open-e2ee/signal-protocol-sdk/types';
import { CryptoError } from '@bunny-talks/crypto-core';
import { validateExportedIdentity } from './identity-validation.js';

const pendingImports = new WeakMap<IdentityKeyStore, Promise<void>>();

export type SqliteIdentityStore =
  ExpoSignalProtocolStore | NodeSignalProtocolStore | ReactNativeSignalProtocolStore;

export async function readLocalIdentity(store: IdentityKeyStore) {
  try {
    const identity = await store.getIdentityKey('aci');
    const hasIdentity = await store.hasIdentityKey('aci');
    const registrationId = await store.getLocalRegistrationId('aci');
    return { identity, hasIdentity, registrationId };
  } catch {
    throw new CryptoError('STORAGE_FAILURE', 'Identity store read failed');
  }
}

export function isLocalIdentityAbsent(state: Awaited<ReturnType<typeof readLocalIdentity>>) {
  return state.identity === null && !state.hasIdentity && state.registrationId === 0;
}

export function matchesLocalIdentity(
  state: Awaited<ReturnType<typeof readLocalIdentity>>,
  expected: IdentityKeyPair,
) {
  const stored = state.identity;
  return (
    state.hasIdentity &&
    stored !== null &&
    state.registrationId === expected.registrationId &&
    stored.registrationId === expected.registrationId &&
    stored.dhKey.publicKey === expected.dhKey.publicKey &&
    stored.dhKey.privateKey === expected.dhKey.privateKey &&
    stored.signingKey.publicKey === expected.signingKey.publicKey &&
    stored.signingKey.privateKey === expected.signingKey.privateKey
  );
}

/** Import into an uninitialized SQLite ACI store. Other writers must be excluded by the caller. */
export async function importIdentity(
  store: SqliteIdentityStore,
  identity: unknown,
  registrationId: number,
): Promise<void> {
  const prepared = prepareImportedIdentity(identity, registrationId);
  const previous = pendingImports.get(store);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  pendingImports.set(store, current);
  try {
    await previous;
    if (!isLocalIdentityAbsent(await readLocalIdentity(store))) {
      throw new CryptoError('KEY_ACCESS_DENIED', 'Identity store is already initialized');
    }
    try {
      await store.storeIdentityKey(prepared, 'aci');
      if (!matchesLocalIdentity(await readLocalIdentity(store), prepared)) {
        throw new Error();
      }
    } catch {
      throw new CryptoError('STORAGE_FAILURE', 'Identity import could not be verified');
    }
  } finally {
    if (pendingImports.get(store) === current) pendingImports.delete(store);
    release();
  }
}

/** Prepare a coherent identity for an import; this function never writes to a store. */
export function prepareImportedIdentity(
  identity: unknown,
  registrationId: number,
): IdentityKeyPair {
  if (
    !Number.isSafeInteger(registrationId) ||
    registrationId < MIN_REGISTRATION_ID ||
    registrationId > MAX_REGISTRATION_ID
  ) {
    throw new CryptoError('INVALID_INPUT', 'Invalid registration ID');
  }

  // Snapshot first: validate exactly the values returned, even for accessor inputs.
  let snapshot: unknown;
  try {
    if (typeof identity !== 'object' || identity === null) throw new Error();
    const value = identity as Record<string, unknown>;
    const copyPair = (pair: unknown) => {
      if (typeof pair !== 'object' || pair === null) throw new Error();
      const fields = pair as Record<string, unknown>;
      return { publicKey: fields.publicKey, privateKey: fields.privateKey };
    };
    snapshot = { dhKey: copyPair(value.dhKey), signingKey: copyPair(value.signingKey) };
  } catch {
    throw new CryptoError('INVALID_INPUT', 'Invalid exported identity');
  }
  validateExportedIdentity(snapshot);
  // Validation checks the SDK's branded Base64 representation and both pairs.
  return { ...(snapshot as Omit<IdentityKeyPair, 'registrationId'>), registrationId };
}
