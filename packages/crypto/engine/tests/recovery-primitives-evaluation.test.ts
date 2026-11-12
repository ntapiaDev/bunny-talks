import { createCipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { gcm } from '@noble/ciphers/aes.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';

const utf8 = (value: string) => new TextEncoder().encode(value);
const fromHex = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));

describe('recovery primitive candidates under Node', () => {
  it('matches RFC 5869 HKDF-SHA-256 test case 1', () => {
    const ikm = new Uint8Array(22).fill(0x0b);
    const salt = fromHex('000102030405060708090a0b0c');
    const info = fromHex('f0f1f2f3f4f5f6f7f8f9');
    const expected = fromHex(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
    const actual = hkdf(sha256, ikm, salt, info, 42);
    expect(actual).toEqual(expected);
  });

  it('separates derived keys when usage context changes', () => {
    const secret = randomBytes(32);
    const salt = randomBytes(16);
    const first = hkdf(sha256, secret, salt, utf8('test-context-a'), 32);
    const second = hkdf(sha256, secret, salt, utf8('test-context-b'), 32);
    try {
      expect(timingSafeEqual(first, second)).toBe(false);
    } finally {
      secret.fill(0);
      first.fill(0);
      second.fill(0);
    }
  });

  it('rejects decryption when a different random secret derives the key', () => {
    const secret = randomBytes(32);
    const wrongSecret = randomBytes(32);
    const salt = randomBytes(16);
    const nonce = randomBytes(24);
    const info = utf8('test-context');
    const key = hkdf(sha256, secret, salt, info, 32);
    const wrongKey = hkdf(sha256, wrongSecret, salt, info, 32);
    try {
      const ciphertext = xchacha20poly1305(key, nonce).encrypt(utf8('public test data'));
      expect(() => xchacha20poly1305(wrongKey, nonce).decrypt(ciphertext)).toThrow();
    } finally {
      secret.fill(0);
      wrongSecret.fill(0);
      key.fill(0);
      wrongKey.fill(0);
    }
  });

  it('rejects decryption with a key derived for another context version', () => {
    const secret = randomBytes(32);
    const salt = randomBytes(16);
    const nonce = randomBytes(24);
    const key = hkdf(sha256, secret, salt, utf8('test-purpose:v1'), 32);
    const otherKey = hkdf(sha256, secret, salt, utf8('test-purpose:v2'), 32);
    try {
      const ciphertext = xchacha20poly1305(key, nonce).encrypt(utf8('public test data'));
      expect(() => xchacha20poly1305(otherKey, nonce).decrypt(ciphertext)).toThrow();
    } finally {
      secret.fill(0);
      key.fill(0);
      otherKey.fill(0);
    }
  });

  it('matches the CFRG XChaCha20-Poly1305 ciphertext and tag vector', () => {
    // Expired Internet-Draft, appendix A.3.1: https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha-03#appendix-A.3.1
    const key = fromHex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
    const nonce = fromHex('404142434445464748494a4b4c4d4e4f5051525354555657');
    const aad = fromHex('50515253c0c1c2c3c4c5c6c7');
    const plaintext = fromHex(
      '4c616469657320616e642047656e746c656d656e206f662074686520636c6173' +
        '73206f66202739393a204966204920636f756c64206f6666657220796f75206f' +
        '6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73' +
        '637265656e20776f756c642062652069742e',
    );
    const ciphertext = fromHex(
      'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb' +
        '731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452' +
        '2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9' +
        '21f9664c97637da9768812f615c68b13b52e',
    );
    const tag = fromHex('c0875924c1c7987947deafd8780acf49');
    const actual = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
    expect(actual.subarray(0, -16)).toEqual(ciphertext);
    expect(actual.subarray(-16)).toEqual(tag);
    expect(xchacha20poly1305(key, nonce, aad).decrypt(actual)).toEqual(plaintext);
  });

  it('matches the AES-256-GCM specification all-zero known-answer vector', () => {
    // GCM specification, test case 14: https://csrc.nist.rip/groups/ST/toolkit/BCM/documents/proposedmodes/gcm/gcm-spec.pdf
    const key = new Uint8Array(32);
    const nonce = new Uint8Array(12);
    const plaintext = new Uint8Array(16);
    const expected = fromHex('cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919');
    expect(gcm(key, nonce).encrypt(plaintext)).toEqual(expected);
    expect(gcm(key, nonce).decrypt(expected)).toEqual(plaintext);
  });

  it('shows that generic GCM accepts key and nonce sizes beyond the evaluated profile', () => {
    const ciphertext = gcm(new Uint8Array(16), new Uint8Array(8)).encrypt(new Uint8Array());
    expect(gcm(new Uint8Array(16), new Uint8Array(8)).decrypt(ciphertext)).toHaveLength(0);
  });

  it('matches Node AES-256-GCM for ciphertext, tag and authenticated context', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const aad = utf8('test-associated-context');
    const plaintext = utf8('public test data');
    try {
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad);
      const expected = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      const encrypted = gcm(key, nonce, aad).encrypt(plaintext);
      expect(Buffer.from(encrypted)).toEqual(expected);
      expect(gcm(key, nonce, aad).decrypt(encrypted)).toEqual(plaintext);
    } finally {
      key.fill(0);
    }
  });

  for (const algorithm of [
    { name: 'AES-256-GCM', nonceLength: 12, construct: gcm },
    { name: 'XChaCha20-Poly1305', nonceLength: 24, construct: xchacha20poly1305 },
  ]) {
    it(`${algorithm.name} rejects wrong keys and modified ciphertext or context`, () => {
      const key = randomBytes(32);
      const wrongKey = randomBytes(32);
      const nonce = randomBytes(algorithm.nonceLength);
      const aad = utf8('test-associated-context');
      const plaintext = utf8('public test data');
      try {
        const ciphertext = algorithm.construct(key, nonce, aad).encrypt(plaintext);
        expect(algorithm.construct(key, nonce, aad).decrypt(ciphertext)).toEqual(plaintext);
        expect(() => algorithm.construct(wrongKey, nonce, aad).decrypt(ciphertext)).toThrow();
        const tampered = ciphertext.slice();
        tampered[0] = tampered[0]! ^ 1;
        expect(() => algorithm.construct(key, nonce, aad).decrypt(tampered)).toThrow();
        const tamperedTag = ciphertext.slice();
        tamperedTag[tamperedTag.length - 1] = tamperedTag[tamperedTag.length - 1]! ^ 1;
        expect(() => algorithm.construct(key, nonce, aad).decrypt(tamperedTag)).toThrow();
        const tamperedNonce = Uint8Array.from(nonce);
        tamperedNonce[0] = tamperedNonce[0]! ^ 1;
        expect(() => algorithm.construct(key, tamperedNonce, aad).decrypt(ciphertext)).toThrow();
        expect(() =>
          algorithm.construct(key, nonce, utf8('different-context')).decrypt(ciphertext),
        ).toThrow();
        expect(() =>
          algorithm.construct(key, nonce, aad).decrypt(ciphertext.subarray(0, 15)),
        ).toThrow();
      } finally {
        key.fill(0);
        wrongKey.fill(0);
      }
    });
  }

  it('rejects invalid key and nonce sizes', () => {
    expect(() => gcm(new Uint8Array(31), new Uint8Array(12)).encrypt(new Uint8Array())).toThrow();
    expect(() =>
      xchacha20poly1305(new Uint8Array(31), new Uint8Array(24)).encrypt(new Uint8Array()),
    ).toThrow();
    expect(() =>
      xchacha20poly1305(new Uint8Array(32), new Uint8Array(23)).encrypt(new Uint8Array()),
    ).toThrow();
    expect(() =>
      xchacha20poly1305(new Uint8Array(33), new Uint8Array(24)).encrypt(new Uint8Array()),
    ).toThrow();
    expect(() =>
      xchacha20poly1305(new Uint8Array(32), new Uint8Array(25)).encrypt(new Uint8Array()),
    ).toThrow();
  });
});
