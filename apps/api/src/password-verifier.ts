import { Buffer } from 'node:buffer';
import * as crypto from 'node:crypto';
import { encodeEnvelopePassword } from '@bunny-talks/crypto-backup';

export type PasswordVerifierErrorCode =
  'INVALID_PASSWORD' | 'INVALID_VERIFIER' | 'CRYPTO_UNAVAILABLE' | 'BUSY';

export class PasswordVerifierError extends Error {
  public constructor(public readonly code: PasswordVerifierErrorCode) {
    super(code);
    this.name = 'PasswordVerifierError';
  }
}

// Only explicitly supported profiles may reach the native implementation.
const prefix = '$argon2id$v=19$m=19456,t=2,p=1$';
const pattern = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;
let active = 0;
const maxConcurrent = 2;

type ParsedVerifier = { salt: Buffer; hash: Buffer };

function parseVerifier(value: unknown): ParsedVerifier {
  if (typeof value !== 'string' || value.length > 128) {
    throw new PasswordVerifierError('INVALID_VERIFIER');
  }
  const match = pattern.exec(value);
  if (!match || !match[1] || !match[2]) throw new PasswordVerifierError('INVALID_VERIFIER');
  const salt = Buffer.from(match[1], 'base64');
  const hash = Buffer.from(match[2], 'base64');
  if (
    salt.length !== 16 ||
    hash.length !== 32 ||
    salt.toString('base64').replace(/=+$/, '') !== match[1] ||
    hash.toString('base64').replace(/=+$/, '') !== match[2]
  ) {
    salt.fill(0);
    hash.fill(0);
    throw new PasswordVerifierError('INVALID_VERIFIER');
  }
  return { salt, hash };
}

export function validatePasswordVerifier(value: unknown): boolean {
  try {
    const parsed = parseVerifier(value);
    parsed.salt.fill(0);
    parsed.hash.fill(0);
    return true;
  } catch {
    return false;
  }
}

export function passwordVerifierNeedsRehash(value: unknown): boolean {
  const parsed = parseVerifier(value);
  parsed.salt.fill(0);
  parsed.hash.fill(0);
  // The sole supported profile is current; add explicit older profiles when introduced.
  return false;
}

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  let bytes: Uint8Array;
  try {
    bytes = encodeEnvelopePassword(password);
  } catch {
    throw new PasswordVerifierError('INVALID_PASSWORD');
  }
  if (active >= maxConcurrent) {
    bytes.fill(0);
    throw new PasswordVerifierError('BUSY');
  }
  active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      crypto.argon2(
        'argon2id',
        {
          message: bytes,
          nonce: salt,
          parallelism: 1,
          tagLength: 32,
          memory: 19456,
          passes: 2,
        },
        (error, result) => {
          const output: unknown = result;
          if (error || !Buffer.isBuffer(output) || output.length !== 32) {
            if (ArrayBuffer.isView(output)) {
              new Uint8Array(output.buffer, output.byteOffset, output.byteLength).fill(0);
            } else if (output instanceof ArrayBuffer) {
              new Uint8Array(output).fill(0);
            }
            reject(new Error('CRYPTO_UNAVAILABLE'));
          } else resolve(output);
        },
      );
    });
  } catch {
    throw new PasswordVerifierError('CRYPTO_UNAVAILABLE');
  } finally {
    bytes.fill(0);
    active--;
  }
}

export async function createPasswordVerifier(password: string): Promise<string> {
  let salt: Buffer;
  try {
    salt = crypto.randomBytes(16);
  } catch {
    throw new PasswordVerifierError('CRYPTO_UNAVAILABLE');
  }
  try {
    const hash = await derive(password, salt);
    try {
      return `${prefix}${salt.toString('base64').replace(/=+$/, '')}$${hash.toString('base64').replace(/=+$/, '')}`;
    } finally {
      hash.fill(0);
    }
  } finally {
    salt.fill(0);
  }
}

export async function verifyPassword(password: string, verifier: unknown): Promise<boolean> {
  const { salt, hash } = parseVerifier(verifier);
  try {
    const actual = await derive(password, salt);
    try {
      return crypto.timingSafeEqual(hash, actual);
    } finally {
      actual.fill(0);
    }
  } finally {
    salt.fill(0);
    hash.fill(0);
  }
}
