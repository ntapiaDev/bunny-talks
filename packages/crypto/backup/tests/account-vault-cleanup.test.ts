import { randomFillSync } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createAccountVault } from '../src/index.js';
import type * as KeyEnvelopes from '../src/key-envelopes.js';

const captured = vi.hoisted(() => ({
  first: undefined as Uint8Array | undefined,
  secondCalled: false,
  nonzero: false,
}));
vi.mock('../src/key-envelopes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof KeyEnvelopes>();
  return {
    ...actual,
    openPasswordKeyEnvelope: async (...args: Parameters<typeof actual.openPasswordKeyEnvelope>) => {
      const result = await actual.openPasswordKeyEnvelope(...args);
      if (result.ok) {
        captured.first = result.masterKey;
        captured.nonzero = result.masterKey.some((byte) => byte !== 0);
      }
      return result;
    },
    openRecoveryKeyEnvelope: async () => {
      captured.secondCalled = true;
      throw new Error('unexpected provider failure with sensitive detail');
    },
  };
});

it('wipes the exact key returned by the first opener if the second opener throws', async () => {
  captured.first = undefined;
  captured.secondCalled = false;
  await expect(
    createAccountVault(
      { account: 'account', vaultId: 'AAAAAAAAAAAAAAAAAAAAAA' },
      'password',
      new Uint8Array(32).fill(3),
      new Uint8Array([4]),
      {
        async fill(buffer) {
          randomFillSync(buffer);
        },
      },
    ),
  ).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE', message: 'CRYPTO_UNAVAILABLE' });
  expect(captured.secondCalled).toBe(true);
  expect(captured.first).toBeDefined();
  expect(captured.nonzero).toBe(true);
  expect(captured.first).toEqual(new Uint8Array(32));
}, 30000);
