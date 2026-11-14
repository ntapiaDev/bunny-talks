import { argon2, hkdfSync, randomFillSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import canonicalize from 'canonicalize';
import { describe, expect, it } from 'vitest';
import {
  createPasswordKeyEnvelope,
  createRecoveryKeyEnvelope,
  derivePasswordWrappingKey,
  deriveRecoveryWrappingKey,
  generateMasterKey,
  generateRecoveryKey,
  generateVaultId,
  openPasswordKeyEnvelope,
  openRecoveryKeyEnvelope,
  validatePasswordKeyEnvelope,
  validateRecoveryKeyEnvelope,
} from '../src/index.js';

const random = {
  async fill(bytes: Uint8Array) {
    randomFillSync(bytes);
  },
};
const metadata = { account: 'opaque:account-1', vaultId: 'AAAAAAAAAAAAAAAAAAAAAA', revision: 1 };
const master = new Uint8Array(32).fill(7);
const recovery = new Uint8Array(32).fill(9);
const encode = (value: unknown) => new TextEncoder().encode(canonicalize(value)!);
const parse = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
const mutate = (bytes: Uint8Array, change: (value: ReturnType<typeof parse>) => void) => {
  const value = parse(bytes);
  change(value);
  return encode(value);
};

describe('versioned master key envelopes', () => {
  it('generates independent secrets and canonical vault identifiers using the explicit source', async () => {
    const first = await generateMasterKey(random);
    const second = await generateRecoveryKey(random);
    expect(first.length).toBe(32);
    expect(second.length).toBe(32);
    expect(first).not.toEqual(second);
    expect(await generateVaultId(random)).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/);
  });
  it('opens both independent access paths to exactly the same master key', async () => {
    const password = '  Pässword 🐇  ';
    const first = await createPasswordKeyEnvelope(master, password, metadata, random);
    const second = await createRecoveryKeyEnvelope(master, recovery, metadata, random);
    expect(validatePasswordKeyEnvelope(first).ok).toBe(true);
    expect(validateRecoveryKeyEnvelope(second).ok).toBe(true);
    expect(encode(parse(first))).toEqual(first);
    expect(encode(parse(second))).toEqual(second);
    expect(await openPasswordKeyEnvelope(first, password, metadata)).toEqual({
      ok: true,
      masterKey: master,
    });
    expect(await openRecoveryKeyEnvelope(second, recovery, metadata)).toEqual({
      ok: true,
      masterKey: master,
    });
    expect(await openPasswordKeyEnvelope(first, password.trim(), metadata)).toEqual({
      ok: false,
      code: 'AUTHENTICATION_FAILED',
    });
    expect(await openRecoveryKeyEnvelope(second, new Uint8Array(32), metadata)).toEqual({
      ok: false,
      code: 'AUTHENTICATION_FAILED',
    });
    expect(await openRecoveryKeyEnvelope(first, recovery, metadata)).toEqual({
      ok: false,
      code: 'INVALID_ENVELOPE',
    });
    expect(await openPasswordKeyEnvelope(second, password, metadata)).toEqual({
      ok: false,
      code: 'INVALID_ENVELOPE',
    });
    expect(master).toEqual(new Uint8Array(32).fill(7));
    expect(recovery).toEqual(new Uint8Array(32).fill(9));
  }, 30000);
  it('does not normalize Unicode or accept unpaired surrogates', async () => {
    const envelope = await createPasswordKeyEnvelope(master, 'é', metadata, random);
    expect(await openPasswordKeyEnvelope(envelope, 'e\u0301', metadata)).toEqual({
      ok: false,
      code: 'AUTHENTICATION_FAILED',
    });
    await expect(
      createPasswordKeyEnvelope(master, '\ud800', metadata, random),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }, 30000);
  it('creates new salts and nonces and snapshots caller buffers before awaiting the source', async () => {
    const first = await createRecoveryKeyEnvelope(master, recovery, metadata, random);
    const second = await createRecoveryKeyEnvelope(master, recovery, metadata, random);
    expect(parse(first).header.nonce).not.toBe(parse(second).header.nonce);
    expect(parse(first).header.salt).not.toBe(parse(second).header.salt);
    expect(Buffer.from(parse(first).ciphertext, 'base64url').length).toBe(48);
    const localMaster = master.slice();
    const localRecovery = recovery.slice();
    const localMetadata = { ...metadata };
    const pending = createRecoveryKeyEnvelope(localMaster, localRecovery, localMetadata, {
      async fill(bytes) {
        localMaster.fill(0);
        localRecovery.fill(0);
        localMetadata.account = 'changed';
        randomFillSync(bytes);
      },
    });
    expect(await openRecoveryKeyEnvelope(await pending, recovery, metadata)).toEqual({
      ok: true,
      masterKey: master,
    });
  });
  it('rejects modifications to every authenticated header field and to ciphertext and tag', async () => {
    const envelope = await createRecoveryKeyEnvelope(master, recovery, metadata, random);
    for (const [field, value] of Object.entries({
      account: 'other',
      vaultId: 'AQAAAAAAAAAAAAAAAAAAAA',
      revision: 2,
      salt: 'AQAAAAAAAAAAAAAAAAAAAA',
      nonce: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      version: 2,
      profile: 'other',
      domain: 'other',
      access: 'password',
      format: 'other',
      outputBytes: 64,
    })) {
      const result = await openRecoveryKeyEnvelope(
        mutate(envelope, (v) => {
          v.header[field] = value;
        }),
        recovery,
        metadata,
      );
      expect(result.ok, field).toBe(false);
      expect(Object.keys(result).sort()).toEqual(['code', 'ok']);
    }
    for (const offset of [0, 47]) {
      const changed = mutate(envelope, (value) => {
        const bytes = Buffer.from(value.ciphertext, 'base64url');
        bytes[offset] = bytes[offset]! ^ 1;
        value.ciphertext = bytes.toString('base64url');
      });
      expect(await openRecoveryKeyEnvelope(changed, recovery, metadata)).toEqual({
        ok: false,
        code: 'AUTHENTICATION_FAILED',
      });
    }
    expect(
      await openRecoveryKeyEnvelope(envelope, recovery, { ...metadata, account: 'other' }),
    ).toEqual({ ok: false, code: 'CONTEXT_MISMATCH' });
    expect(
      await openRecoveryKeyEnvelope(envelope, recovery, {
        ...metadata,
        vaultId: 'AQAAAAAAAAAAAAAAAAAAAA',
      }),
    ).toEqual({ ok: false, code: 'CONTEXT_MISMATCH' });
  });
  it('rejects hostile encodings, schemas and limits', async () => {
    const envelope = await createRecoveryKeyEnvelope(master, recovery, metadata, random);
    const text = new TextDecoder().decode(envelope);
    const invalid = [
      Uint8Array.of(255),
      new Uint8Array(2049),
      new TextEncoder().encode(' ' + text),
      new TextEncoder().encode(text.replace('"account":', '"account":"x","acc\\u006funt":')),
      new TextEncoder().encode('\ufeff' + text),
      encode({ header: [] }),
      mutate(envelope, (v) => {
        v.header.salt += '=';
      }),
      mutate(envelope, (v) => {
        v.header.salt = 'AAAAAAAAAAAAAAAAAAAAAB';
      }),
      mutate(envelope, (v) => {
        v.unknown = true;
      }),
      mutate(envelope, (v) => {
        v.header.revision = 0;
      }),
      mutate(envelope, (v) => {
        v.header.account = ' leading';
      }),
      mutate(envelope, (v) => {
        delete v.header.nonce;
      }),
    ];
    for (const input of invalid) expect(validateRecoveryKeyEnvelope(input).ok).toBe(false);
  });
  it('propagates random source failures without secrets and preserves caller buffers', async () => {
    const broken = {
      async fill() {
        throw new Error('sensitive provider detail');
      },
    };
    for (const generate of [generateMasterKey, generateRecoveryKey, generateVaultId]) {
      await expect(generate(broken)).rejects.toMatchObject({
        code: 'CRYPTO_UNAVAILABLE',
        message: 'CRYPTO_UNAVAILABLE',
      });
    }
    await expect(
      createRecoveryKeyEnvelope(master, recovery, metadata, broken),
    ).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE' });
    expect(master).toEqual(new Uint8Array(32).fill(7));
    expect(recovery).toEqual(new Uint8Array(32).fill(9));
  });
  it('matches the independently verified HKDF recovery key vector with the production domain', () => {
    const vector = JSON.parse(
      readFileSync(new URL('./fixtures/key-envelope-recovery.json', import.meta.url), 'utf8'),
    );
    const key = Buffer.from(vector.secret, 'hex');
    const salt = Buffer.from(vector.salt, 'hex');
    expect(Buffer.from(deriveRecoveryWrappingKey(key, salt)).toString('hex')).toBe(vector.key);
  });
  it('matches an independently produced complete recovery envelope in both directions', async () => {
    const vector = JSON.parse(
      readFileSync(new URL('./fixtures/key-envelope-recovery.json', import.meta.url), 'utf8'),
    );
    const source = [Buffer.from(vector.salt, 'hex'), Buffer.from(vector.nonce, 'hex')];
    const created = await createRecoveryKeyEnvelope(
      Buffer.from(vector.master, 'hex'),
      Buffer.from(vector.secret, 'hex'),
      metadata,
      {
        async fill(bytes) {
          bytes.set(source.shift()!);
        },
      },
    );
    expect(new TextDecoder().decode(created)).toBe(vector.envelope);
    expect(
      await openRecoveryKeyEnvelope(
        new TextEncoder().encode(vector.envelope),
        Buffer.from(vector.secret, 'hex'),
        metadata,
      ),
    ).toEqual({ ok: true, masterKey: Uint8Array.from(Buffer.from(vector.master, 'hex')) });
  });
});

it('matches native Node Argon2id and HKDF at the exact candidate production costs', async () => {
  const salt = new Uint8Array(16).fill(2);
  const password = 'Pässword 🐇';
  const raw = await new Promise<Buffer>((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: new TextEncoder().encode(password),
        nonce: salt,
        memory: 65536,
        passes: 3,
        parallelism: 4,
        tagLength: 32,
      },
      (error, value) => {
        if (error) reject(error);
        else resolve(value);
      },
    );
  });
  try {
    const expected = hkdfSync(
      'sha256',
      raw,
      salt,
      'bunny-talks/key-envelope/password/v1/wrapping-key',
      32,
    );
    const actual = await derivePasswordWrappingKey(password, salt);
    expect(Buffer.from(actual)).toEqual(Buffer.from(expected));
    actual.fill(0);
  } finally {
    raw.fill(0);
  }
}, 30000);

