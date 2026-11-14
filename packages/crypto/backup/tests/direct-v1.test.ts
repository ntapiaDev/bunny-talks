import { readFileSync } from 'node:fs';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { describe, expect, it, vi } from 'vitest';
import type { CryptographicRandomSource } from '../src/experimental.js';
import {
  createDirectVaultV1,
  openDirectVaultV1,
  validateEnvelopeStructureV1,
} from '../src/experimental.js';

const vector = JSON.parse(
  readFileSync(
    new URL('../../engine/tests/fixtures/recovery-direct-v1-vector.json', import.meta.url),
    'utf8',
  ),
) as Record<string, string>;
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const secret = () => bytes(vector.secret!);
const data = () => bytes(vector.plaintext!);
const metadata = { account: 'AAECAwQFBgcICQoLDA0ODw', generation: 1 };
const encoder = new TextEncoder();
const source = (): CryptographicRandomSource => {
  let count = 0;
  return {
    fill: async (buffer) => {
      buffer.set(bytes(count++ === 0 ? vector.salt! : vector.nonce!));
    },
  };
};
const modify = (fn: (value: { ciphertext: string; header: Record<string, unknown> }) => void) => {
  const value = JSON.parse(vector.envelopeCanonical!) as {
    ciphertext: string;
    header: Record<string, unknown>;
  };
  fn(value);
  return encoder.encode(JSON.stringify(value));
};

