import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { PasswordVerifierError } from '../../../src/auth/password-verifier.js';
import type {
  PostgresEmailRegistration,
  RegistrationEmailTransport,
} from '../../../src/auth/registration/postgres-email-registration.js';
import type { PostgresRegistrationLimits } from '../../../src/auth/registration/postgres-registration-limits.js';
import { readRegistrationConfig } from '../../../src/auth/registration/registration-config.js';
import { RegistrationHttpService } from '../../../src/auth/registration/registration-http.service.js';
import { RegistrationError } from '../../../src/auth/registration/registration-policy.js';
import { classifyHttpError } from '../../../src/shared/http/http-error-filter.js';

const env = {
  REGISTRATION_ENABLED: 'true',
  REGISTRATION_SMTP_HOST: 'smtp.example.com',
  REGISTRATION_SMTP_USER: 'fixture-user',
  REGISTRATION_SMTP_PASSWORD: 'fixture-only-secret',
  REGISTRATION_SMTP_FROM: 'security@example.com',
  REGISTRATION_HMAC_KEY: 'a'.repeat(64),
};

describe('registration configuration and public error contract', () => {
  it('remains explicitly disabled without opt-in', () => {
    expect(readRegistrationConfig({})).toBeUndefined();
    expect(readRegistrationConfig({ REGISTRATION_ENABLED: 'false' })).toBeUndefined();
  });
  it('uses TLS and bounded multi-instance budgets by default', () => {
    const config = readRegistrationConfig(env)!;
    expect(config.smtp).toMatchObject({ secure: true, port: 465, timeoutMs: 2000 });
    expect(config.requestFloorMs).toBe(6000);
    expect(Buffer.from(config.hmacKey).length).toBe(32);
    expect(config.limits.concurrentCompletions).toBe(2);
  });
  it.each([
    { REGISTRATION_ENABLED: 'yes' },
    { REGISTRATION_SMTP_HOST: '' },
    { REGISTRATION_SMTP_HOST: 'smtp://host' },
    { REGISTRATION_SMTP_HOST: 'host\n' },
    { REGISTRATION_SMTP_PASSWORD: '' },
    { REGISTRATION_SMTP_USER: 'user\r\n' },
    { REGISTRATION_SMTP_FROM: 'sender@example.com\r\nBcc: other@example.com' },
    { REGISTRATION_SMTP_SECURE: 'no' },
    { REGISTRATION_HMAC_KEY: 'secret' },
    { REGISTRATION_SMTP_PORT: '0' },
    { REGISTRATION_SMTP_PORT: '65536' },
    { REGISTRATION_REQUESTS_PER_SOURCE: '0' },
    { REGISTRATION_COOLDOWN_MS: '59999' },
    { REGISTRATION_CONCURRENT_COMPLETIONS: '3' },
  ])('rejects invalid configuration without reflecting credentials %#', (override) => {
    expect(() => readRegistrationConfig({ ...env, ...override })).toThrow(
      'Invalid registration configuration',
    );
  });
  it.each([
    ['INVALID_REQUEST', 400, 'BAD_REQUEST'],
    ['INVALID_EMAIL', 400, 'BAD_REQUEST'],
    ['INVALID_PROOF', 400, 'INVALID_VERIFICATION'],
    ['EMAIL_UNAVAILABLE', 400, 'INVALID_VERIFICATION'],
    ['INVALID_PASSWORD', 422, 'PASSWORD_REJECTED'],
    ['BLOCKED_PASSWORD', 422, 'PASSWORD_REJECTED'],
    ['RATE_LIMITED', 429, 'TOO_MANY_REQUESTS'],
    ['DELIVERY_UNAVAILABLE', 503, 'DELIVERY_UNAVAILABLE'],
    ['POLICY_UNAVAILABLE', 503, 'PASSWORD_CHECK_UNAVAILABLE'],
    ['OUTCOME_UNKNOWN', 503, 'OUTCOME_UNKNOWN'],
    ['UNAVAILABLE', 503, 'SERVICE_UNAVAILABLE'],
  ] as const)(
    'maps internal %s without exposing implementation errors',
    (code, status, publicCode) => {
      expect(classifyHttpError(new RegistrationError(code))).toEqual({ status, code: publicCode });
    },
  );
  it.each([
    ['BUSY', 429, 'TOO_MANY_REQUESTS'],
    ['INVALID_PASSWORD', 422, 'PASSWORD_REJECTED'],
    ['INVALID_VERIFIER', 503, 'SERVICE_UNAVAILABLE'],
    ['CRYPTO_UNAVAILABLE', 503, 'SERVICE_UNAVAILABLE'],
  ] as const)('sanitizes password verifier %s', (code, status, publicCode) => {
    expect(classifyHttpError(new PasswordVerifierError(code))).toEqual({
      status,
      code: publicCode,
    });
  });
});

describe('narrow anonymous registration capability', () => {
  function fixture() {
    const config = { ...readRegistrationConfig(env)!, requestFloorMs: 1 };
    const release = vi.fn(async () => undefined);
    const limits = {
      source: vi.fn(async () => undefined),
      acquire: vi.fn(async () => release),
      cleanup: vi.fn(async () => undefined),
    } as unknown as PostgresRegistrationLimits;
    const transport: RegistrationEmailTransport = {
      checkAvailability: vi.fn(async () => undefined),
      submitVerification: vi.fn(async () => undefined),
    };
    const registration = {
      requestVerification: vi.fn(async () => ({ status: 'verification-requested' })),
      finalize: vi.fn(async () => ({ status: 'account-created', accountId: 'private-account' })),
    } as unknown as PostgresEmailRegistration;
    return {
      service: new RegistrationHttpService({ config, registration, transport, limits }),
      registration,
      transport,
      limits,
      release,
    };
  }
  it('fails closed when registration is disabled', async () => {
    await expect(
      new RegistrationHttpService().request({ email: 'a@example.com' }, 'source'),
    ).rejects.toThrow('UNAVAILABLE');
  });
  it('projects only the stable completion acknowledgement', async () => {
    const f = fixture();
    expect(
      await f.service.complete(
        { email: 'a@example.com', token: 'invalid', password: 'long enough password' },
        'source',
      ),
    ).toEqual({ status: 'account-created' });
    expect(f.release).toHaveBeenCalledOnce();
  });
  it('checks global delivery readiness before considering the email identity', async () => {
    const f = fixture();
    vi.mocked(f.transport.checkAvailability!).mockRejectedValue(
      new RegistrationError('DELIVERY_UNAVAILABLE'),
    );
    await expect(f.service.request({ email: 'a@example.com' }, 'source')).rejects.toThrow(
      'DELIVERY_UNAVAILABLE',
    );
    expect(f.registration.requestVerification).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it('acknowledges durable admission after uncertain SMTP without claiming delivery', async () => {
    const f = fixture();
    vi.mocked(f.registration.requestVerification).mockRejectedValue(
      new RegistrationError('DELIVERY_UNAVAILABLE'),
    );
    expect(await f.service.request({ email: 'a@example.com' }, 'source')).toEqual({
      status: 'accepted',
    });
  });
  it('preserves an uncertain database result and always releases admission', async () => {
    const f = fixture();
    vi.mocked(f.registration.requestVerification).mockRejectedValue(
      new RegistrationError('OUTCOME_UNKNOWN'),
    );
    await expect(f.service.request({ email: 'a@example.com' }, 'source')).rejects.toThrow(
      'OUTCOME_UNKNOWN',
    );
    expect(f.release).toHaveBeenCalledOnce();
  });
});
