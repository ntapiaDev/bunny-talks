import * as SecureStore from 'expo-secure-store';
import { createSessionPersistence } from '../../composition/session-persistence';

const bearerKey = 'bunny-talks.session.bearer.v1';
const metadataKey = 'bunny-talks.session.metadata.v1';
const options = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

let persistence: ReturnType<typeof createSessionPersistence> | undefined;

/** Keeps the bearer and non-secret session metadata in separate SecureStore entries. */
export function createExpoSessionPersistence() {
  return (persistence ??= createSessionPersistence({
    secret: {
      read: () => SecureStore.getItemAsync(bearerKey, options),
      write: (value) => SecureStore.setItemAsync(bearerKey, value, options),
    },
    metadata: {
      read: () => SecureStore.getItemAsync(metadataKey, options),
      write: (value) => SecureStore.setItemAsync(metadataKey, value, options),
    },
  }));
}
