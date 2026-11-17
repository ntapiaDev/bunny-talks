import { describe, expect, it, vi } from 'vitest';
import { createNativeArgon2Provider } from '../src/infrastructure/crypto/native-argon2';

vi.mock('@sonnetstationsolutions/expo-argon2', () => ({ argon2id: vi.fn() }));

describe('experimental native Argon2 provider', () => {
  it('passes exact profile and returns independent output while wiping its temporary copies', async () => {
    const password = Uint8Array.of(0, 255, 1);
    const salt = new Uint8Array(16).fill(7);
    let passwordRef: Uint8Array | undefined;
    let saltRef: Uint8Array | undefined;
    const nativeOutput = new Uint8Array(32).fill(8);
    const provider = createNativeArgon2Provider(async (params) => {
      expect(params).toMatchObject({
        memory: 65536,
        iterations: 3,
        parallelism: 4,
        hashLength: 32,
        version: 19,
      });
      expect(params.password).toEqual(password);
      expect(params.salt).toEqual(salt);
      passwordRef = params.password;
      saltRef = params.salt;
      return nativeOutput;
    });
    const output = await provider.derive(password, salt, 'reference');
    expect(output).toEqual(new Uint8Array(32).fill(8));
    expect(nativeOutput).toEqual(new Uint8Array(32));
    expect(passwordRef).toEqual(new Uint8Array(3));
    expect(saltRef).toEqual(new Uint8Array(16));
    expect(password).toEqual(Uint8Array.of(0, 255, 1));
    expect(salt).toEqual(new Uint8Array(16).fill(7));
    await expect(provider.derive(password, salt, 'reference')).rejects.toThrow(
      'ARGON2_FULL_ALREADY_ATTEMPTED',
    );
  });
  it('rejects concurrent work and never starts another native call after a timeout-like abandoned wait', async () => {
    let release!: (value: Uint8Array) => void;
    const native = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          release = resolve;
        }),
    );
    const provider = createNativeArgon2Provider(native);
    const first = provider.derive(new Uint8Array([1]), new Uint8Array(16), 'reference');
    await expect(
      provider.derive(new Uint8Array([1]), new Uint8Array(16), 'diagnostic-short'),
    ).rejects.toThrow('ARGON2_BUSY');
    expect(native).toHaveBeenCalledTimes(1);
    release(new Uint8Array(32));
    await first;
    await expect(
      provider.derive(new Uint8Array([1]), new Uint8Array(16), 'reference'),
    ).rejects.toThrow('ARGON2_FULL_ALREADY_ATTEMPTED');
  });
  it('sanitizes errors, rejects malformed output and never retries a failed full attempt', async () => {
    const provider = createNativeArgon2Provider(async () => {
      throw new Error('private native detail');
    });
    await expect(
      provider.derive(new Uint8Array([1]), new Uint8Array(16), 'reference'),
    ).rejects.toThrow(/^ARGON2_NATIVE_FAILED$/);
    await expect(
      provider.derive(new Uint8Array([1]), new Uint8Array(16), 'reference'),
    ).rejects.toThrow('ARGON2_FULL_ALREADY_ATTEMPTED');
    const bad = createNativeArgon2Provider(async () => new Uint8Array(31));
    await expect(
      bad.derive(new Uint8Array([1]), new Uint8Array(16), 'diagnostic-short'),
    ).rejects.toThrow('ARGON2_NATIVE_FAILED');
    await expect(
      bad.derive(new Uint8Array([1]), new Uint8Array(15), 'diagnostic-short'),
    ).rejects.toThrow('ARGON2_INVALID_INPUT');
    const malformed = createNativeArgon2Provider(async () => ({}) as Uint8Array);
    await expect(
      malformed.derive(new Uint8Array([1]), new Uint8Array(16), 'diagnostic-short'),
    ).rejects.toThrow(/^ARGON2_NATIVE_FAILED$/);
  });
});
