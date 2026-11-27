import type { SignalProtocolLocalStore } from '@open-e2ee/signal-protocol-sdk/types';
import type { SqliteIdentityStore } from '@bunny-talks/crypto-engine';

export const initializationMetadataKey = 'bunny-talks.crypto.initialization';

// Review this list when the SDK changes. Methods outside it have no automatic delegation.
const delegated = [
  'setLogger',
  'getIdentityKey',
  'getLocalRegistrationId',
  'saveContactIdentity',
  'getContactIdentity',
  'acceptContactIdentityRotation',
  'acceptContactIdentityRotationAndDeleteSessions',
  'verifyContactIdentity',
  'isTrustedIdentity',
  'storeEcSignedPreKey',
  'getEcSignedPreKey',
  'getAllEcSignedPreKeys',
  'removeEcSignedPreKey',
  'storeEcOneTimePreKeys',
  'getEcOneTimePreKeys',
  'removeEcOneTimePreKey',
  'storeKyberPreKey',
  'getKyberPreKey',
  'getKyberPreKeyById',
  'markKyberPreKeyUsed',
  'storeKemOneTimePreKeys',
  'getKemOneTimePreKeys',
  'getKemOneTimePreKey',
  'removeKemOneTimePreKey',
  'getKemOneTimePreKeyCount',
  'getEcSignedPreKeyMaxId',
  'getKyberPreKeyMaxId',
  'deleteAllPreKeys',
  'storeSessionRecord',
  'commitSessionTrust',
  'getSessionRecord',
  'deleteSessionRecord',
  'archiveCurrentSession',
  'getSessionsForUser',
  'hasSession',
  'getSessionCount',
  'getUserRecord',
  'setUserRecord',
  'getDeviceRecord',
  'setDeviceRecord',
  'deleteDeviceRecord',
  'getDeviceSession',
  'setDeviceSession',
  'deleteStaleRecords',
  'cleanupExpiredSessions',
  'getAllUserIds',
  'getSesameDeviceIds',
  'storeSenderKey',
  'getSenderKey',
  'storeSenderKeyRecord',
  'recordSenderKeyHandoff',
  'listSenderKeyHandoffs',
  'invalidateSenderKeyHandoff',
  'invalidateAccountSenderKeyHandoffs',
  'listSenderKeyHandoffGroupIds',
  'retainSenderKeyHandoffs',
  'getReceiveWork',
  'putReceiveWork',
  'listReceiveWork',
  'receiveWorkUsage',
  'getSenderKeyRecord',
  'resolveGroupForSenderKeyId',
  'deleteSenderKey',
  'getAllSenderKeysForGroup',
  'deleteAllSenderKeysForGroup',
  'storeSkippedSenderKey',
  'getSkippedSenderKey',
  'deleteSkippedSenderKey',
  'countSkippedSenderKeys',
  'deleteOldestSkippedSenderKeys',
  'storeMessageRecord',
  'getMessageRecord',
  'deleteMessageRecord',
  'deleteExpiredMessageRecords',
  'clearAllMessageRecords',
  'deleteMessageRecordsForSession',
  'rewriteMessageRecords',
  'storeSendLogEntry',
  'appendSendLogRecipients',
  'markSendLogComplete',
  'getSendLogEntry',
  'findSendLogEntries',
  'getSendLogRecipients',
  'deleteSendLogRecipient',
  'deleteSendLogRecipientsByTimestamp',
  'incrementSendLogResendCount',
  'deleteSendLogEntry',
  'deleteExpiredSendLog',
  'clearSendLog',
  'storeResendJob',
  'getResendJob',
  'getPendingResendJobs',
  'completeResendJob',
  'getDetailedStats',
] as const satisfies readonly (keyof SqliteIdentityStore)[];

async function deny(): Promise<never> {
  throw new Error('Local identity store access denied');
}

// OpenE2EE 14.5.0 SQLite registration metadata. Revalidate on every SDK upgrade.
function isProtectedMetadataKey(key: string): boolean {
  return (
    key === initializationMetadataKey ||
    key === 'registrationId:aci' ||
    key === 'registrationId:pni'
  );
}

function checkMetadataKey(key: string): void {
  if (typeof key !== 'string' || isProtectedMetadataKey(key)) {
    throw new Error('Local identity store access denied');
  }
}

type RestrictedSignalStore = SignalProtocolLocalStore &
  Pick<SqliteIdentityStore, 'deleteIdentityKey'>;

export function createRestrictedSignalStore(store: SqliteIdentityStore): RestrictedSignalStore {
  const controls = {
    protection: Object.freeze({ ...store.protection }),
    storeIdentityKey: deny,
    deleteIdentityKey: deny,
    setLocalRegistrationId: deny,
    clearAllKeys: deny,
    clearAllSessions: deny,
    async hasIdentityKey(type = 'aci') {
      const present = await store.hasIdentityKey(type);
      // SQLite may turn a read failure into false. Never enter SDK key generation for ACI.
      if (type === 'aci' && !present) return deny();
      return present;
    },
    async getMetadata(key) {
      checkMetadataKey(key);
      return store.getMetadata(key);
    },
    async setMetadata(key, value) {
      checkMetadataKey(key);
      return store.setMetadata(key, value);
    },
    async deleteMetadata(key) {
      checkMetadataKey(key);
      return store.deleteMetadata(key);
    },
    async compareAndSetMetadata(key, expected, value) {
      checkMetadataKey(key);
      return store.compareAndSetMetadata(key, expected, value);
    },
    async listMetadataKeys(query) {
      return (await store.listMetadataKeys(query)).filter((key) => !isProtectedMetadataKey(key));
    },
    async completeReceiveWork(workId, expectedRevision, metadata) {
      const writes = Array.from(metadata ?? [], ({ key, value }) => {
        checkMetadataKey(key);
        return { key, value };
      });
      return store.completeReceiveWork(workId, expectedRevision, writes);
    },
  } satisfies Pick<
    RestrictedSignalStore,
    Exclude<keyof RestrictedSignalStore, (typeof delegated)[number]>
  >;
  // Use a data-only facade with no prototype, raw store or lifecycle methods.
  const view: Record<string, unknown> = Object.assign(Object.create(null) as object, controls);
  for (const name of delegated) {
    view[name] = store[name].bind(store);
  }
  return Object.freeze(view) as unknown as RestrictedSignalStore;
}