describe('experimental direct vault V1', () => {
  it('matches the independently generated V1 vector in both directions', async () => {
    const input = data();
    const key = secret();
    const envelope = await createDirectVaultV1(input, key, metadata, source());
    expect(new TextDecoder().decode(envelope)).toBe(vector.envelopeCanonical);
    expect(openDirectVaultV1(envelope, key)).toEqual({ ok: true, plaintext: input });
    expect(key).toEqual(secret());
    expect(input).toEqual(data());
  });

  it.each([
    new Uint8Array(),
    Uint8Array.of(0xff, 0x80, 0, 0xc3),
    new Uint8Array(65_536).fill(0xa5),
  ])('round trips binary contents of size $byteLength', async (input) => {
    const envelope = await createDirectVaultV1(input, secret(), metadata, source());
    expect(openDirectVaultV1(envelope, secret())).toEqual({ ok: true, plaintext: input });
  });

  it('rejects oversized plaintext, malformed secrets and metadata before requesting randomness', async () => {
    const random = { fill: vi.fn(async () => {}) };
    const extraMetadata = { ...metadata, extra: 1 };
    for (const [input, key, meta] of [
      [new Uint8Array(65_537), secret(), metadata],
      [data(), new Uint8Array(31), metadata],
      [data(), new Uint8Array(33), metadata],
      [data(), secret(), extraMetadata],
      [data(), secret(), { ...metadata, account: 'AAECAwQFBgcICQoLDA0ODx' }],
      [data(), secret(), { ...metadata, generation: 0 }],
      [data(), secret(), { ...metadata, generation: Number.MAX_SAFE_INTEGER + 1 }],
    ] as const)
      await expect(createDirectVaultV1(input, key, meta, random)).rejects.toThrow();
    expect(random.fill).not.toHaveBeenCalled();
    expect(() =>
      openDirectVaultV1(encoder.encode(vector.envelopeCanonical!), new Uint8Array(31)),
    ).toThrow();
    expect(openDirectVaultV1(encoder.encode('{}'), new Uint8Array(31))).toEqual({
      ok: false,
      code: 'INVALID_ENVELOPE',
    });
    await expect(
      createDirectVaultV1(
        data(),
        secret(),
        { ...metadata, generation: Number.MAX_SAFE_INTEGER },
        source(),
      ),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it('fails closed when the source fails or detaches salt or nonce', async () => {
    const failure = new Error('source failed');
    await expect(
      createDirectVaultV1(data(), secret(), metadata, {
        fill: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    for (const detachAt of [0, 1]) {
      let call = 0;
      await expect(
        createDirectVaultV1(data(), secret(), metadata, {
          fill: async (buffer) => {
            if (call++ === detachAt)
              structuredClone(buffer.buffer, { transfer: [buffer.buffer as ArrayBuffer] });
          },
        }),
      ).rejects.toThrow();
    }
  });

  it('characterizes a silently broken source: zero salt and nonce produce repeatable envelopes', async () => {
    // This source violates the contract. Successful resolution does not prove a buffer was filled.
    const random = { fill: vi.fn(async () => {}) };
    const first = await createDirectVaultV1(data(), secret(), metadata, random);
    const second = await createDirectVaultV1(data(), secret(), metadata, random);
    const result = validateEnvelopeStructureV1(first);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected structurally valid envelope');
    expect(result.envelope.header.salt).toBe(Buffer.alloc(16).toString('base64url'));
    expect(result.envelope.header.nonce).toBe(Buffer.alloc(24).toString('base64url'));
    expect(second).toEqual(first);
    expect(random.fill).toHaveBeenCalledTimes(4);
    expect(openDirectVaultV1(first, secret())).toEqual({ ok: true, plaintext: data() });
  });

  it('snapshots caller inputs and the salt before asynchronous source calls finish', async () => {
    const plaintext = data();
    const recoverySecret = secret();
    const mutableMetadata = { ...metadata };
    let release!: () => void;
    let nonceRequested!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nonceStarted = new Promise<void>((resolve) => {
      nonceRequested = resolve;
    });
    let saltBuffer: Uint8Array | undefined;
    const random: CryptographicRandomSource = {
      fill: async (buffer) => {
        if (!saltBuffer) {
          buffer.set(bytes(vector.salt!));
          saltBuffer = buffer;
          return;
        }
        nonceRequested();
        await waiting;
        buffer.set(bytes(vector.nonce!));
      },
    };
    const pending = createDirectVaultV1(plaintext, recoverySecret, mutableMetadata, random);
    await nonceStarted;
    plaintext.fill(0);
    recoverySecret.fill(0);
    mutableMetadata.generation = 2;
    saltBuffer!.fill(0xff);
    release();
    expect(new TextDecoder().decode(await pending)).toBe(vector.envelopeCanonical);
  });

  it('propagates an asynchronous nonce source failure without modifying caller buffers', async () => {
    const plaintext = data();
    const recoverySecret = secret();
    const failure = new Error('nonce source failure');
    let count = 0;
    await expect(
      createDirectVaultV1(plaintext, recoverySecret, metadata, {
        fill: async (buffer) => {
          await Promise.resolve();
          if (count++ === 1) throw failure;
          buffer.set(bytes(vector.salt!));
        },
      }),
    ).rejects.toBe(failure);
    expect(plaintext).toEqual(data());
    expect(recoverySecret).toEqual(secret());
  });

  it('checks the installed Noble authentication error directly', () => {
    const ciphertext = bytes(vector.ciphertextAndTag!);
    ciphertext[ciphertext.length - 1] = ciphertext[ciphertext.length - 1]! ^ 1;
    const cipher = xchacha20poly1305(bytes(vector.key!), bytes(vector.nonce!), bytes(vector.aad!));
    let caught: unknown;
    try {
      cipher.decrypt(ciphertext);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('invalid tag');
  });

  it('rejects wrong secrets and all authenticated modifications without plaintext', () => {
    const altered = [
      modify((v) => {
        const b = Buffer.from(v.ciphertext, 'base64url');
        b[0] = b[0]! ^ 1;
        v.ciphertext = b.toString('base64url');
      }),
      modify((v) => {
        const b = Buffer.from(v.ciphertext, 'base64url');
        b[b.length - 1] = b[b.length - 1]! ^ 1;
        v.ciphertext = b.toString('base64url');
      }),
      ...(['account', 'generation', 'salt', 'nonce'] as const).map((field) =>
        modify((v) => {
          v.header[field] =
            field === 'generation'
              ? 2
              : field === 'nonce'
                ? 'AQECAwQFBgcICQoLDA0ODxAREhMUFRYX'
                : 'AQECAwQFBgcICQoLDA0ODw';
        }),
      ),
    ];
    expect(
      openDirectVaultV1(encoder.encode(vector.envelopeCanonical!), new Uint8Array(32)),
    ).toEqual({ ok: false, code: 'AUTHENTICATION_FAILED' });
    for (const envelope of altered)
      expect(openDirectVaultV1(envelope, secret())).toEqual({
        ok: false,
        code: 'AUTHENTICATION_FAILED',
      });
  });

  it('rejects invalid salt, nonce, unknown fields, versions and profiles structurally', () => {
    for (const field of ['salt', 'nonce']) {
      expect(
        openDirectVaultV1(
          modify((v) => {
            v.header[field] = 'AA';
          }),
          secret(),
        ),
      ).toEqual({ ok: false, code: 'INVALID_ENVELOPE' });
    }
    expect(
      openDirectVaultV1(
        modify((v) => {
          v.header.extra = 1;
        }),
        secret(),
      ),
    ).toEqual({ ok: false, code: 'INVALID_ENVELOPE' });
    for (const field of ['version', 'profile', 'format']) {
      expect(
        openDirectVaultV1(
          modify((v) => {
            v.header[field] = 'unsupported';
          }),
          secret(),
        ),
      ).toEqual({ ok: false, code: 'UNSUPPORTED_FORMAT' });
    }
  });

  it('propagates unexpected internal failures', () => {
    const failure = new Error('unexpected');
    const spy = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw failure;
    });
    try {
      expect(() => openDirectVaultV1(encoder.encode(vector.envelopeCanonical!), secret())).toThrow(
        failure,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
