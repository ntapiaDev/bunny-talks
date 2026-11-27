import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base64ToBytes, bytesToBase64 } from '@open-e2ee/signal-protocol-sdk/encoding';
import type { ExpoSignalProtocolStore } from '@open-e2ee/signal-protocol-sdk/local/store/expo';
import { expoStore } from '@open-e2ee/signal-protocol-sdk/local/store/expo';
import type { SignalProtocolLocalSecretVault } from '@open-e2ee/signal-protocol-sdk/local/vault';
import { asBase64 } from '@open-e2ee/signal-protocol-sdk/types/utils';
import { Directory, File } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import type { SQLiteDatabase } from 'expo-sqlite';
import { defaultDatabaseDirectory, openDatabaseAsync } from 'expo-sqlite';
import type { LocalInitializationContext } from './local-crypto-initialization';

const coordinationName = 'bunny-local-crypto-reservations.db';
const secureOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const encoder = new TextEncoder();

type StoreFailure = 'CONTEXT' | 'RESERVATION' | 'FILE' | 'KEY' | 'SDK' | 'UNAVAILABLE';

export class ExpoLocalStoreError extends Error {
  constructor(readonly code: StoreFailure) {
    super(`Local Expo store: ${code}`);
    this.name = 'ExpoLocalStoreError';
  }
}

export function localExpoStorePaths(context: LocalInitializationContext) {
  const account = context.account;
  const device = context.device;
  const vaultId = context.vaultId;
  if (
    typeof account !== 'string' ||
    !/^[!-~]{1,128}$/u.test(account) ||
    typeof device !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(device) ||
    typeof vaultId !== 'string' ||
    !/^[A-Za-z0-9_-]{21}[AQgw]$/u.test(vaultId)
  ) {
    throw new ExpoLocalStoreError('CONTEXT');
  }

  // One store per account/device. Changing the supplied vault ID must conflict.
  const scope = bytesToHex(sha256(encoder.encode(JSON.stringify([account, device]))));
  const name = `bunny-local-crypto-${scope}.db`;
  // OpenE2EE 14.5.0 Expo conventions. Revalidate both slots and suffix on upgrade.
  return {
    scope,
    name,
    vaultId,
    slot: `signal_protocol_sqlite_key.${name}`,
    pendingSlot: `signal_protocol_sqlite_pending_key.${name}`,
    conversionName: `${name}.oe2e-convert`,
  };
}

type StorePaths = ReturnType<typeof localExpoStorePaths>;
type ProvisionEvent = 'attempt' | 'completed' | 'uncertain';
type ObserveOpening = (operation: 'allocation' | 'key', event: ProvisionEvent) => void;

function directory() {
  const path: unknown = defaultDatabaseDirectory;
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new ExpoLocalStoreError('FILE');
  }
  return new Directory(`file://${path}`);
}

function assertFiles(root: Directory, paths: StorePaths, fresh: boolean) {
  const entries = root.list();
  // Android may return an empty listing on I/O failure. The already opened
  // coordination database is a positive witness for the directory enumeration.
  if (!entries.some((entry) => entry instanceof File && entry.name === coordinationName)) {
    throw new ExpoLocalStoreError('FILE');
  }
  const sidecars = [`${paths.name}-wal`, `${paths.name}-shm`, `${paths.name}-journal`];
  if (
    entries.some(
      (entry) =>
        entry.name === paths.conversionName ||
        entry.name.startsWith(`${paths.conversionName}-`) ||
        (sidecars.includes(entry.name) && (fresh || !(entry instanceof File))),
    )
  ) {
    throw new ExpoLocalStoreError('FILE');
  }
  const found = entries.find((entry) => entry.name === paths.name);
  if (fresh) {
    if (found) throw new ExpoLocalStoreError('FILE');
    return;
  }
  if (!(found instanceof File)) throw new ExpoLocalStoreError('FILE');
  const info = found.info();
  // A main SQLite file is composed of complete pages of at least 512 bytes.
  if (!info.exists || !Number.isSafeInteger(info.size) || !info.size || info.size % 512 !== 0) {
    throw new ExpoLocalStoreError('FILE');
  }
}

async function assertReservation(db: SQLiteDatabase, paths: StorePaths) {
  const row = await db.getFirstAsync<{ name: string; vaultId: string }>(
    'SELECT name, vault_id AS vaultId FROM reservation WHERE scope = ?',
    paths.scope,
  );
  if (row?.name !== paths.name || row.vaultId !== paths.vaultId) {
    throw new ExpoLocalStoreError('RESERVATION');
  }
}

