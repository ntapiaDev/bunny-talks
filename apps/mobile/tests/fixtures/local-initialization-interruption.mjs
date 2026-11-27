import process from 'node:process';

import { generateRecoveryKey } from '@bunny-talks/crypto-backup';

import { initializeLocalCrypto } from '../../src/infrastructure/crypto/local-crypto-initialization.ts';
import { context, nodeInitializationFixture, password } from './node-local-initialization.ts';

const [root, phase] = process.argv.slice(2);
const dependencies = nodeInitializationFixture(root);
if (phase === 'busy') {
  try {
    const unexpected = await dependencies.openExistingStore();
    await unexpected.close();
    process.exit(2);
  } catch (error) {
    process.exit(error.name === 'SqliteStoreInUseError' ? 0 : 3);
  }
}
const open = dependencies.openFreshStore;
dependencies.openFreshStore = async () => {
  const store = await open();
  const compare = store.compareAndSetMetadata.bind(store);
  store.compareAndSetMetadata = async (key, previous, next) => {
    const written = await compare(key, previous, next);
    if (written && phase === (previous === null ? 'reservation' : 'ready')) {
      process.kill(process.pid, 'SIGKILL');
    }
    return written;
  };
  const write = store.storeIdentityKey.bind(store);
  store.storeIdentityKey = async (...args) => {
    await write(...args);
    if (phase === 'identity') process.kill(process.pid, 'SIGKILL');
  };
  return store;
};
const recoveryKey = await generateRecoveryKey(dependencies.random);
try {
  const unexpected = await initializeLocalCrypto(
    context,
    { mode: 'create', password, recoveryKey },
    dependencies,
  );
  await unexpected.close();
  process.exitCode = 2;
} finally {
  recoveryKey.fill(0);
}
