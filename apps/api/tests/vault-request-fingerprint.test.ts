import { createHmac, createSecretKey, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  equalFingerprints,
  fingerprintRequest,
  requireFingerprintKey,
} from '../src/vault-request-fingerprint.js';

describe('protected repository request identity', () => {
  const key = createSecretKey(randomBytes(32));
  const keys = {
    activeKeyId: 'test-1',
    getKey: (id: string) => (id === 'test-1' ? key : undefined),
  };

  it('uses Node HMAC-SHA-256 over a domain separated, unambiguous tuple', () => {
    const fields = ['ordinary-password-change', 'account', null, '1', 'opaque verifier'];
    const actual = fingerprintRequest(keys, 'test-1', fields);
    expect(actual).toEqual(
      createHmac('sha256', key)
        .update(JSON.stringify(['bunny-talks/vault-repository/request/v1', 'test-1', ...fields]))
        .digest(),
    );
    expect(equalFingerprints(actual, fingerprintRequest(keys, 'test-1', fields))).toBe(true);
    for (let index = 0; index < fields.length; index++) {
      const changed = [...fields];
      changed[index] = 'different';
      expect(equalFingerprints(actual, fingerprintRequest(keys, 'test-1', changed))).toBe(false);
    }
    expect(
      equalFingerprints(
        fingerprintRequest(keys, 'test-1', ['a', 'bc']),
        fingerprintRequest(keys, 'test-1', ['ab', 'c']),
      ),
    ).toBe(false);
    expect(equalFingerprints(actual, new Uint8Array(31))).toBe(false);
  });

  it('fails closed on missing, short or invalid keys without including input in the error', () => {
    expect(() => requireFingerprintKey(keys, 'missing')).toThrow('KEY_UNAVAILABLE');
    expect(() =>
      fingerprintRequest(
        {
          activeKeyId: 'short',
          getKey: () => createSecretKey(randomBytes(31)),
        },
        'short',
        ['private-input'],
      ),
    ).toThrow(/^KEY_UNAVAILABLE$/);
    expect(() => requireFingerprintKey(keys, '')).toThrow('KEY_UNAVAILABLE');
    expect(() =>
      requireFingerprintKey(
        {
          activeKeyId: 'test-1',
          getKey: () => {
            throw new Error('private-provider-value');
          },
        },
        'test-1',
      ),
    ).toThrow(/^KEY_UNAVAILABLE$/);
  });
});
