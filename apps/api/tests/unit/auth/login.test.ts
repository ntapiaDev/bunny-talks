import { describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../../src/app.module.js';
import { AuthenticationError } from '../../../src/auth/authentication-error.js';
import { LoginController } from '../../../src/auth/login/login.controller.js';
import { LoginService } from '../../../src/auth/login/login.service.js';
import { readLoginConfig } from '../../../src/auth/login/login-config.js';
import type * as PasswordVerifierModule from '../../../src/auth/password-verifier.js';
import { PasswordVerifierError, verifyPassword } from '../../../src/auth/password-verifier.js';
import type { PostgresSessionRepository } from '../../../src/auth/sessions/postgres-session-repository.js';
import { SessionError } from '../../../src/auth/sessions/session-token.js';
import { dummyLoginVerifier, VerifiedLogin } from '../../../src/auth/verified-login.js';
import { classifyHttpError } from '../../../src/shared/http/http-error-filter.js';

vi.mock('../../../src/auth/password-verifier.js', async (original) => ({
  ...(await original<typeof PasswordVerifierModule>()),
  verifyPassword: vi.fn(async () => false),
}));
const env = { LOGIN_ENABLED: 'true', LOGIN_HMAC_KEY: 'a'.repeat(64) };
const credential = {
  accountId: 'account',
  canonical: 'alice@example.com',
  verifiedAtMs: 1,
  revision: 1n,
  verifierUpdatedAtMs: 2,
  verifier: dummyLoginVerifier,
};
const input = { email: 'Alice@Example.com', password: '  e\u0301 😀  ' };

function fixture() {
  vi.mocked(verifyPassword).mockReset().mockResolvedValue(true);
  const release = vi.fn(async () => undefined);
  const credentials = { find: vi.fn(async () => credential) };
  const limits = {
    admit: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => undefined),
    acquire: vi.fn(async () => ({ id: 'lease', release })),
  };
  const sessions = {
    createAfterLogin: vi.fn<PostgresSessionRepository['createAfterLogin']>(async () => ({
      token: 'only-response-token',
      session: {
        id: 'session',
        accountId: 'account',
        deviceId: 'device',
        deviceState: 'pending' as const,
        createdAt: new Date(1),
        lastSeenAt: new Date(1),
        expiresAt: new Date(1000),
      },
    })),
  };
  return {
    service: new LoginService({ config: readLoginConfig(env)!, credentials, limits, sessions }),
    credentials,
    limits,
    sessions,
    release,
  };
}

describe('login configuration and error mapping', () => {
  it('is disabled by default and independent of registration', () => {
    expect(readLoginConfig({})).toBeUndefined();
    expect(readLoginConfig({ LOGIN_ENABLED: 'false' })).toBeUndefined();
    expect(readLoginConfig({ ...env, REGISTRATION_ENABLED: 'false' })).toBeDefined();
  });
  it('also refuses production activation through direct typed module composition', () => {
    expect(() =>
      AppModule.register({
        databaseUrl: 'unused',
        host: '127.0.0.1',
        port: 3000,
        mode: 'production',
        login: readLoginConfig(env)!,
      }),
    ).toThrow('Invalid login configuration');
  });
  it.each([
    { LOGIN_ENABLED: 'yes' },
    { LOGIN_HMAC_KEY: 'private' },
    { NODE_ENV: 'production' },
    { REGISTRATION_HMAC_KEY: env.LOGIN_HMAC_KEY },
    { LOGIN_CONCURRENCY: '3' },
    { LOGIN_WINDOW_MS: '0' },
    { LOGIN_LEASE_MS: '9999' },
    { LOGIN_REQUESTS_PER_SOURCE: 'NaN' },
    { LOGIN_REQUESTS_PER_EMAIL: '101' },
    { LOGIN_HASHES_PER_WINDOW: '121' },
    { LOGIN_REQUESTS_GLOBALLY: '1.5' },
    { LOGIN_MAXIMUM_RECORDS_PER_ACCOUNT: '0' },
  ])('rejects invalid settings without reflecting values %#', (override) => {
    expect(() => readLoginConfig({ ...env, ...override })).toThrow('Invalid login configuration');
  });
  it.each([
    ['INVALID_CREDENTIALS', 401, 'UNAUTHORIZED'],
    ['RATE_LIMITED', 429, 'TOO_MANY_REQUESTS'],
    ['BUSY', 503, 'SERVICE_UNAVAILABLE'],
    ['UNAVAILABLE', 503, 'SERVICE_UNAVAILABLE'],
    ['CRYPTO_UNAVAILABLE', 503, 'SERVICE_UNAVAILABLE'],
    ['OUTCOME_UNKNOWN', 503, 'OUTCOME_UNKNOWN'],
  ] as const)('maps %s', (code, status, publicCode) => {
    expect(classifyHttpError(new AuthenticationError(code))).toEqual({ status, code: publicCode });
  });
});

