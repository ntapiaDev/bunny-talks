import { describe, expect, it, vi } from 'vitest';
import {
  createSessionService,
  createSessionWorkflow,
  SessionCompositionError,
} from '../src/composition/session-composition';
import { createSessionPersistence } from '../src/composition/session-persistence';
import { ApplicationHttpError } from '../src/infrastructure/http/application-http';

const identity = {
  accountId: 'account-fixture',
  sessionId: 'cbbbf3b9-b6e3-41a2-8c6c-bbe37186625f',
  deviceId: 'd8c49125-e0fb-4a9e-bdc2-09c57ad4382a',
  deviceState: 'pending' as const,
  expiresAt: '2026-12-16T12:00:00.000Z',
};
const token = `s1.${identity.sessionId}.${'A'.repeat(43)}`;

describe('mobile session composition', () => {
  it('validates and preserves the existing login response contract', async () => {
    const request = vi.fn().mockResolvedValue({ sessionToken: token, session: identity });
    const service = createSessionService(request);
    await expect(
      service.login({ email: 'user@example.com', password: 'fixture-password' }),
    ).resolves.toEqual({ sessionToken: token, session: identity });
    expect(request).toHaveBeenCalledWith({
      path: '/v1/auth/login',
      method: 'POST',
      body: { email: 'user@example.com', password: 'fixture-password' },
      expectedStatuses: [201],
    });
  });

  it('rejects invalid inputs and inconsistent login token identity before persistence', async () => {
    const request = vi.fn().mockResolvedValue({
      sessionToken: `s1.${identity.deviceId}.${'A'.repeat(43)}`,
      session: identity,
    });
    const service = createSessionService(request);
    await expect(service.login({ email: 'bad', password: 'x' })).rejects.toThrow(
      SessionCompositionError,
    );
    await expect(service.login({ email: 'user@example.com', password: 'x' })).rejects.toThrow(
      SessionCompositionError,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reads the same original session and accepts an exact credential revision string', async () => {
    const dto = { ...identity, credentialRevision: '9007199254740993' };
    const request = vi.fn().mockResolvedValue(dto);
    const service = createSessionService(request);
    await expect(service.read(token, identity)).resolves.toEqual(dto);
    expect(request).toHaveBeenCalledWith({
      path: '/v1/session',
      method: 'GET',
      bearerToken: token,
      expectedStatuses: [200],
    });
  });

  it('revalidates a persisted active session twice and stores the newest credential revision', async () => {
    const values: { secret: string | null; metadata: string | null } = {
      secret: null,
      metadata: null,
    };
    let credentialRevision = '1';
    const request = vi.fn(async (input: { path: string }) => {
      if (input.path === '/v1/auth/login') return { sessionToken: token, session: identity };
      return { ...identity, credentialRevision };
    });
    const service = createSessionService(request);
    const persistence = createSessionPersistence({
      secret: {
        async read() {
          return values.secret;
        },
        async write(value) {
          values.secret = value;
        },
      },
      metadata: {
        async read() {
          return values.metadata;
        },
        async write(value) {
          values.metadata = value;
        },
      },
      now: () => Date.parse('2026-11-28T00:00:00.000Z'),
    });
    const workflow = createSessionWorkflow(service, persistence);

    await workflow.login({ email: 'user@example.com', password: 'fixture-password' });
    await expect(workflow.validateCurrent()).resolves.toMatchObject({
      status: 'active',
      session: { credentialRevision: '1' },
    });
    credentialRevision = '9007199254740993';
    await expect(workflow.validateCurrent()).resolves.toMatchObject({
      status: 'active',
      session: { credentialRevision: '9007199254740993' },
    });
    expect(request.mock.calls.map(([input]) => input.path)).toEqual([
      '/v1/auth/login',
      '/v1/session',
      '/v1/session',
    ]);
    expect(await persistence.read()).toMatchObject({ session: { credentialRevision } });
  });

  it.each(['needs-validation', 'active', 'invalid', 'expired', 'partial'] as const)(
    'does not issue login when existing persistence is %s',
    async (state) => {
      const values: { secret: string | null; metadata: string | null } = {
        secret: null,
        metadata: null,
      };
      let now = Date.parse('2026-11-28T00:00:00.000Z');
      const persistence = createSessionPersistence({
        secret: {
          async read() {
            return values.secret;
          },
          async write(value) {
            values.secret = value;
          },
        },
        metadata: {
          async read() {
            return values.metadata;
          },
          async write(value) {
            values.metadata = value;
          },
        },
        now: () => now,
      });
      if (state === 'partial') {
        values.secret = token;
      } else {
        await persistence.saveLogin({ sessionToken: token, session: identity });
        if (state === 'active')
          await persistence.acceptValidatedSession({ ...identity, credentialRevision: '1' });
        if (state === 'invalid') await persistence.suspendAfterUnauthorized();
        if (state === 'expired') now = Date.parse('2026-12-17T00:00:00.000Z');
      }
      const request = vi.fn().mockResolvedValue({ sessionToken: token, session: identity });
      const workflow = createSessionWorkflow(createSessionService(request), persistence);
      await expect(
        workflow.login({ email: 'user@example.com', password: 'fixture-password' }),
      ).rejects.toMatchObject({
        code: 'SESSION_EXISTS',
      });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('refuses concurrent logins and emits only one request', async () => {
    let release!: (value: { sessionToken: string; session: typeof identity }) => void;
    const request = vi.fn(
      () =>
        new Promise<{ sessionToken: string; session: typeof identity }>((resolve) => {
          release = resolve;
        }),
    );
    const values: { secret: string | null; metadata: string | null } = {
      secret: null,
      metadata: null,
    };
    const persistence = createSessionPersistence({
      secret: {
        async read() {
          return values.secret;
        },
        async write(value) {
          values.secret = value;
        },
      },
      metadata: {
        async read() {
          return values.metadata;
        },
        async write(value) {
          values.metadata = value;
        },
      },
      now: () => Date.parse('2026-11-28T00:00:00.000Z'),
    });
    const workflow = createSessionWorkflow(createSessionService(request), persistence);
    const first = workflow.login({ email: 'user@example.com', password: 'fixture-password' });
    await expect(
      workflow.login({ email: 'user@example.com', password: 'fixture-password' }),
    ).rejects.toMatchObject({ code: 'OPERATION_BUSY' });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    release({ sessionToken: token, session: identity });
    await expect(first).resolves.toEqual({ status: 'needs-validation', session: identity });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refuses another login after an uncertain session metadata write', async () => {
    const values: { secret: string | null; metadata: string | null } = {
      secret: null,
      metadata: null,
    };
    const metadata = {
      writes: 0,
      async read() {
        return values.metadata;
      },
      async write(value: string) {
        this.writes++;
        if (this.writes === 1) throw new Error('fixture uncertain write');
        values.metadata = value;
      },
    };
    const persistence = createSessionPersistence({
      secret: {
        async read() {
          return values.secret;
        },
        async write(value) {
          values.secret = value;
        },
      },
      metadata,
    });
    const request = vi.fn().mockResolvedValue({ sessionToken: token, session: identity });
    const workflow = createSessionWorkflow(createSessionService(request), persistence);
    await expect(
      workflow.login({ email: 'user@example.com', password: 'fixture-password' }),
    ).rejects.toThrow();
    await expect(
      workflow.login({ email: 'user@example.com', password: 'fixture-password' }),
    ).rejects.toMatchObject({
      code: 'SESSION_EXISTS',
    });
    expect(await persistence.read()).toEqual({ status: 'partial' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  function loginPersistence() {
    let token: string | null = null;
    let metadata: string | null = null;
    return createSessionPersistence({
      secret: {
        async read() {
          return token;
        },
        async write(value) {
          token = value;
        },
      },
      metadata: {
        async read() {
          return metadata;
        },
        async write(value) {
          metadata = value;
        },
      },
      now: () => Date.parse('2026-11-28T00:00:00.000Z'),
    });
  }

  it.each([
    new ApplicationHttpError('status', 401),
    new ApplicationHttpError('status', 429),
    new ApplicationHttpError('request'),
  ])('allows a new explicit login after a certain refusal (%s)', async (refusal) => {
    const persistence = loginPersistence();
    const request = vi
      .fn()
      .mockRejectedValueOnce(refusal)
      .mockImplementation(async ({ body }) => {
        expect(body.password).toBe('correct-fixture-password');
        return { sessionToken: token, session: identity };
      });
    const workflow = createSessionWorkflow(createSessionService(request), persistence);
    await expect(
      workflow.login({ email: 'user@example.com', password: 'wrong-fixture-password' }),
    ).rejects.toBe(refusal);
    expect(request).toHaveBeenCalledTimes(1);
    expect(await persistence.read()).toEqual({ status: 'none' });
    await expect(
      workflow.login({ email: 'user@example.com', password: 'correct-fixture-password' }),
    ).resolves.toEqual({ status: 'needs-validation', session: identity });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    new ApplicationHttpError('timeout'),
    new ApplicationHttpError('cancelled'),
    new ApplicationHttpError('network'),
    new ApplicationHttpError('status', 503),
    undefined,
  ])('blocks another login after an unknown outcome (%s)', async (failure) => {
    const persistence = loginPersistence();
    const request = failure
      ? vi.fn().mockRejectedValue(failure)
      : vi.fn().mockResolvedValue({ malformed: true });
    const workflow = createSessionWorkflow(createSessionService(request), persistence);
    const credentials = { email: 'user@example.com', password: 'fixture-password' };
    await expect(workflow.login(credentials)).rejects.toThrow();
    await expect(workflow.login(credentials)).rejects.toMatchObject({
      code: 'LOGIN_OUTCOME_UNKNOWN',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(await persistence.read()).toEqual({ status: 'none' });
  });

  it('requires explicit GET validation even if storage already reports active', async () => {
    const persistence = loginPersistence();
    const dto = { ...identity, credentialRevision: '1', expiresAt: '2099-12-16T12:00:00.000Z' };
    await persistence.saveLogin({
      sessionToken: token,
      session: { ...identity, expiresAt: dto.expiresAt },
    });
    await persistence.acceptValidatedSession(dto);
    const request = vi.fn().mockResolvedValue(dto);
    const workflow = createSessionWorkflow(createSessionService(request), persistence);
    const operation = vi.fn(async () => undefined);
    await expect(workflow.bootstrapSession.withValidatedSession(operation)).rejects.toMatchObject({
      code: 'SESSION_VALIDATION_REQUIRED',
    });
    expect(operation).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    await expect(workflow.validateCurrent()).resolves.toEqual({ status: 'active', session: dto });
    await workflow.bootstrapSession.withValidatedSession(operation);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refuses token or DTO substitution and never logs in again during session validation', async () => {
    const request = vi.fn().mockResolvedValue({ ...identity, credentialRevision: '1' });
    const service = createSessionService(request);
    await expect(
      service.read(`s1.${identity.deviceId}.${'A'.repeat(43)}`, identity),
    ).rejects.toThrow(SessionCompositionError);
    await expect(service.read(token, { ...identity, accountId: 'other-account' })).rejects.toThrow(
      SessionCompositionError,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]!.path).toBe('/v1/session');
  });

  it('suspends the original session on 401 while retaining its bearer and never logging in again', async () => {
    const values: { secret: string | null; metadata: string | null } = {
      secret: null,
      metadata: null,
    };
    const persistence = createSessionPersistence({
      secret: {
        async read() {
          return values.secret;
        },
        async write(value) {
          values.secret = value;
        },
      },
      metadata: {
        async read() {
          return values.metadata;
        },
        async write(value) {
          values.metadata = value;
        },
      },
      now: () => Date.parse('2026-11-28T00:00:00.000Z'),
    });
    const service = createSessionService(async (input) => {
      if (input.path === '/v1/auth/login') return { sessionToken: token, session: identity };
      throw new ApplicationHttpError('status', 401);
    });
    const workflow = createSessionWorkflow(service, persistence);
    await workflow.login({ email: 'user@example.com', password: 'fixture-password' });
    await expect(workflow.validateCurrent()).resolves.toMatchObject({
      status: 'invalid',
      session: identity,
    });
    expect(values.secret).toBe(token);
    expect(JSON.stringify(values.metadata)).not.toContain(token);
  });

  it('does not reuse a bearer after 401 if durable suspension fails in the current runtime', async () => {
    const values: { secret: string | null; metadata: string | null } = {
      secret: null,
      metadata: null,
    };
    let metadataWrites = 0;
    const persistence = createSessionPersistence({
      secret: {
        async read() {
          return values.secret;
        },
        async write(value) {
          values.secret = value;
        },
      },
      metadata: {
        async read() {
          return values.metadata;
        },
        async write(value) {
          metadataWrites++;
          if (metadataWrites === 2) throw new Error('fixture suspension failure');
          values.metadata = value;
        },
      },
      now: () => Date.parse('2026-11-28T00:00:00.000Z'),
    });
    const request = vi.fn(async (input: { path: string }) => {
      if (input.path === '/v1/auth/login') return { sessionToken: token, session: identity };
      throw new ApplicationHttpError('status', 401);
    });
    const workflow = createSessionWorkflow(createSessionService(request), persistence);
    await workflow.login({ email: 'user@example.com', password: 'fixture-password' });
    await expect(workflow.validateCurrent()).resolves.toMatchObject({ status: 'invalid' });
    await expect(workflow.validateCurrent()).resolves.toMatchObject({ status: 'invalid' });
    expect(request.mock.calls.map(([input]) => input.path)).toEqual([
      '/v1/auth/login',
      '/v1/session',
    ]);
  });
});