async function openGuardedStore(
  paths: StorePaths,
  fresh: boolean,
  observe?: ObserveOpening,
): Promise<ExpoSignalProtocolStore> {
  let db: SQLiteDatabase | undefined;
  let store: ExpoSignalProtocolStore | undefined;
  let key: Uint8Array | undefined;
  let transaction = false;
  let vaultFailure = false;
  try {
    const root = directory();
    if (!fresh) {
      const coordination = new File(root, coordinationName).info();
      if (!coordination.exists || !coordination.size) throw new ExpoLocalStoreError('RESERVATION');
    }
    db = await openDatabaseAsync(coordinationName, { useNewConnection: true });
    // Keep the coordination file's writer lock across the fresh reservation commit.
    // This connection closes immediately after the handover to the SDK.
    await db.execAsync('PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL;');
    const lock = await db.getFirstAsync<{ locking_mode: string }>(
      'PRAGMA locking_mode = EXCLUSIVE',
    );
    if (lock?.locking_mode !== 'exclusive') throw new ExpoLocalStoreError('UNAVAILABLE');
    if (fresh) {
      await db.execAsync(
        'CREATE TABLE IF NOT EXISTS reservation (scope TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL UNIQUE, vault_id TEXT NOT NULL)',
      );
      await db.execAsync('BEGIN IMMEDIATE');
      transaction = true;
      observe?.('allocation', 'attempt');
      try {
        const { changes } = await db.runAsync(
          'INSERT INTO reservation (scope, name, vault_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
          paths.scope,
          paths.name,
          paths.vaultId,
        );
        if (changes !== 1) throw new ExpoLocalStoreError('RESERVATION');
        await db.execAsync('COMMIT');
        transaction = false;
      } catch (error) {
        if (!(error instanceof ExpoLocalStoreError)) observe?.('allocation', 'uncertain');
        throw error;
      }
      observe?.('allocation', 'completed');
    }
    // This short second transaction hands off to the SDK's live file lock.
    // The reservation above stays durable even if SecureStore reports failure.
    await db.execAsync('BEGIN IMMEDIATE');
    transaction = true;
    await assertReservation(db, paths);
    assertFiles(root, paths, fresh);

    const current = await SecureStore.getItemAsync(paths.slot, secureOptions);
    const pending = await SecureStore.getItemAsync(paths.pendingSlot, secureOptions);
    if (pending !== null || (fresh ? current !== null : current === null)) {
      throw new ExpoLocalStoreError('KEY');
    }
    if (current !== null) {
      if (!/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/u.test(current)) {
        throw new ExpoLocalStoreError('KEY');
      }
      key = base64ToBytes(asBase64(current));
      if (key.byteLength !== 32) throw new ExpoLocalStoreError('KEY');
    }

    let mayProvision = fresh;
    const vault: SignalProtocolLocalSecretVault = {
      custody: 'os-keychain',
      async getSecret(slot) {
        if (slot === paths.slot) return key ?? null;
        if (fresh && slot === paths.pendingSlot) return null;
        throw new ExpoLocalStoreError('KEY');
      },
      async setSecret(slot, value) {
        if (!mayProvision || slot !== paths.slot || value.byteLength !== 32) {
          throw new ExpoLocalStoreError('KEY');
        }
        mayProvision = false;
        key = value;
        observe?.('key', 'attempt');
        try {
          await SecureStore.setItemAsync(slot, bytesToBase64(value), secureOptions);
        } catch (error) {
          vaultFailure = true;
          observe?.('key', 'uncertain');
          throw error;
        }
        observe?.('key', 'completed');
      },
      async deleteSecret() {
        throw new ExpoLocalStoreError('KEY');
      },
    };
    try {
      store = await expoStore({
        name: paths.name,
        encryptionAtRest: true,
        convertPlaintext: false,
        vault,
      });
    } catch {
      // Keep adapter refusals distinguishable from failures after SDK handoff.
      throw new ExpoLocalStoreError(vaultFailure ? 'UNAVAILABLE' : 'SDK');
    }
    if (fresh && mayProvision) throw new ExpoLocalStoreError('KEY');
    await db.execAsync('COMMIT');
    transaction = false;
    await db.closeAsync();
    return store;
  } catch (error) {
    await store?.close().catch(() => undefined);
    if (transaction) await db?.execAsync('ROLLBACK').catch(() => undefined);
    await db?.closeAsync().catch(() => undefined);
    if (error instanceof ExpoLocalStoreError) throw error;
    throw new ExpoLocalStoreError('UNAVAILABLE');
  } finally {
    key?.fill(0);
    key = undefined;
  }
}

export async function openFreshStore(
  context: LocalInitializationContext,
  observe?: ObserveOpening,
) {
  return openGuardedStore(localExpoStorePaths(context), true, observe);
}

export async function openExistingStore(context: LocalInitializationContext) {
  return openGuardedStore(localExpoStorePaths(context), false);
}
