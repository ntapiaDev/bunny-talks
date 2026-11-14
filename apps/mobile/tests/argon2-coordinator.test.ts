import { argon2id } from '@sonnetstationsolutions/expo-argon2';
import { describe, expect, it, vi } from 'vitest';
import { ARGON2ID_V1 } from '@bunny-talks/crypto-backup';
import { createArgon2Coordinator } from '../src/argon2-coordinator';
import { applicationVaultArgon2Provider } from '../src/crypto-composition';
import { createVaultNativeProvider } from '../src/vault-native-provider';
vi.mock('@sonnetstationsolutions/expo-argon2', () => ({ argon2id: vi.fn() }));
describe('shared native coordinator', () => {
  it('keeps the application lease when a consumer is recreated during native work', async () => {
    let finish!: (value: Uint8Array) => void;
    const native = vi.mocked(argon2id);
    native.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const createConsumer = () => ({ provider: applicationVaultArgon2Provider });
    const original = createConsumer();
    const pending = original.provider.derive(new Uint8Array(1), new Uint8Array(16), ARGON2ID_V1);
    const recreated = createConsumer();
    await expect(
      recreated.provider.derive(new Uint8Array(1), new Uint8Array(16), ARGON2ID_V1),
    ).rejects.toThrow('ARGON2_BUSY');
    expect(native).toHaveBeenCalledTimes(1);
    finish(new Uint8Array(32));
    await pending;
    native.mockResolvedValueOnce(new Uint8Array(32));
    await expect(
      recreated.provider.derive(new Uint8Array(1), new Uint8Array(16), ARGON2ID_V1),
    ).resolves.toEqual(new Uint8Array(32));
    expect(native).toHaveBeenCalledTimes(2);
  });
  it('holds the shared lease across separate providers until native settlement and cleans failed calls', async () => {
    const coordinator = createArgon2Coordinator();
    let reject!: (reason: Error) => void;
    let pass: Uint8Array | undefined;
    const native = vi.fn(async (args: { password: Uint8Array }) => {
      pass = args.password;
      return new Promise<Uint8Array>((_, fail) => {
        reject = fail;
      });
    });
    const a = createVaultNativeProvider(coordinator, native);
    const b = createVaultNativeProvider(coordinator, native);
    const input = Uint8Array.of(1, 0, 255);
    const salt = new Uint8Array(16);
    const pending = a.derive(input, salt, ARGON2ID_V1);
    // An abandoned wait does not release the lease or trigger a second call.
    await expect(b.derive(input, salt, ARGON2ID_V1)).rejects.toThrow('ARGON2_BUSY');
    expect(native).toHaveBeenCalledTimes(1);
    reject(new Error('sensitive detail'));
    await expect(pending).rejects.toThrow(/^ARGON2_NATIVE_FAILED$/);
    expect(pass).toEqual(new Uint8Array(3));
    expect(input).toEqual(Uint8Array.of(1, 0, 255));
    const output = new Uint8Array(32).fill(7);
    const c = createVaultNativeProvider(coordinator, async () => output);
    expect(await c.derive(input, salt, ARGON2ID_V1)).toEqual(new Uint8Array(32).fill(7));
    expect(output).toEqual(new Uint8Array(32));
  });
});
