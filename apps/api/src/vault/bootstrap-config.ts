import { Buffer } from 'node:buffer';
import { createSecretKey } from 'node:crypto';
import type { VaultFingerprintKeys } from './vault-request-fingerprint.js';

export interface BootstrapConfig {
  readonly keys: VaultFingerprintKeys;
  readonly quotaKey: Uint8Array;
  readonly windowMs: number;
  readonly leaseMs: number;
  readonly requestsGlobally: number;
  readonly requestsPerSource: number;
  readonly requestsPerAccount: number;
  readonly requestsPerDevice: number;
  readonly hashesPerWindow: number;
  readonly concurrency: number;
}

/** Stable keyring is supplied by deployment; never generate receipt keys at startup. */
export function readBootstrapConfig(
  env: Readonly<Record<string, string | undefined>>,
): BootstrapConfig | undefined {
  const fail = (): never => {
    throw new Error('Invalid vault bootstrap configuration');
  };
  if (env.VAULT_BOOTSTRAP_ENABLED === undefined || env.VAULT_BOOTSTRAP_ENABLED === 'false') return;
  if (env.VAULT_BOOTSTRAP_ENABLED !== 'true' || env.NODE_ENV === 'production') fail();
  const quota = env.VAULT_BOOTSTRAP_QUOTA_KEY ?? '';
  const activeKeyId = env.VAULT_RECEIPT_ACTIVE_KEY_ID ?? '';
  if (
    !/^[a-f0-9]{64}$/.test(quota) ||
    [env.LOGIN_HMAC_KEY, env.REGISTRATION_HMAC_KEY].includes(quota)
  )
    fail();
  const keys = new Map<string, ReturnType<typeof createSecretKey>>();
  try {
    const entries: unknown = JSON.parse(env.VAULT_RECEIPT_KEYS ?? '');
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 32) fail();
    for (const entry of entries as unknown[]) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail();
      const item = entry as Record<string, unknown>;
      if (
        Object.keys(item).sort().join(',') !== 'id,key' ||
        typeof item.id !== 'string' ||
        !/^[!-~]{1,128}$/.test(item.id) ||
        typeof item.key !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.key) ||
        keys.has(item.id) ||
        [quota, env.LOGIN_HMAC_KEY, env.REGISTRATION_HMAC_KEY].includes(item.key)
      )
        fail();
      keys.set(item.id as string, createSecretKey(Buffer.from(item.key as string, 'hex')));
    }
    if (!keys.has(activeKeyId)) fail();
  } catch {
    fail();
  }
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const text = env[name] ?? String(fallback);
    const value = Number(text);
    if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max)
      return fail();
    return value;
  };
  return {
    keys: { activeKeyId, getKey: (id) => keys.get(id) },
    quotaKey: Buffer.from(quota, 'hex'),
    windowMs: integer('VAULT_BOOTSTRAP_WINDOW_MS', 60000, 1000, 3600000),
    leaseMs: integer('VAULT_BOOTSTRAP_LEASE_MS', 60000, 10000, 120000),
    requestsGlobally: integer('VAULT_BOOTSTRAP_REQUESTS_GLOBALLY', 120, 1, 10000),
    requestsPerSource: integer('VAULT_BOOTSTRAP_REQUESTS_PER_SOURCE', 20, 1, 1000),
    requestsPerAccount: integer('VAULT_BOOTSTRAP_REQUESTS_PER_ACCOUNT', 10, 1, 100),
    requestsPerDevice: integer('VAULT_BOOTSTRAP_REQUESTS_PER_DEVICE', 10, 1, 100),
    hashesPerWindow: integer('VAULT_BOOTSTRAP_HASHES_PER_WINDOW', 20, 1, 120),
    concurrency: integer('VAULT_BOOTSTRAP_CONCURRENCY', 2, 1, 2),
  };
}
