import { readFileSync } from 'node:fs';
import type * as Ciphers from '@noble/ciphers/chacha.js';
import type * as Hashes from '@noble/hashes/hkdf.js';
import { describe, expect, it, vi } from 'vitest';
import { openDirectVaultV1 } from '../src/experimental.js';

const calls = vi.hoisted(() => ({ derivations: 0, failure: null as Error | null }));
vi.mock('@noble/hashes/hkdf.js', async (original) => {
  const module = await original<typeof Hashes>();
  return {
    ...module,
    hkdf: (...args: Parameters<typeof module.hkdf>) => {
      calls.derivations += 1;
      return module.hkdf(...args);
    },
  };
});
vi.mock('@noble/ciphers/chacha.js', async (original) => {
  const module = await original<typeof Ciphers>();
  return {
    ...module,
    xchacha20poly1305: (...args: Parameters<typeof module.xchacha20poly1305>) => {
      const cipher = module.xchacha20poly1305(...args);
      return {
        ...cipher,
        decrypt: (...input: Parameters<typeof cipher.decrypt>) => {
          if (calls.failure) throw calls.failure;
          return cipher.decrypt(...input);
        },
      };
    },
  };
});
const vector = JSON.parse(
  readFileSync(
    new URL('../../engine/tests/fixtures/recovery-direct-v1-vector.json', import.meta.url),
    'utf8',
  ),
) as { envelopeCanonical: string; secret: string };

describe('cryptographic error boundaries', () => {
  it('rejects malformed data before deriving a key', () => {
    calls.derivations = 0;
    expect(openDirectVaultV1(new TextEncoder().encode('{}'), new Uint8Array(32))).toEqual({
      ok: false,
      code: 'INVALID_ENVELOPE',
    });
    expect(calls.derivations).toBe(0);
  });
  it('propagates unexpected cipher errors', () => {
    const failure = new Error('unexpected cipher failure');
    calls.failure = failure;
    try {
      expect(() =>
        openDirectVaultV1(
          new TextEncoder().encode(vector.envelopeCanonical),
          Uint8Array.from(Buffer.from(vector.secret, 'hex')),
        ),
      ).toThrow(failure);
    } finally {
      calls.failure = null;
    }
  });
});
