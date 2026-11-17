import { Buffer } from 'node:buffer';

export interface LoginConfig {
  readonly hmacKey: Uint8Array;
  readonly windowMs: number;
  readonly leaseMs: number;
  readonly requestsGlobally: number;
  readonly requestsPerSource: number;
  readonly requestsPerEmail: number;
  readonly hashesPerWindow: number;
  readonly concurrency: number;
  readonly maximumRecordsPerAccount: number;
}

export function readLoginConfig(
  env: Readonly<Record<string, string | undefined>>,
): LoginConfig | undefined {
  const fail = (): never => {
    throw new Error('Invalid login configuration');
  };
  if (env.LOGIN_ENABLED === undefined || env.LOGIN_ENABLED === 'false') return;
  if (env.LOGIN_ENABLED !== 'true' || env.NODE_ENV === 'production') fail();
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const text = env[name] ?? String(fallback);
    if (!/^[1-9][0-9]*$/.test(text)) return fail();
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < min || value > max) return fail();
    return value;
  };
  const key = env.LOGIN_HMAC_KEY ?? '';
  if (!/^[a-f0-9]{64}$/.test(key) || key === env.REGISTRATION_HMAC_KEY) fail();
  return {
    hmacKey: Buffer.from(key, 'hex'),
    windowMs: integer('LOGIN_WINDOW_MS', 60000, 1000, 3600000),
    leaseMs: integer('LOGIN_LEASE_MS', 60000, 10000, 120000),
    requestsGlobally: integer('LOGIN_REQUESTS_GLOBALLY', 300, 1, 10000),
    requestsPerSource: integer('LOGIN_REQUESTS_PER_SOURCE', 20, 1, 1000),
    requestsPerEmail: integer('LOGIN_REQUESTS_PER_EMAIL', 10, 1, 100),
    hashesPerWindow: integer('LOGIN_HASHES_PER_WINDOW', 30, 1, 120),
    concurrency: integer('LOGIN_CONCURRENCY', 2, 1, 2),
    maximumRecordsPerAccount: integer('LOGIN_MAXIMUM_RECORDS_PER_ACCOUNT', 1000, 10, 10000),
  };
}
