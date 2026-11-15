import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export class SessionError extends Error {
  public constructor(
    public readonly code: 'INVALID_INPUT' | 'INVALID_SESSION' | 'UNAVAILABLE' | 'OUTCOME_UNKNOWN',
  ) {
    super(code);
    this.name = 'SessionError';
  }
}

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function generateDeviceId(): string {
  try {
    return randomUUID();
  } catch {
    throw new SessionError('UNAVAILABLE');
  }
}

export function parseSessionToken(value: unknown): { id: string; hash: Buffer } {
  return parseOpaqueToken(value, 's1');
}
export function parseOpaqueToken(
  value: unknown,
  expectedVersion: 's1' | 'r1' | 'e1',
): { id: string; hash: Buffer } {
  if (typeof value !== 'string' || value.length !== 83) throw new SessionError('INVALID_SESSION');
  const [version, id, secret] = value.split('.');
  if (
    version !== expectedVersion ||
    !id ||
    !uuidPattern.test(id) ||
    !secret ||
    !/^[A-Za-z0-9_-]{43}$/.test(secret)
  )
    throw new SessionError('INVALID_SESSION');
  const bytes = Buffer.from(secret, 'base64url');
  try {
    if (bytes.length !== 32 || bytes.toString('base64url') !== secret)
      throw new SessionError('INVALID_SESSION');
    return { id, hash: createHash('sha256').update(bytes).digest() };
  } finally {
    bytes.fill(0);
  }
}

export function generateSessionToken(): { id: string; token: string; hash: Buffer } {
  return generateOpaqueToken('s1');
}
export function generateOpaqueToken(version: 's1' | 'r1' | 'e1'): {
  id: string;
  token: string;
  hash: Buffer;
} {
  let bytes: Buffer | undefined;
  try {
    const id = randomUUID();
    bytes = randomBytes(32);
    return {
      id,
      token: `${version}.${id}.${bytes.toString('base64url')}`,
      hash: createHash('sha256').update(bytes).digest(),
    };
  } catch {
    throw new SessionError('UNAVAILABLE');
  } finally {
    bytes?.fill(0);
  }
}
