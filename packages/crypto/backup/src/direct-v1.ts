import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import canonicalize from 'canonicalize';
import { decodeBase64Url as decode, encodeBase64Url as encode } from './base64url.js';
import type { CryptographicRandomSource } from './random-source.js';
import type { StructuralValidationError } from './structural-validation.js';
import { validateEnvelopeStructureV1 } from './structural-validation.js';

const encoder = new TextEncoder();
const info = encoder.encode('bunny-talks/recovery-vault-direct/v1/key');
const aadPrefix = 'bunny-talks/recovery-vault-direct/v1/aad\n';
const maxPlaintext = 65_536;

/** Account is the canonical base64url encoding of 16 opaque bytes. */
export interface DirectVaultMetadataV1 {
  readonly account: string;
  readonly generation: number;
}

export type OpenDirectVaultResultV1 =
  | { readonly ok: true; readonly plaintext: Uint8Array }
  | { readonly ok: false; readonly code: StructuralValidationError | 'AUTHENTICATION_FAILED' };

function secretCopy(secret: Uint8Array): Uint8Array {
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) {
    throw new TypeError('Recovery secret must contain 32 bytes');
  }
  return Uint8Array.from(secret);
}

function canonical(value: unknown): string {
  const result = canonicalize(value);
  if (typeof result !== 'string') throw new Error('Canonicalization failed');
  return result;
}

/** Experimental only. The caller must provide a verified CSPRNG with fresh independent output. */
export async function createDirectVaultV1(
  plaintext: Uint8Array,
  secret: Uint8Array,
  metadata: DirectVaultMetadataV1,
  random: CryptographicRandomSource,
): Promise<Uint8Array> {
  if (!(plaintext instanceof Uint8Array) || plaintext.byteLength > maxPlaintext) {
    throw new TypeError('Invalid plaintext');
  }
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    Object.keys(metadata).length !== 2 ||
    !Object.hasOwn(metadata, 'account') ||
    !Object.hasOwn(metadata, 'generation') ||
    typeof metadata.account !== 'string' ||
    !/^[A-Za-z0-9_-]{21}[AQgw]$/.test(metadata.account) ||
    !Number.isSafeInteger(metadata.generation) ||
    metadata.generation < 1
  )
    throw new TypeError('Invalid metadata');
  if (!random || typeof random.fill !== 'function') throw new TypeError('Random source required');
  const secretSnapshot = secretCopy(secret);
  const plaintextSnapshot = Uint8Array.from(plaintext);
  const account = metadata.account;
  const generation = metadata.generation;
  let key: Uint8Array | undefined;
  try {
    const saltBuffer = new Uint8Array(16);
    await random.fill(saltBuffer);
    if (saltBuffer.byteLength !== 16) throw new TypeError('Invalid random salt');
    const salt = Uint8Array.from(saltBuffer);
    const nonceBuffer = new Uint8Array(24);
    await random.fill(nonceBuffer);
    if (nonceBuffer.byteLength !== 24) throw new TypeError('Invalid random nonce');
    const nonce = Uint8Array.from(nonceBuffer);
    const header = {
      account,
      format: 'bunny-recovery-vault-direct',
      generation,
      nonce: encode(nonce),
      profile: 'hkdf-sha256-xchacha20poly1305-v1',
      purpose: 'identity-recovery',
      salt: encode(salt),
      version: 1,
    };
    key = hkdf(sha256, secretSnapshot, salt, info, 32);
    const ciphertext = xchacha20poly1305(
      key,
      nonce,
      encoder.encode(aadPrefix + canonical(header)),
    ).encrypt(plaintextSnapshot);
    return encoder.encode(canonical({ ciphertext: encode(ciphertext), header }));
  } finally {
    secretSnapshot.fill(0);
    plaintextSnapshot.fill(0);
    key?.fill(0);
  }
}

/** Structural rejection precedes key derivation; successful plaintext is authenticated, not authorized. */
export function openDirectVaultV1(input: Uint8Array, secret: Uint8Array): OpenDirectVaultResultV1 {
  const validation = validateEnvelopeStructureV1(input);
  if (!validation.ok) return validation;
  const secretSnapshot = secretCopy(secret);
  let key: Uint8Array | undefined;
  try {
    const { header, ciphertext } = validation.envelope;
    key = hkdf(sha256, secretSnapshot, decode(header.salt), info, 32);
    const cipher = xchacha20poly1305(
      key,
      decode(header.nonce),
      encoder.encode(aadPrefix + canonical(header)),
    );
    try {
      return { ok: true, plaintext: cipher.decrypt(decode(ciphertext)) };
    } catch (error) {
      // Noble 2.4.0 has no typed authentication error; this exact message is version-specific.
      if (error instanceof Error && error.message === 'invalid tag') {
        return { ok: false, code: 'AUTHENTICATION_FAILED' };
      }
      throw error;
    }
  } finally {
    secretSnapshot.fill(0);
    key?.fill(0);
  }
}
