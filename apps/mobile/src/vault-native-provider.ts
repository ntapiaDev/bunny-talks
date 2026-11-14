import { argon2id } from '@sonnetstationsolutions/expo-argon2';
import type { Argon2idProvider } from '@bunny-talks/crypto-backup';
import type { createArgon2Coordinator } from './argon2-coordinator';

/** Every application consumer must receive the same coordinator at composition time. */
export function createVaultNativeProvider(
  coordinator: ReturnType<typeof createArgon2Coordinator>,
  native: typeof argon2id = argon2id,
): Argon2idProvider {
  return {
    async derive(password, salt, parameters) {
      if (
        !(password instanceof Uint8Array) ||
        password.length > 1024 ||
        !(salt instanceof Uint8Array) ||
        salt.length !== 16 ||
        parameters.memoryKiB !== 65536 ||
        parameters.passes !== 3 ||
        parameters.parallelism !== 4 ||
        parameters.version !== 19 ||
        parameters.outputBytes !== 32
      )
        throw new Error('ARGON2_INVALID_INPUT');
      return coordinator.run(async () => {
        let pass: Uint8Array | undefined;
        let nonce: Uint8Array | undefined;
        let output: Uint8Array | undefined;
        try {
          pass = Uint8Array.from(password);
          nonce = Uint8Array.from(salt);
          output = await native({
            password: pass,
            salt: nonce,
            memory: 65536,
            iterations: 3,
            parallelism: 4,
            version: 19,
            hashLength: 32,
          });
          if (!(output instanceof Uint8Array) || output.length !== 32) throw new Error();
          return Uint8Array.from(output);
        } catch {
          throw new Error('ARGON2_NATIVE_FAILED');
        } finally {
          pass?.fill(0);
          nonce?.fill(0);
          if (output instanceof Uint8Array) output.fill(0);
        }
      });
    },
  };
}
