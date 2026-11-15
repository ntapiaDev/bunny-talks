import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { sessionIsActive } from '../src/postgres-session-repository.js';
import { generateSessionToken, parseSessionToken } from '../src/session-token.js';

describe('opaque session tokens', () => {
  it('uses independent identifiers and secrets and parses canonical encoding', () => {
    const first = generateSessionToken();
    const second = generateSessionToken();
    expect(first.id).not.toBe(second.id);
    expect(first.token.split('.')[2]).not.toBe(second.token.split('.')[2]);
    expect(parseSessionToken(first.token).hash).toEqual(first.hash);
    for (const token of [
      first.id,
      first.token + '=',
      first.token.toUpperCase(),
      '',
      null,
      first.token.slice(0, -1) + '!',
    ])
      expect(() => parseSessionToken(token)).toThrow('INVALID_SESSION');
    const noncanonical = `s1.${first.id}.${Buffer.alloc(32).toString('base64url').slice(0, -1)}B`;
    expect(() => parseSessionToken(noncanonical)).toThrow('INVALID_SESSION');
  });
  it('enforces exact absolute and idle boundaries', () => {
    const row = {
      tokenHash: Buffer.alloc(32),
      revokedAt: null,
      createdAt: new Date(0),
      lastSeenAt: new Date(10),
      expiresAt: new Date(100),
      idleTimeoutMs: 20,
    };
    expect(sessionIsActive(row, new Date(29))).toBe(true);
    expect(sessionIsActive(row, new Date(30))).toBe(false);
    expect(sessionIsActive({ ...row, idleTimeoutMs: null }, new Date(100))).toBe(false);
    expect(sessionIsActive({ ...row, idleTimeoutMs: null }, new Date(99))).toBe(true);
    expect(sessionIsActive(row, new Date(9))).toBe(false);
  });
  it('sanitizes native random failures', async () => {
    vi.resetModules();
    vi.doMock('node:crypto', () => ({
      randomUUID: () => {
        throw new Error('sensitive-native-detail');
      },
    }));
    try {
      const module = await import('../src/session-token.js');
      expect(() => module.generateSessionToken()).toThrow('UNAVAILABLE');
    } finally {
      vi.doUnmock('node:crypto');
      vi.resetModules();
    }
  });
});