it('authenticates password envelope ciphertext and revision', async () => {
  const bytes = await createPasswordKeyEnvelope(master, 'password', metadata, random);
  for (const change of [
    (value: ReturnType<typeof parse>) => {
      value.header.revision++;
    },
    (value: ReturnType<typeof parse>) => {
      const encrypted = Buffer.from(value.ciphertext, 'base64url');
      encrypted[47] = encrypted[47]! ^ 1;
      value.ciphertext = encrypted.toString('base64url');
    },
  ]) {
    expect(await openPasswordKeyEnvelope(mutate(bytes, change), 'password', metadata)).toEqual({
      ok: false,
      code: 'AUTHENTICATION_FAILED',
    });
  }
}, 30000);

it('fails closed on detached or failing nonce buffers and rejects invalid key lengths', async () => {
  let calls = 0;
  await expect(
    createRecoveryKeyEnvelope(master, recovery, metadata, {
      async fill(bytes) {
        if (++calls === 2) throw new Error('nonce failure');
        randomFillSync(bytes);
      },
    }),
  ).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE' });
  await expect(
    generateMasterKey({
      async fill(bytes) {
        structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
      },
    }),
  ).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE' });
  await expect(
    createRecoveryKeyEnvelope(new Uint8Array(31), recovery, metadata, random),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    createRecoveryKeyEnvelope(master, new Uint8Array(31), metadata, random),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
