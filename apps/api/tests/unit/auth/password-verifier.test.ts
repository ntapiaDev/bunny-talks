import { Buffer } from 'node:buffer';
import type * as NodeCrypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ derive: vi.fn() }));
vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeCrypto>()),
  argon2: native.derive,
}));
import {
  createPasswordVerifier,
  passwordVerifierNeedsRehash,
  validatePasswordVerifier,
  verifyPassword,
} from '../../../src/auth/password-verifier.js';

const valid =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

beforeEach(() => {
  native.derive.mockReset();
  native.derive.mockImplementation((_algorithm, _options, callback) =>
    callback(null, Buffer.alloc(32)),
  );
});

describe('password verifier boundaries', () => {
  it('rejects malformed, unknown, noncanonical and dangerous profiles before the KDF', async () => {
    for (const input of [
      '',
      valid + 'x',
      valid.replace('v=19', 'v=16'),
      valid.replace('19456', '999999999'),
      valid.replace('t=2', 't=1'),
      valid.replace('argon2id', 'argon2i'),
      valid.replace('AAAAAAAAAAAAAAAAAAAAAA$', 'AAAAAAAAAAAAAAAAAAAAAB$'),
    ]) {
      expect(validatePasswordVerifier(input)).toBe(false);
      await expect(verifyPassword('secret', input)).rejects.toMatchObject({
        code: 'INVALID_VERIFIER',
      });
    }
    expect(native.derive).not.toHaveBeenCalled();
    expect(validatePasswordVerifier(valid)).toBe(true);
    expect(passwordVerifierNeedsRehash(valid)).toBe(false);
    expect(() => passwordVerifierNeedsRehash('bad')).toThrow('INVALID_VERIFIER');
  });

  it('passes exact UTF-8 bytes, including Unicode, spaces and NUL', async () => {
    for (const password of ['é', 'e\u0301', ' x ', '\0', '😀']) {
      await verifyPassword(password, valid);
      const options = native.derive.mock.calls.at(-1)?.[1] as { message: Uint8Array };
      // The native call must consume its input before returning; it is wiped after completion.
      expect(options.message.every((byte) => byte === 0)).toBe(true);
    }
    const seen: string[] = [];
    native.derive.mockImplementation((_algorithm, options: { message: Uint8Array }, callback) => {
      seen.push(Buffer.from(options.message).toString('hex'));
      callback(null, Buffer.alloc(32));
    });
    for (const password of ['é', 'e\u0301', ' x ', '\0']) await verifyPassword(password, valid);
    expect(seen).toEqual(['c3a9', '65cc81', '207820', '00']);
  });

  it('enforces the vault input limits without leaking passwords', async () => {
    for (const password of ['', 'a'.repeat(1025), 'é'.repeat(513), '\ud800']) {
      await expect(createPasswordVerifier(password)).rejects.toMatchObject({
        message: 'INVALID_PASSWORD',
      });
    }
    await expect(createPasswordVerifier('é'.repeat(512))).resolves.toMatch(/^\$argon2id/);
    await expect(createPasswordVerifier('😀'.repeat(256))).resolves.toMatch(/^\$argon2id/);
  });

  it('separates provider failure from wrong passwords and suppresses native details', async () => {
    native.derive.mockImplementation((_a, _b, callback) =>
      callback(new Error('test-secret'), null),
    );
    await expect(verifyPassword('test-secret', valid)).rejects.toMatchObject({
      code: 'CRYPTO_UNAVAILABLE',
      message: 'CRYPTO_UNAVAILABLE',
    });
    native.derive.mockImplementation((_a, _b, callback) => callback(null, Buffer.alloc(32, 1)));
    await expect(verifyPassword('test-secret', valid)).resolves.toBe(false);
  });

  it('sanitizes unavailable and malformed native results and wipes writable outputs', async () => {
    native.derive.mockImplementation(() => {
      const missing: unknown = undefined;
      return (missing as () => void)();
    });
    await expect(verifyPassword('secret', valid)).rejects.toMatchObject({
      message: 'CRYPTO_UNAVAILABLE',
    });
    const short = Buffer.alloc(12, 7);
    const wrongType = new Uint8Array(32).fill(7);
    for (const result of [undefined, 'secret', short, wrongType]) {
      native.derive.mockImplementation((_a, _b, callback) => callback(null, result));
      await expect(verifyPassword('secret', valid)).rejects.toMatchObject({
        message: 'CRYPTO_UNAVAILABLE',
      });
    }
    expect(short.every((byte) => byte === 0)).toBe(true);
    expect(wrongType.every((byte) => byte === 0)).toBe(true);
  });

  it('wipes the parsed salt after a failed derivation', async () => {
    let salt: Uint8Array | undefined;
    native.derive.mockImplementation((_a, options: { nonce: Uint8Array }, callback) => {
      salt = options.nonce;
      callback(new Error('failure'));
    });
    await expect(
      verifyPassword('secret', valid.replace('AAAAAAAAAAAAAAAAAAAAAA$', 'AQEBAQEBAQEBAQEBAQEBAQ$')),
    ).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE' });
    expect(salt?.every((byte) => byte === 0)).toBe(true);
  });

  it('rejects excess work and releases capacity after completion', async () => {
    const callbacks: ((error: null, result: Buffer) => void)[] = [];
    native.derive.mockImplementation((_a, _b, callback) => callbacks.push(callback));
    const first = verifyPassword('one', valid);
    const second = verifyPassword('two', valid);
    await expect(verifyPassword('three', valid)).rejects.toMatchObject({ code: 'BUSY' });
    callbacks.forEach((callback) => callback(null, Buffer.alloc(32)));
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    native.derive.mockImplementation((_a, _b, callback) => callback(null, Buffer.alloc(32)));
    await expect(verifyPassword('four', valid)).resolves.toBe(true);
  });
});
