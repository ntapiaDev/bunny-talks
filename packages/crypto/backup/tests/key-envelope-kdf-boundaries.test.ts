import canonicalize from 'canonicalize';
import { expect, it, vi } from 'vitest';
import { openPasswordKeyEnvelope } from '../src/index.js';

const calls = vi.hoisted(() => ({ count: 0 }));
vi.mock('@noble/hashes/argon2.js', () => ({
  argon2idAsync: async () => {
    calls.count++;
    throw new Error('provider secret');
  },
}));
const context = { account: 'account', vaultId: 'AAAAAAAAAAAAAAAAAAAAAA' };
const header = {
  ...context,
  revision: 1,
  version: 1,
  access: 'password',
  format: 'bunny-password-key-envelope',
  profile: 'argon2id-64m-t3-p4-hkdf-sha256-xchacha20poly1305-v1',
  domain: 'bunny-talks/key-envelope/password/v1/wrapping-key',
  salt: 'AAAAAAAAAAAAAAAAAAAAAA',
  nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  outputBytes: 32,
  memoryKiB: 65536,
  passes: 3,
  parallelism: 4,
  kdfVersion: 19,
};
const encode = (value: unknown) => new TextEncoder().encode(canonicalize(value)!);
it('rejects untrusted KDF parameters and context before invoking Argon2id', async () => {
  calls.count = 0;
  for (const field of ['memoryKiB', 'passes', 'parallelism', 'outputBytes', 'kdfVersion']) {
    for (const value of [0, -1, 1.5, '65536', 2147483647]) {
      const result = await openPasswordKeyEnvelope(
        encode({ header: { ...header, [field]: value }, ciphertext: 'A'.repeat(64) }),
        'password',
        context,
      );
      expect(result.ok).toBe(false);
    }
  }
  expect(
    await openPasswordKeyEnvelope(encode({ header, ciphertext: 'A'.repeat(64) }), 'password', {
      ...context,
      account: 'other',
    }),
  ).toEqual({ ok: false, code: 'CONTEXT_MISMATCH' });
  expect(calls.count).toBe(0);
});
it('sanitizes provider errors without returning any plaintext', async () => {
  const result = await openPasswordKeyEnvelope(
    encode({ header, ciphertext: 'A'.repeat(64) }),
    'password',
    context,
  );
  expect(result).toEqual({ ok: false, code: 'CRYPTO_UNAVAILABLE' });
});
