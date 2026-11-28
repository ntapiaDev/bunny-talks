import { describe, expect, it } from 'vitest';
import { loginResponseSchema, sessionDtoSchema } from '../src/index.js';

const session = {
  accountId: 'account-fixture',
  sessionId: 'cbbbf3b9-b6e3-41a2-8c6c-bbe37186625f',
  deviceId: 'd8c49125-e0fb-4a9e-bdc2-09c57ad4382a',
  deviceState: 'pending' as const,
  expiresAt: '2026-12-16T12:00:00.000Z',
};

describe('shared login and session response contracts', () => {
  it('preserves a large PostgreSQL credential revision as a canonical decimal string', () => {
    const credentialRevision = '9007199254740993';
    expect(sessionDtoSchema.parse({ ...session, credentialRevision })).toEqual({
      ...session,
      credentialRevision,
    });
  });

  it.each(['0', '01', '-1', '9223372036854775808', 9007199254740992])(
    'rejects invalid or lossy credential revisions %#',
    (credentialRevision) => {
      expect(sessionDtoSchema.safeParse({ ...session, credentialRevision }).success).toBe(false);
    },
  );

  it('accepts login response with matching opaque token and session identifiers', () => {
    const response = {
      sessionToken: `s1.${session.sessionId}.${'A'.repeat(43)}`,
      session,
    };
    expect(loginResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects login token identity substitution and additional secret fields', () => {
    const response = {
      sessionToken: `s1.${session.sessionId}.${'A'.repeat(43)}`,
      session,
    };
    expect(
      loginResponseSchema.safeParse({
        ...response,
        sessionToken: `s1.${session.deviceId}.${'A'.repeat(43)}`,
      }).success,
    ).toBe(false);
    expect(loginResponseSchema.safeParse({ ...response, verifier: 'fixture' }).success).toBe(false);
  });
});
