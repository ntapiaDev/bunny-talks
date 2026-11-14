import { randomFillSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Argon2idProvider } from '../src/index.js';
import {
  ARGON2ID_V1,
  createAccountVault,
  nobleArgon2idProvider,
  openAccountVaultWithPassword,
  openAccountVaultWithRecoveryKey,
  rewrapAccountVaultPassword,
} from '../src/index.js';
import vector from './fixtures/account-vault-v1.json' with { type: 'json' };
import nativeVector from './fixtures/native-vault-v1.json' with { type: 'json' };
const encoder = new TextEncoder();
const context = { account: 'native-vault-diagnostic', vaultId: 'AAECAwQFBgcICQoLDA0ODw' };
const recovery = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const password = 'public native vault password';
describe('explicit Argon2 injection', () => {
  it('routes creation, both rewrap paths and their internal checks through one provider', async () => {
    let calls = 0;
    const provider: Argon2idProvider = {
      async derive(p, s, params) {
        calls++;
        expect(params).toEqual(ARGON2ID_V1);
        return nobleArgon2idProvider.derive(p, s, params);
      },
    };
    let counter = 0;
    const random = {
      async fill(b: Uint8Array) {
        for (let i = 0; i < b.length; i++) b[i] = counter++ % 256;
      },
    };
    const publication = await createAccountVault(
      context,
      password,
      recovery,
      encoder.encode('public native vault payload'),
      random,
      provider,
    );
    expect(calls).toBe(2);
    expect(new TextDecoder().decode(publication)).toBe(nativeVector.publication);
    const opened = await openAccountVaultWithPassword(publication, password, context, provider);
    expect(opened.ok).toBe(true);
    if (opened.ok) opened.plaintext.fill(0);
    expect(calls).toBe(3);
    const next = await rewrapAccountVaultPassword(
      publication,
      context,
      { type: 'password', password },
      password + '2',
      random,
      provider,
    );
    expect(calls).toBe(6);
    const final = await rewrapAccountVaultPassword(
      next,
      context,
      { type: 'recovery', recoveryKey: recovery },
      password + '3',
      random,
      provider,
    );
    expect(calls).toBe(8);
    const before = JSON.parse(new TextDecoder().decode(publication));
    const after = JSON.parse(new TextDecoder().decode(final));
    expect(after.content).toBe(before.content);
    expect(after.recoveryEnvelope).toBe(before.recoveryEnvelope);
    const restored = await openAccountVaultWithRecoveryKey(final, recovery, context);
    expect(restored.ok).toBe(true);
    if (restored.ok) restored.plaintext.fill(0);
  }, 120000);
  it('returns no rewrapped candidate on a failed internal verification and preserves its input', async () => {
    const random = {
      async fill(bytes: Uint8Array) {
        randomFillSync(bytes);
      },
    };
    const fixed: Argon2idProvider = {
      async derive() {
        return new Uint8Array(32);
      },
    };
    const publication = await createAccountVault(
      context,
      password,
      recovery,
      new Uint8Array(1),
      random,
      fixed,
    );
    const before = publication.slice();
    let calls = 0;
    const failing: Argon2idProvider = {
      async derive() {
        if (++calls === 3) throw new Error('native allocation failure');
        return new Uint8Array(32);
      },
    };
    await expect(
      rewrapAccountVaultPassword(
        publication,
        context,
        { type: 'password', password },
        password + '2',
        random,
        failing,
      ),
    ).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE' });
    expect(calls).toBe(3);
    expect(publication).toEqual(before);
  });
  it('fails closed if the injected provider fails during creation self-check; never returns a publication', async () => {
    let calls = 0;
    const provider: Argon2idProvider = {
      async derive() {
        if (++calls === 2) throw new Error('secret detail');
        return new Uint8Array(32);
      },
    };
    await expect(
      createAccountVault(
        context,
        password,
        recovery,
        new Uint8Array(1),
        {
          async fill(b) {
            randomFillSync(b);
          },
        },
        provider,
      ),
    ).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE' });
    expect(calls).toBe(2);
    const failed = await openAccountVaultWithPassword(
      encoder.encode(vector.publication),
      vector.password,
      vector.context,
      {
        async derive() {
          return new Uint8Array(31);
        },
      },
    );
    expect(failed).toEqual({ ok: false, code: 'CRYPTO_UNAVAILABLE' });
  });
});