describe('password login orchestration', () => {
  it('fails closed when disabled', async () => {
    await expect(new LoginService().login(input, 'source')).rejects.toThrow('UNAVAILABLE');
  });
  it('canonicalizes only the email, verifies the password exactly and projects the response', async () => {
    const f = fixture();
    const result = await f.service.login(input, 'socket-source');
    expect(f.limits.admit).toHaveBeenCalledWith('socket-source', 'alice@example.com');
    expect(f.credentials.find).toHaveBeenCalledWith('alice@example.com');
    expect(verifyPassword).toHaveBeenCalledWith(input.password, credential.verifier);
    expect(f.sessions.createAfterLogin.mock.calls[0]?.[0]).toBeInstanceOf(VerifiedLogin);
    expect(result).toEqual({
      sessionToken: 'only-response-token',
      session: {
        sessionId: 'session',
        accountId: 'account',
        deviceId: 'device',
        deviceState: 'pending',
        expiresAt: new Date(1000).toISOString(),
      },
    });
    expect(f.release).toHaveBeenCalledOnce();
  });
  it.each([null, { ...credential, verifier: 'invalid PHC' }])(
    'uses one dummy computation and can never authenticate unusable credentials %#',
    async (value) => {
      fixture();
      expect(await VerifiedLogin.verify('public dummy login verifier v1', value)).toBeUndefined();
      expect(verifyPassword).toHaveBeenCalledExactlyOnceWith(
        'public dummy login verifier v1',
        dummyLoginVerifier,
      );
    },
  );
  it('freezes the exact credential before awaiting the native comparison', async () => {
    fixture();
    const mutable = { ...credential };
    vi.mocked(verifyPassword).mockImplementationOnce(async () => {
      mutable.verifier = 'changed after computation started';
      mutable.revision = 2n;
      return true;
    });
    const verified = await VerifiedLogin.verify(input.password, mutable);
    expect(verified?.credential).toEqual(credential);
    expect(Object.isFrozen(verified?.credential)).toBe(true);
  });
  it('never creates a session after a wrong password and releases admission', async () => {
    const f = fixture();
    vi.mocked(verifyPassword).mockResolvedValue(false);
    await expect(f.service.login(input, 'source')).rejects.toThrow('INVALID_CREDENTIALS');
    expect(f.sessions.createAfterLogin).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it.each([
    ['BUSY', 'BUSY'],
    ['CRYPTO_UNAVAILABLE', 'CRYPTO_UNAVAILABLE'],
  ] as const)('sanitizes Argon2id %s', async (code, expected) => {
    const f = fixture();
    vi.mocked(verifyPassword).mockRejectedValue(new PasswordVerifierError(code));
    await expect(f.service.login(input, 'source')).rejects.toThrow(expected);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.sessions.createAfterLogin).not.toHaveBeenCalled();
  });
  it('denies quotas before any identity lookup or native calculation', async () => {
    const f = fixture();
    f.limits.admit.mockRejectedValue(new AuthenticationError('RATE_LIMITED'));
    await expect(f.service.login(input, 'source')).rejects.toThrow('RATE_LIMITED');
    expect(f.credentials.find).not.toHaveBeenCalled();
    expect(verifyPassword).not.toHaveBeenCalled();
  });
  it('sanitizes a database read failure and releases its lease', async () => {
    const f = fixture();
    f.credentials.find.mockRejectedValue(new Error('private database data'));
    await expect(f.service.login(input, 'source')).rejects.toThrow('UNAVAILABLE');
    expect(f.release).toHaveBeenCalledOnce();
  });
  it('preserves an unknown commit outcome without inventing a token', async () => {
    const f = fixture();
    f.sessions.createAfterLogin.mockRejectedValue(new SessionError('OUTCOME_UNKNOWN'));
    await expect(f.service.login(input, 'source')).rejects.toThrow('OUTCOME_UNKNOWN');
    expect(f.release).toHaveBeenCalledOnce();
  });
  it('keeps the controller narrow, rejects privileges and uses the socket source', async () => {
    const f = fixture();
    const controller = new LoginController(f.service);
    const request = { socket: { remoteAddress: 'socket' } } as Parameters<
      LoginController['login']
    >[1];
    await controller.login(input, request);
    expect(f.limits.admit).toHaveBeenCalledWith('socket', 'alice@example.com');
    for (const extra of [
      { deviceId: 'chosen' },
      { credential },
      { verified: { credential } },
      { verifier: credential.verifier },
    ])
      await expect(controller.login({ ...input, ...extra }, request)).rejects.toThrow();
    expect(f.sessions.createAfterLogin).toHaveBeenCalledOnce();
  });
});
