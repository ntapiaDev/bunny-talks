import { createHmac, hkdfSync, randomFillSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import canonicalize from 'canonicalize';
import { describe, expect, it } from 'vitest';
import {
  createAccountVault,
  createRecoveryKeyEnvelope,
  openAccountVaultWithPassword,
  openAccountVaultWithRecoveryKey,
  rewrapAccountVaultPassword,
  validateAccountVault,
} from '../src/index.js';

const vector = JSON.parse(
  readFileSync(new URL('./fixtures/account-vault-v1.json', import.meta.url), 'utf8'),
) as {
  context: { account: string; vaultId: string };
  password: string;
  recoveryKey: string;
  masterKey: string;
  plaintext: string;
  publication: string;
};
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const encoded = (value: unknown) => new TextEncoder().encode(canonicalize(value)!);
const original = new TextEncoder().encode(vector.publication);
const recovery = bytes(vector.recoveryKey);
const random = {
  async fill(buffer: Uint8Array) {
    randomFillSync(buffer);
  },
};
// These objects contain only the public deterministic fixture, never user data.
const publication = () => JSON.parse(vector.publication);
const change = (mutate: (value: ReturnType<typeof publication>) => void) => {
  const value = publication();
  mutate(value);
  return encoded(value);
};
function resign(value: ReturnType<typeof publication>): Uint8Array {
  const body = {
    ...value,
    manifest: { version: value.manifest.version, generation: value.manifest.generation },
  };
  const key = hkdfSync(
    'sha256',
    bytes(vector.masterKey),
    Buffer.from(vector.context.vaultId, 'base64url'),
    'bunny-talks/account-vault/v1/manifest-key',
    32,
  );
  value.manifest.mac = createHmac('sha256', Buffer.from(key))
    .update('bunny-talks/account-vault/v1/manifest\n' + canonicalize(body))
    .digest('base64url');
  return encoded(value);
}

describe('authenticated account vault V1', () => {
  it('matches the independent full-publication vector and opens through both access paths', async () => {
    let offset = 0;
    const created = await createAccountVault(
      vector.context,
      vector.password,
      recovery,
      bytes(vector.plaintext),
      {
        async fill(buffer) {
          for (let i = 0; i < buffer.length; i++) buffer[i] = offset++;
        },
      },
    );
    expect(created).toEqual(original);
    expect(validateAccountVault(created, vector.context)).toEqual({
      ok: true,
      status: 'structural-only-unauthenticated',
      revisions: { generation: 1, contentRevision: 1, passwordRevision: 1, recoveryRevision: 1 },
    });
    for (const opened of [
      await openAccountVaultWithPassword(created, vector.password, vector.context),
      await openAccountVaultWithRecoveryKey(created, recovery, vector.context),
    ]) {
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        expect(opened.plaintext).toEqual(bytes(vector.plaintext));
        expect(Object.keys(opened).sort()).toEqual(['ok', 'plaintext', 'revisions']);
      }
    }
  }, 30000);
  it('rewraps without a recovery key, preserving the ciphertext and recovery envelope exactly', async () => {
    const before = original.slice();
    const next = await rewrapAccountVaultPassword(
      original,
      vector.context,
      { type: 'password', password: vector.password },
      'new password',
      random,
    );
    const old = publication();
    const updated = JSON.parse(new TextDecoder().decode(next));
    expect(updated.content).toBe(old.content);
    expect(updated.recoveryEnvelope).toBe(old.recoveryEnvelope);
    expect(updated.header).toEqual(old.header);
    expect(updated.manifest.generation).toBe(2);
    expect(JSON.parse(updated.passwordEnvelope).header.revision).toBe(2);
    expect(JSON.parse(updated.passwordEnvelope).header.salt).not.toBe(
      JSON.parse(old.passwordEnvelope).header.salt,
    );
    expect(JSON.parse(updated.passwordEnvelope).header.nonce).not.toBe(
      JSON.parse(old.passwordEnvelope).header.nonce,
    );
    expect(original).toEqual(before);
    expect((await openAccountVaultWithPassword(next, 'new password', vector.context)).ok).toBe(
      true,
    );
    expect((await openAccountVaultWithRecoveryKey(next, recovery, vector.context)).ok).toBe(true);
    expect(await openAccountVaultWithPassword(next, vector.password, vector.context)).toEqual({
      ok: false,
      code: 'AUTHENTICATION_FAILED',
    });
    // A whole old publication is still authentic, including its old password path.
    expect((await openAccountVaultWithPassword(original, vector.password, vector.context)).ok).toBe(
      true,
    );
    for (const mixed of [
      { ...updated, passwordEnvelope: old.passwordEnvelope },
      { ...old, passwordEnvelope: updated.passwordEnvelope },
    ]) {
      expect(
        (await openAccountVaultWithRecoveryKey(encoded(mixed), recovery, vector.context)).ok,
      ).toBe(false);
    }
  }, 30000);
  it('sets a new password through recovery access and authenticates errors before returning a publication', async () => {
    const next = await rewrapAccountVaultPassword(
      original,
      vector.context,
      { type: 'recovery', recoveryKey: recovery },
      'recovered password',
      random,
    );
    expect(
      (await openAccountVaultWithPassword(next, 'recovered password', vector.context)).ok,
    ).toBe(true);
    expect((await openAccountVaultWithRecoveryKey(next, recovery, vector.context)).ok).toBe(true);
    await expect(
      rewrapAccountVaultPassword(
        original,
        vector.context,
        { type: 'password', password: 'wrong' },
        'new',
        random,
      ),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED', message: 'AUTHENTICATION_FAILED' });
    expect(await openAccountVaultWithPassword(original, 'wrong', vector.context)).toEqual({
      ok: false,
      code: 'AUTHENTICATION_FAILED',
    });
    expect(
      await openAccountVaultWithRecoveryKey(original, new Uint8Array(32), vector.context),
    ).toEqual({ ok: false, code: 'AUTHENTICATION_FAILED' });
  }, 30000);
  it('rejects substitutions and every changed publication component without plaintext', async () => {
    const attacks = [
      change((v) => {
        v.header.account = 'other';
      }),
      change((v) => {
        v.header.vaultId = 'AAAAAAAAAAAAAAAAAAAAAA';
      }),
      change((v) => {
        v.header.suite = 'other';
      }),
      change((v) => {
        v.header.version = 2;
      }),
      change((v) => {
        v.manifest.generation = 2;
      }),
      change((v) => {
        v.manifest.version = 2;
      }),
      change((v) => {
        v.manifest.mac = 'A'.repeat(43);
      }),
      change((v) => {
        v.manifest.extra = true;
      }),
      ...['version', 'revision', 'nonce', 'ciphertext'].map((field) =>
        change((v) => {
          const content = JSON.parse(v.content);
          content[field] =
            field === 'version' || field === 'revision'
              ? 2
              : field === 'nonce'
                ? 'A'.repeat(32)
                : 'A'.repeat(48);
          v.content = canonicalize(content);
        }),
      ),
      ...['passwordEnvelope', 'recoveryEnvelope'].flatMap((slot) =>
        ['account', 'vaultId', 'revision', 'profile', 'nonce'].map((field) =>
          change((v) => {
            const envelope = JSON.parse(v[slot]);
            envelope.header[field] =
              field === 'revision'
                ? 2
                : field === 'nonce'
                  ? 'A'.repeat(32)
                  : field === 'vaultId'
                    ? 'AAAAAAAAAAAAAAAAAAAAAA'
                    : 'other';
            v[slot] = canonicalize(envelope);
          }),
        ),
      ),
      change((v) => {
        const p = v.passwordEnvelope;
        v.passwordEnvelope = v.recoveryEnvelope;
        v.recoveryEnvelope = p;
      }),
    ];
    for (const input of attacks) {
      const result = await openAccountVaultWithRecoveryKey(input, recovery, vector.context);
      expect(result.ok).toBe(false);
      expect(Object.keys(result).sort()).toEqual(['code', 'ok']);
    }
    expect(
      (
        await openAccountVaultWithRecoveryKey(original, recovery, {
          ...vector.context,
          account: 'other',
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await openAccountVaultWithRecoveryKey(original, recovery, {
          ...vector.context,
          vaultId: 'AAAAAAAAAAAAAAAAAAAAAA',
        })
      ).ok,
    ).toBe(false);
  });
  it('requires content AEAD authentication even with a correctly signed manifest', async () => {
    for (const offset of [0, -1]) {
      const v = publication();
      const content = JSON.parse(v.content);
      const encrypted = Buffer.from(content.ciphertext, 'base64url');
      const index = offset === -1 ? encrypted.length - 1 : offset;
      encrypted[index] = encrypted[index]! ^ 1;
      content.ciphertext = encrypted.toString('base64url');
      v.content = canonicalize(content);
      expect(await openAccountVaultWithRecoveryKey(resign(v), recovery, vector.context)).toEqual({
        ok: false,
        code: 'AUTHENTICATION_FAILED',
      });
    }
  });
  it('distinguishes authenticated inclusion of an alternate envelope from its operational validity', async () => {
    const v = publication();
    const other = await createRecoveryKeyEnvelope(
      new Uint8Array(32).fill(99),
      recovery,
      { ...vector.context, revision: 1 },
      random,
    );
    v.recoveryEnvelope = new TextDecoder().decode(other);
    const signed = resign(v);
    expect((await openAccountVaultWithPassword(signed, vector.password, vector.context)).ok).toBe(
      true,
    );
    expect(await openAccountVaultWithRecoveryKey(signed, recovery, vector.context)).toEqual({
      ok: false,
      code: 'AUTHENTICATION_FAILED',
    });
  }, 30000);
  it('rejects noncanonical documents, duplicate fields, excessive sizes and incomplete publications', () => {
    const text = vector.publication;
    for (const input of [
      new Uint8Array(131073),
      Uint8Array.of(255),
      new TextEncoder().encode('\ufeff' + text),
      new TextEncoder().encode(' ' + text),
      new TextEncoder().encode(text.replace('"content":', '"content":"x","cont\\u0065nt":')),
      encoded({}),
      change((v) => {
        delete v.recoveryEnvelope;
      }),
      change((v) => {
        v.extra = true;
      }),
      change((v) => {
        v.content = ' ' + v.content;
      }),
      change((v) => {
        v.passwordEnvelope = ' ' + v.passwordEnvelope;
      }),
      change((v) => {
        v.manifest.generation = 0;
      }),
      change((v) => {
        v.manifest.mac += '=';
      }),
      change((v) => {
        const content = JSON.parse(v.content);
        content.ciphertext = 'A'.repeat(88000);
        v.content = canonicalize(content);
      }),
      change((v) => {
        const p = JSON.parse(v.passwordEnvelope);
        p.header.memoryKiB = 2147483647;
        v.passwordEnvelope = canonicalize(p);
      }),
    ])
      expect(validateAccountVault(input, vector.context).ok).toBe(false);
  });
  it('refuses generation overflow and does not mutate inputs on interrupted operations', async () => {
    const max = publication();
    max.manifest.generation = Number.MAX_SAFE_INTEGER;
    await expect(
      rewrapAccountVaultPassword(
        resign(max),
        vector.context,
        { type: 'recovery', recoveryKey: recovery },
        'new',
        random,
      ),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const snapshot = original.slice();
    let count = 0;
    await expect(
      rewrapAccountVaultPassword(
        original,
        vector.context,
        { type: 'recovery', recoveryKey: recovery },
        'new',
        {
          async fill(buffer) {
            if (++count === 2) throw new Error('secret provider detail');
            randomFillSync(buffer);
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE', message: 'CRYPTO_UNAVAILABLE' });
    expect(original).toEqual(snapshot);
    expect(recovery).toEqual(bytes(vector.recoveryKey));
    await expect(
      createAccountVault(vector.context, vector.password, recovery, bytes(vector.plaintext), {
        async fill() {
          throw new Error('secret');
        },
      }),
    ).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE' });
    await expect(
      createAccountVault(vector.context, vector.password, recovery, new Uint8Array(65537), random),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
  it('supports the maximum payload and snapshots all caller inputs before asynchronous work', async () => {
    const payload = new Uint8Array(65536).fill(42);
    const key = recovery.slice();
    const context = { ...vector.context };
    const created = await createAccountVault(context, vector.password, key, payload, {
      async fill(buffer) {
        payload.fill(0);
        key.fill(0);
        context.account = 'changed';
        randomFillSync(buffer);
      },
    });
    const opened = await openAccountVaultWithRecoveryKey(created, recovery, vector.context);
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.plaintext).toEqual(new Uint8Array(65536).fill(42));
  }, 30000);
});
