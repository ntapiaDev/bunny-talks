import { describe, expect, it } from 'vitest';
import { CryptoError } from '@bunny-talks/crypto-core';
import { base64ToBytes, bytesToBase64 } from '@open-e2ee/signal-protocol-sdk/encoding';
import { generateIdentityKeyPair } from '@open-e2ee/signal-protocol-sdk/keys';
import { validateExportedIdentity } from '../src/index.js';

describe('validateExportedIdentity', () => {
  it('accepts a JSON round trip without mutating its input', async () => {
    const identity: unknown = JSON.parse(JSON.stringify(await generateIdentityKeyPair()));
    const before = JSON.stringify(identity);
    validateExportedIdentity(identity);
    expect(JSON.stringify(identity)).toBe(before);
  });

  it('uses independent decoded buffers', async () => {
    const identity = await generateIdentityKeyPair();
    const first = base64ToBytes(identity.dhKey.privateKey);
    const second = base64ToBytes(identity.dhKey.privateKey);
    expect(first.buffer).not.toBe(second.buffer);
    const copy = second.slice();
    first.fill(0);
    expect(second).toEqual(copy);
    second.fill(0);
    copy.fill(0);
  });

  it('accepts X25519 private keys differing only in clamped bits', async () => {
    const identity = await generateIdentityKeyPair();
    const privateBytes = base64ToBytes(identity.dhKey.privateKey);
    try {
      privateBytes[0] = privateBytes[0]! ^ 7;
      privateBytes[31] = privateBytes[31]! ^ 0xc0;
      const modified = {
        ...identity,
        dhKey: { ...identity.dhKey, privateKey: bytesToBase64(privateBytes) },
      };
      expect(() => validateExportedIdentity(modified)).not.toThrow();
    } finally {
      privateBytes.fill(0);
    }
  });

  it('returns a typed invalid input error', async () => {
    try {
      validateExportedIdentity(null);
      expect.fail('Expected invalid input');
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoError);
      expect(error).toMatchObject({ code: 'INVALID_INPUT', message: 'Invalid exported identity' });
    }
  });

  it('rejects a 64-byte Ed25519 private key and Base64 whitespace', async () => {
    const identity = await generateIdentityKeyPair();
    const longKey = bytesToBase64(new Uint8Array(64));
    expect(() =>
      validateExportedIdentity({
        ...identity,
        signingKey: { ...identity.signingKey, privateKey: longKey },
      }),
    ).toThrow('Invalid exported identity');
    for (const whitespace of [' ', '\n', '\r\n', '\t']) {
      const privateKey = identity.signingKey.privateKey;
      const malformed = privateKey.slice(0, 10) + whitespace + privateKey.slice(10);
      expect(() =>
        validateExportedIdentity({
          ...identity,
          signingKey: { ...identity.signingKey, privateKey: malformed },
        }),
      ).toThrow('Invalid exported identity');
    }
  });
  it('accepts a generated composite identity', async () => {
    const identity = await generateIdentityKeyPair();
    expect(() => validateExportedIdentity(identity)).not.toThrow();
  });

  it('rejects mismatched public and private keys for both algorithms', async () => {
    const a = await generateIdentityKeyPair();
    const b = await generateIdentityKeyPair();
    for (const field of ['dhKey', 'signingKey'] as const) {
      expect(() =>
        validateExportedIdentity({ ...a, [field]: { ...a[field], publicKey: b[field].publicKey } }),
      ).toThrow('Invalid exported identity');
      expect(() =>
        validateExportedIdentity({
          ...a,
          [field]: { ...a[field], privateKey: b[field].privateKey },
        }),
      ).toThrow('Invalid exported identity');
    }
  });

  it('rejects missing, malformed, noncanonical and wrong-length fields', async () => {
    const identity = await generateIdentityKeyPair();
    for (const invalid of [null, {}, { dhKey: null }, { ...identity, signingKey: {} }]) {
      expect(() => validateExportedIdentity(invalid)).toThrow('Invalid exported identity');
    }
    for (const field of ['dhKey', 'signingKey'] as const) {
      for (const key of ['publicKey', 'privateKey'] as const) {
        for (const bad of [
          '',
          '!',
          'A'.repeat(43),
          'A'.repeat(42) + 'B=',
          'A'.repeat(40) + '====',
          'A'.repeat(44),
        ]) {
          expect(() =>
            validateExportedIdentity({ ...identity, [field]: { ...identity[field], [key]: bad } }),
          ).toThrow('Invalid exported identity');
        }
      }
    }
  });
});
