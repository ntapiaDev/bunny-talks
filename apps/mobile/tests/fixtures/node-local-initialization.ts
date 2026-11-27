import { argon2, randomFillSync } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nodeStore } from '@open-e2ee/signal-protocol-sdk/local/store/node';
import type { Argon2idProvider, CryptographicRandomSource } from '@bunny-talks/crypto-backup';

export const context = {
  account: '00000000-0000-4000-8000-000000000001',
  device: 'synthetic-device',
  vaultId: 'AQEBAQEBAQEBAQEBAQEBAQ',
};
export const password = 'synthetic first-device password';

export const random: CryptographicRandomSource = {
  async fill(bytes) {
    randomFillSync(bytes);
  },
};

export const argon2Provider: Argon2idProvider = {
  derive(message, nonce, parameters) {
    return new Promise((resolve, reject) =>
      argon2(
        'argon2id',
        {
          message,
          nonce,
          memory: parameters.memoryKiB,
          passes: parameters.passes,
          parallelism: parameters.parallelism,
          tagLength: parameters.outputBytes,
        },
        (error, key) => {
          if (error) reject(error);
          else resolve(key);
        },
      ),
    );
  },
};

export function nodeInitializationFixture(root: string) {
  const directory = join(root, 'store');
  const name = 'first-device.db';
  const vaultFile = join(root, 'synthetic-db-key');
  const open = (fresh = false) =>
    nodeStore({
      directory,
      name,
      vault: {
        async getSecret() {
          try {
            return await readFile(vaultFile);
          } catch (error) {
            if (fresh && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
          }
        },
        async setSecret(_slot, key) {
          if (!fresh) throw new Error('Cannot provision the key of an existing store');
          await writeFile(vaultFile, key, { flag: 'wx', mode: 0o600 });
        },
        async deleteSecret() {
          throw new Error('Unexpected deletion');
        },
      },
    });
  return {
    random,
    argon2: argon2Provider,
    async openFreshStore() {
      // Atomic reservation of a previously unused namespace inside the private fixture root.
      await mkdir(directory, { mode: 0o700 });
      return open(true);
    },
    async openExistingStore() {
      await stat(join(directory, name));
      return open();
    },
  };
}
