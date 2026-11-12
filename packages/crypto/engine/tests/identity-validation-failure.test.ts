import { expect, it, vi } from 'vitest';
import { CryptoError } from '@bunny-talks/crypto-core';
import { generateIdentityKeyPair } from '@open-e2ee/signal-protocol-sdk/keys';

const state = vi.hoisted(() => ({ failDerivation: false }));

vi.mock('@noble/curves/ed25519.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/curves/ed25519.js')>();
  return {
    ...actual,
    x25519: {
      ...actual.x25519,
      getPublicKey: (privateKey: Uint8Array) => {
        if (state.failDerivation) throw new Error('sensitive internal detail');
        return actual.x25519.getPublicKey(privateKey);
      },
    },
  };
});

import { validateExportedIdentity } from '../src/index.js';

it('sanitizes unexpected derivation failures for a valid identity', async () => {
  const identity = await generateIdentityKeyPair();
  expect(() => validateExportedIdentity(identity)).not.toThrow();
  state.failDerivation = true;
  try {
    validateExportedIdentity(identity);
    expect.fail('Expected derivation failure');
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoError);
    expect(error).toMatchObject({ code: 'UNKNOWN', message: 'Identity validation failed' });
    expect((error as Error).cause).toBeUndefined();
  } finally {
    state.failDerivation = false;
  }
});
