import { describe, expect, it } from 'vitest';
import { publicationDigest } from '../src/publication-digest.js';

describe('publication digest', () => {
  it('hashes exact bytes and uses unpadded base64url', () => {
    expect(publicationDigest(new TextEncoder().encode('abc'))).toBe(
      'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0',
    );
    expect(publicationDigest(new Uint8Array([0, 255]))).not.toBe(
      publicationDigest(new Uint8Array([0, 254])),
    );
  });
});
