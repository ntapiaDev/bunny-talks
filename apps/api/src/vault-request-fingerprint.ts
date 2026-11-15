import { createHmac, type KeyObject, timingSafeEqual } from 'node:crypto';
import { VaultRepositoryError } from './vault-repository-error.js';

/** Keys must be independently generated from at least 32 cryptographically random bytes. */
export interface VaultFingerprintKeys {
  readonly activeKeyId: string;
  getKey(keyId: string): KeyObject | undefined;
}

export function requireFingerprintKey(keys: VaultFingerprintKeys, keyId: string): KeyObject {
  try {
    const key = keys.getKey(keyId);
    if (
      typeof keyId !== 'string' ||
      !/^[!-~]{1,128}$/.test(keyId) ||
      !key ||
      key.type !== 'secret' ||
      (key.symmetricKeySize ?? 0) < 32
    )
      throw new VaultRepositoryError('KEY_UNAVAILABLE');
    return key;
  } catch {
    // A provider must not leak infrastructure details or secret material through its errors.
    throw new VaultRepositoryError('KEY_UNAVAILABLE');
  }
}

/** A versioned, fixed-position JSON tuple gives strings and null unambiguous boundaries. */
export function fingerprintRequest(
  keys: VaultFingerprintKeys,
  keyId: string,
  fields: readonly (string | number | null)[],
): Uint8Array<ArrayBuffer> {
  return createHmac('sha256', requireFingerprintKey(keys, keyId))
    .update(JSON.stringify(['bunny-talks/vault-repository/request/v1', keyId, ...fields]))
    .digest();
}

export function equalFingerprints(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === 32 && right.byteLength === 32 && timingSafeEqual(left, right);
}
