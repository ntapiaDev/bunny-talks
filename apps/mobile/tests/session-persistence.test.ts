import { describe, expect, it } from 'vitest';
import type { LoginResponse } from '@bunny-talks/contracts';
import {
  createSessionPersistence,
  SessionPersistenceError,
} from '../src/composition/session-persistence';

const identity = {
  accountId: 'account-fixture',
  sessionId: 'cbbbf3b9-b6e3-41a2-8c6c-bbe37186625f',
  deviceId: 'd8c49125-e0fb-4a9e-bdc2-09c57ad4382a',
  deviceState: 'pending' as const,
  expiresAt: '2026-12-16T12:00:00.000Z',
};
const login: LoginResponse = {
  sessionToken: `s1.${identity.sessionId}.${'A'.repeat(43)}`,
  session: identity,
};

function stores(options: { secret?: string | null; metadata?: string | null } = {}) {
  const values = { secret: options.secret ?? null, metadata: options.metadata ?? null };
  return {
    values,
    secret: {
      async read() {
        return values.secret;
      },
      async write(value: string) {
        values.secret = value;
      },
    },
    metadata: {
      async read() {
        return values.metadata;
      },
      async write(value: string) {
        values.metadata = value;
      },
    },
  };
}

describe('durable session split storage', () => {
  it('stores the bearer separately and persists the validated credential revision', async () => {
    const storage = stores();
    const persistence = createSessionPersistence({
      ...storage,
      now: () => Date.parse('2026-11-28T00:00:00.000Z'),
    });
    await persistence.saveLogin(login);
    expect(storage.values.secret).toBe(login.sessionToken);
    expect(storage.values.metadata).not.toContain(login.sessionToken);
    expect(storage.values.metadata).not.toContain('password');
    expect(await persistence.read()).toMatchObject({ status: 'needs-validation', session: identity });

    const validated = { ...identity, credentialRevision: '9007199254740993' };
    await persistence.acceptValidatedSession(validated);
    expect(await persistence.read()).toEqual({
      status: 'active',
      sessionToken: login.sessionToken,
      session: validated,
    });
    expect(storage.values.metadata).not.toContain(login.sessionToken);
  });

  it('does not replace an existing session on another login', async () => {
    const storage = stores({ secret: login.sessionToken });
    const persistence = createSessionPersistence(storage);
    await expect(persistence.saveLogin(login)).rejects.toThrow(SessionPersistenceError);
    expect(storage.values.secret).toBe(login.sessionToken);
    expect(storage.values.metadata).toBeNull();
  });

  it('reports a partial secret/metadata write and preserves the original bearer', async () => {
    const storage = stores();
    storage.metadata.write = async () => {
      throw new Error('fixture write failure');
    };
    const persistence = createSessionPersistence(storage);
    await expect(persistence.saveLogin(login)).rejects.toThrow(SessionPersistenceError);
    expect(storage.values.secret).toBe(login.sessionToken);
    expect(await persistence.read()).toEqual({ status: 'partial' });
  });

  it.each([
    ['missing metadata', { secret: login.sessionToken }],
    ['missing bearer', { metadata: JSON.stringify({ version: 1, state: 'needs-validation', session: identity }) }],
  ])('does not use partial storage: %s', async (_label, state) => {
    const persistence = createSessionPersistence(stores(state));
    expect(await persistence.read()).toEqual({ status: 'partial' });
  });

  it('distinguishes local expiration and suspends after 401 without deleting the secret', async () => {
    const storage = stores();
    const persistence = createSessionPersistence({
      ...storage,
      now: () => Date.parse('2026-11-28T00:00:00.000Z'),
    });
    await persistence.saveLogin(login);
    await persistence.suspendAfterUnauthorized();
    expect(await persistence.read()).toEqual({ status: 'invalid', session: identity });
    expect(storage.values.secret).toBe(login.sessionToken);

    const expired = createSessionPersistence({
      ...storage,
      now: () => Date.parse('2026-12-17T00:00:00.000Z'),
    });
    expect(await expired.read()).toEqual({ status: 'invalid', session: identity });
  });

  it('marks a locally expired unvalidated session without returning its bearer', async () => {
    const storage = stores();
    const persistence = createSessionPersistence({
      ...storage,
      now: () => Date.parse('2026-12-17T00:00:00.000Z'),
    });
    await persistence.saveLogin(login);
    expect(await persistence.read()).toEqual({ status: 'expired', session: identity });
  });

  it('rejects token/session mismatches and keeps the data unavailable', async () => {
    const storage = stores({
      secret: `s1.${identity.deviceId}.${'A'.repeat(43)}`,
      metadata: JSON.stringify({ version: 1, state: 'needs-validation', session: identity }),
    });
    const persistence = createSessionPersistence(storage);
    expect(await persistence.read()).toEqual({ status: 'partial' });
    await expect(
      persistence.acceptValidatedSession({ ...identity, credentialRevision: '1' }),
    ).rejects.toThrow(SessionPersistenceError);
  });
});
