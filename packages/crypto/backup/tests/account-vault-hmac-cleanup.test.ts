import { randomFillSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type * as HmacModule from '@noble/hashes/hmac.js';
import canonicalize from 'canonicalize';
import { beforeEach, expect, it, vi } from 'vitest';
import { openAccountVaultWithRecoveryKey, rewrapAccountVaultPassword } from '../src/index.js';

const observed = vi.hoisted(() => ({
  keys: [] as Uint8Array[],
  macs: [] as Uint8Array[],
  fail: false,
  failAt: 0,
  nonzero: [] as boolean[],
}));
vi.mock('@noble/hashes/hmac.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HmacModule>();
  const instrumented: typeof actual.hmac = Object.assign(
    (...args: Parameters<typeof actual.hmac>) => {
      const key = args[1];
      if (!(key instanceof Uint8Array)) throw new Error('unexpected key type');
      observed.keys.push(key);
      if (observed.fail || observed.keys.length === observed.failAt)
        throw new Error('private HMAC provider detail');
      const mac = actual.hmac(...args);
      observed.macs.push(mac);
      observed.nonzero.push(mac.some((byte) => byte !== 0));
      return mac;
    },
    { create: actual.hmac.create },
  );
  return { ...actual, hmac: instrumented };
});
const vector = JSON.parse(
  readFileSync(new URL('./fixtures/account-vault-v1.json', import.meta.url), 'utf8'),
);
const input = new TextEncoder().encode(vector.publication);
const key = Uint8Array.from(Buffer.from(vector.recoveryKey, 'hex'));
const random = {
  async fill(buffer: Uint8Array) {
    randomFillSync(buffer);
  },
};
function expectWiped() {
  expect(observed.keys.length).toBeGreaterThan(0);
  expect(observed.nonzero.every(Boolean)).toBe(true);
  for (const buffer of [...observed.keys, ...observed.macs])
    expect(buffer).toEqual(new Uint8Array(32));
}
beforeEach(() => {
  observed.keys = [];
  observed.macs = [];
  observed.fail = false;
  observed.failAt = 0;
  observed.nonzero = [];
});

it('wipes the actual derived HMAC key and result after successful verification', async () => {
  const result = await openAccountVaultWithRecoveryKey(input, key, vector.context);
  expect(result.ok).toBe(true);
  expect(observed.macs).toHaveLength(1);
  expectWiped();
});
it('wipes the actual MAC and key after a failed comparison', async () => {
  const altered = JSON.parse(vector.publication);
  altered.manifest.mac = 'A'.repeat(43);
  const result = await openAccountVaultWithRecoveryKey(
    new TextEncoder().encode(canonicalize(altered)!),
    key,
    vector.context,
  );
  expect(result).toEqual({ ok: false, code: 'AUTHENTICATION_FAILED' });
  expect(observed.macs).toHaveLength(1);
  expectWiped();
});
it('wipes the derived key if the HMAC provider throws', async () => {
  observed.fail = true;
  const result = await openAccountVaultWithRecoveryKey(input, key, vector.context);
  expect(result).toEqual({ ok: false, code: 'CRYPTO_UNAVAILABLE' });
  expect(observed.macs).toHaveLength(0);
  expectWiped();
});
it('wipes MACs after signing and verifying without corrupting the publication', async () => {
  const result = await rewrapAccountVaultPassword(
    input,
    vector.context,
    { type: 'recovery', recoveryKey: key },
    'new password',
    random,
  );
  expect(observed.macs.length).toBeGreaterThanOrEqual(3);
  expectWiped();
  expect((await openAccountVaultWithRecoveryKey(result, key, vector.context)).ok).toBe(true);
  expectWiped();
}, 30000);

it('wipes the derived key when signing fails after authenticating the old publication', async () => {
  observed.failAt = 2;
  await expect(
    rewrapAccountVaultPassword(
      input,
      vector.context,
      { type: 'recovery', recoveryKey: key },
      'new password',
      random,
    ),
  ).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE', message: 'CRYPTO_UNAVAILABLE' });
  expect(observed.keys).toHaveLength(2);
  expect(observed.macs).toHaveLength(1);
  expectWiped();
}, 30000);
