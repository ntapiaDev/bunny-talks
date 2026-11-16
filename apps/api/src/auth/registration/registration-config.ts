import { Buffer } from 'node:buffer';
import { isIP } from 'node:net';
import { loginEmailSchema } from '@bunny-talks/validation';

export interface RegistrationConfig {
  readonly smtp: {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly user: string;
    readonly password: string;
    readonly from: string;
    readonly timeoutMs: number;
  };
  readonly hmacKey: Uint8Array;
  readonly requestFloorMs: number;
  readonly limits: {
    readonly requestsPerSource: number;
    readonly requestsGlobally: number;
    readonly sendsPerEmail: number;
    readonly cooldownMs: number;
    readonly completionsPerSource: number;
    readonly attemptsPerProof: number;
    readonly hashesPerMinute: number;
    readonly concurrentRequests: number;
    readonly concurrentCompletions: number;
  };
}

/** Configuration is opt-in; missing credentials never enable a simulated delivery mode. */
export function readRegistrationConfig(
  env: Readonly<Record<string, string | undefined>>,
): RegistrationConfig | undefined {
  const fail = (): never => {
    throw new Error('Invalid registration configuration');
  };
  if (env.REGISTRATION_ENABLED === undefined || env.REGISTRATION_ENABLED === 'false') return;
  if (env.REGISTRATION_ENABLED !== 'true') fail();
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const value = env[name] ?? String(fallback);
    if (!/^[1-9][0-9]*$/.test(value)) return fail();
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) return fail();
    return number;
  };
  const host = env.REGISTRATION_SMTP_HOST ?? '';
  if (
    !host ||
    host.length > 253 ||
    /[\s/:@]/.test(host) ||
    (!isIP(host) && !/^[a-zA-Z0-9.-]+$/.test(host))
  )
    fail();
  const user = env.REGISTRATION_SMTP_USER ?? '';
  const password = env.REGISTRATION_SMTP_PASSWORD ?? '';
  if (
    !user ||
    !password ||
    user.length > 256 ||
    password.length > 1024 ||
    /[\r\n]/.test(user + password) ||
    (user + password).includes('\0')
  )
    fail();
  const from = env.REGISTRATION_SMTP_FROM ?? '';
  if (!loginEmailSchema.safeParse(from).success) fail();
  const secure = env.REGISTRATION_SMTP_SECURE ?? 'true';
  if (!['true', 'false'].includes(secure)) fail();
  const key = env.REGISTRATION_HMAC_KEY ?? '';
  if (!/^[a-f0-9]{64}$/.test(key)) fail();
  const timeoutMs = integer('REGISTRATION_SMTP_TIMEOUT_MS', 2000, 500, 3000);
  return {
    smtp: {
      host,
      port: integer('REGISTRATION_SMTP_PORT', 465, 1, 65535),
      secure: secure === 'true',
      user,
      password,
      from,
      timeoutMs,
    },
    hmacKey: Buffer.from(key, 'hex'),
    // Includes two bounded SMTP operations and the bounded admission transaction.
    requestFloorMs: 2 * timeoutMs + 2000,
    limits: {
      requestsPerSource: integer('REGISTRATION_REQUESTS_PER_SOURCE', 10, 1, 100),
      requestsGlobally: integer('REGISTRATION_REQUESTS_GLOBALLY', 300, 1, 10000),
      sendsPerEmail: integer('REGISTRATION_SENDS_PER_EMAIL', 3, 1, 10),
      cooldownMs: integer('REGISTRATION_COOLDOWN_MS', 60000, 60000, 1800000),
      completionsPerSource: integer('REGISTRATION_COMPLETIONS_PER_SOURCE', 20, 1, 100),
      attemptsPerProof: integer('REGISTRATION_ATTEMPTS_PER_PROOF', 10, 1, 100),
      hashesPerMinute: integer('REGISTRATION_HASHES_PER_MINUTE', 20, 1, 120),
      concurrentRequests: integer('REGISTRATION_CONCURRENT_REQUESTS', 16, 1, 64),
      concurrentCompletions: integer('REGISTRATION_CONCURRENT_COMPLETIONS', 2, 1, 2),
    },
  };
}
