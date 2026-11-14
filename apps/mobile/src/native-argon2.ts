import { argon2id } from '@sonnetstationsolutions/expo-argon2';

type NativeArgon2 = typeof argon2id;
type Cost = 'reference' | 'diagnostic-short';
export type NativeArgon2Provider = ReturnType<typeof createNativeArgon2Provider>;

/** Experimental provider; each instance admits one operation, with no queue or fallback. */
export function createNativeArgon2Provider(native: NativeArgon2 = argon2id) {
  let busy = false;
  let fullAttempted = false;
  return {
    async derive(password: Uint8Array, salt: Uint8Array, cost: Cost): Promise<Uint8Array> {
      if (busy) throw new Error('ARGON2_BUSY');
      if (
        !(password instanceof Uint8Array) ||
        password.length > 1024 ||
        !(salt instanceof Uint8Array) ||
        salt.length !== 16 ||
        (cost !== 'reference' && cost !== 'diagnostic-short')
      )
        throw new Error('ARGON2_INVALID_INPUT');
      if (cost === 'reference' && fullAttempted) throw new Error('ARGON2_FULL_ALREADY_ATTEMPTED');
      if (cost === 'reference') fullAttempted = true;
      busy = true;
      let passwordCopy: Uint8Array | undefined;
      let saltCopy: Uint8Array | undefined;
      let result: Uint8Array | undefined;
      try {
        passwordCopy = Uint8Array.from(password);
        saltCopy = Uint8Array.from(salt);
        result = await native({
          password: passwordCopy,
          salt: saltCopy,
          memory: cost === 'reference' ? 65536 : 32,
          iterations: 3,
          parallelism: 4,
          hashLength: 32,
          version: 0x13,
        });
        if (!(result instanceof Uint8Array) || result.length !== 32) throw new Error();
        return Uint8Array.from(result);
      } catch {
        throw new Error('ARGON2_NATIVE_FAILED');
      } finally {
        passwordCopy?.fill(0);
        saltCopy?.fill(0);
        if (result instanceof Uint8Array) result.fill(0);
        busy = false;
      }
    },
  };
}
