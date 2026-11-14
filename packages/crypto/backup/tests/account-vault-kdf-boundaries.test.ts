import { readFileSync } from 'node:fs';
import canonicalize from 'canonicalize';
import { expect, it, vi } from 'vitest';
import { openAccountVaultWithPassword } from '../src/index.js';
const calls = vi.hoisted(() => ({ count: 0 }));
vi.mock('@noble/hashes/argon2.js', () => ({
  argon2idAsync: async () => {
    calls.count++;
    throw new Error('private provider error');
  },
}));
const vector = JSON.parse(
  readFileSync(new URL('./fixtures/account-vault-v1.json', import.meta.url), 'utf8'),
);
it('rejects malformed assembly and KDF parameters before costly Argon2id', async () => {
  calls.count = 0;
  for (const mutate of [
    (v: Record<string, unknown>) => {
      v.content = 'invalid';
    },
    (v: Record<string, unknown>) => {
      delete v.manifest;
    },
    (v: Record<string, unknown>) => {
      const envelope = JSON.parse(v.passwordEnvelope as string);
      envelope.header.memoryKiB = 2147483647;
      v.passwordEnvelope = canonicalize(envelope);
    },
    (v: Record<string, unknown>) => {
      const envelope = JSON.parse(v.recoveryEnvelope as string);
      envelope.header.revision = 2;
      v.recoveryEnvelope = canonicalize(envelope);
    },
  ]) {
    const value = JSON.parse(vector.publication);
    mutate(value);
    expect(
      (
        await openAccountVaultWithPassword(
          new TextEncoder().encode(canonicalize(value)!),
          'password',
          vector.context,
        )
      ).ok,
    ).toBe(false);
  }
  expect(calls.count).toBe(0);
});
it('never exposes raw provider exceptions', async () => {
  expect(
    await openAccountVaultWithPassword(
      new TextEncoder().encode(vector.publication),
      vector.password,
      vector.context,
    ),
  ).toEqual({ ok: false, code: 'CRYPTO_UNAVAILABLE' });
});
