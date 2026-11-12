import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { base64ToBytes, bytesToBase64 } from '@open-e2ee/signal-protocol-sdk/encoding';
import { asBase64 } from '@open-e2ee/signal-protocol-sdk/types/utils';
import { CryptoError } from '@bunny-talks/crypto-core';

function invalidIdentity(): CryptoError {
  return new CryptoError('INVALID_INPUT', 'Invalid exported identity');
}

function readPair(
  pair: unknown,
  buffers: Uint8Array[],
  invalid: CryptoError,
): [Uint8Array, Uint8Array] {
  if (typeof pair !== 'object' || pair === null) throw invalid;
  const fields = pair as Record<string, unknown>;
  const decode = (input: unknown): Uint8Array => {
    // The last Base64 character must have zero padding bits for 32 bytes.
    if (typeof input !== 'string' || !/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(input)) {
      throw invalid;
    }
    const bytes = base64ToBytes(asBase64(input));
    buffers.push(bytes);
    if (bytes.length !== 32 || bytesToBase64(bytes) !== input) throw invalid;
    return bytes;
  };
  return [decode(fields.publicKey), decode(fields.privateKey)];
}

/** Checks key-pair consistency, not the authenticity or origin of an identity. */
export function validateExportedIdentity(identity: unknown): void {
  const buffers: Uint8Array[] = [];
  const invalid = invalidIdentity();
  try {
    if (typeof identity !== 'object' || identity === null) throw invalid;
    const value = identity as Record<string, unknown>;
    const [dhPublic, dhPrivate] = readPair(value.dhKey, buffers, invalid);
    const [signingPublic, signingPrivate] = readPair(value.signingKey, buffers, invalid);
    const derivedDh = x25519.getPublicKey(dhPrivate);
    buffers.push(derivedDh);
    const derivedSigning = ed25519.getPublicKey(signingPrivate);
    buffers.push(derivedSigning);
    // Fixed work at source level; JavaScript cannot guarantee constant time.
    let difference = 0;
    for (let i = 0; i < 32; i++) {
      difference |= dhPublic[i]! ^ derivedDh[i]!;
      difference |= signingPublic[i]! ^ derivedSigning[i]!;
    }
    if (difference !== 0) throw invalid;
  } catch (error) {
    if (error === invalid) throw invalid;
    throw new CryptoError('UNKNOWN', 'Identity validation failed');
  } finally {
    for (const buffer of buffers) buffer.fill(0);
  }
}
