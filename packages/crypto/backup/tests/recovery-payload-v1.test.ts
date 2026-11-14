import { describe, expect, it, vi } from 'vitest';
import type { RecoveryPayloadV1 } from '../src/experimental.js';
import {
  createDirectVaultV1,
  decodeRecoveryPayloadV1,
  openDirectVaultV1,
  serializeRecoveryPayloadV1,
} from '../src/experimental.js';

const key = (value: number) => new Uint8Array(32).fill(value);
const example = (): RecoveryPayloadV1 => ({
  identity: {
    dhPublicKey: key(0),
    dhPrivateKey: key(0xff),
    signingPublicKey: key(0x80),
    signingPrivateKey: key(0x55),
  },
  archiveKeys: [
    { version: 1, key: key(0xa5) },
    { version: 0xffff_ffff, key: key(0x33) },
  ],
});
const serialize = (value: RecoveryPayloadV1) => {
  const result = serializeRecoveryPayloadV1(value);
  if (!result.ok) throw new Error(result.code);
  return result.bytes;
};
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const invalid = { ok: false, code: 'INVALID_PAYLOAD' };

describe('experimental recovery payload V1', () => {
  it('serializes exact specified bytes and preserves arbitrary binary material', () => {
    const original = example();
    const bytes = serialize(original);
    expect(toHex(bytes)).toBe(
      '4254525041594c4401010102' +
        '00'.repeat(32) +
        'ff'.repeat(32) +
        '80'.repeat(32) +
        '55'.repeat(32) +
        '00000001' +
        'a5'.repeat(32) +
        'ffffffff' +
        '33'.repeat(32),
    );
    expect(decodeRecoveryPayloadV1(bytes)).toEqual({ ok: true, payload: original });
  });

  it('uses independent byte arrays in both directions', () => {
    const original = example();
    const wire = serialize(original);
    original.identity.dhPrivateKey.fill(1);
    original.archiveKeys[0]!.key.fill(2);
    const result = decodeRecoveryPayloadV1(wire);
    if (!result.ok) throw new Error(result.code);
    expect(result.payload.identity.dhPrivateKey).toEqual(key(0xff));
    expect(result.payload.archiveKeys[0]!.key).toEqual(key(0xa5));
    wire.fill(0);
    expect(result.payload.identity.signingPrivateKey).toEqual(key(0x55));
    result.payload.identity.dhPrivateKey.fill(3);
    expect(result.payload.archiveKeys[0]!.key).toEqual(key(0xa5));
  });

  it('preserves every byte value across keys', () => {
    const payload = example();
    const keys = [
      payload.identity.dhPublicKey,
      payload.identity.dhPrivateKey,
      payload.identity.signingPublicKey,
      payload.identity.signingPrivateKey,
      payload.archiveKeys[0]!.key,
      payload.archiveKeys[1]!.key,
    ];
    keys.push(key(0), key(0));
    keys.forEach((buffer, index) =>
      buffer.forEach((_, position) => {
        buffer[position] = index * 32 + position;
      }),
    );
    const extended = {
      ...payload,
      archiveKeys: [...payload.archiveKeys, { version: 0xffff_fffe, key: keys[6]! }],
    };
    // Archive versions must remain in strictly increasing order.
    expect(serializeRecoveryPayloadV1(extended)).toEqual(invalid);
    const ordered = {
      ...payload,
      archiveKeys: [
        { version: 1, key: keys[4]! },
        { version: 2, key: keys[5]! },
        { version: 3, key: keys[6]! },
        { version: 4, key: keys[7]! },
      ],
    };
    expect(decodeRecoveryPayloadV1(serialize(ordered))).toEqual({ ok: true, payload: ordered });
  });

  it('accepts the minimum and maximum counts and rejects outside bounds', () => {
    const base = example();
    const entries = Array.from({ length: 64 }, (_, i) => ({ version: i + 1, key: key(i) }));
    for (const archiveKeys of [[], entries.slice(0, 1), entries]) {
      const wire = serialize({ ...base, archiveKeys });
      expect(wire.length).toBe(140 + archiveKeys.length * 36);
      expect(decodeRecoveryPayloadV1(wire).ok).toBe(true);
    }
    expect(
      serializeRecoveryPayloadV1({
        ...base,
        archiveKeys: [...entries, { version: 65, key: key(1) }],
      }),
    ).toEqual({ ok: false, code: 'LIMIT_EXCEEDED' });
    expect(decodeRecoveryPayloadV1(new Uint8Array(2445))).toEqual({
      ok: false,
      code: 'LIMIT_EXCEEDED',
    });
  });

  it('round trips exactly 140 bytes for an identity without archive keys', () => {
    const payload = { ...example(), archiveKeys: [] };
    const wire = serialize(payload);
    expect(wire).toHaveLength(140);
    expect(wire[11]).toBe(0);
    expect(toHex(wire)).toBe(
      '4254525041594c4401010100' +
        '00'.repeat(32) +
        'ff'.repeat(32) +
        '80'.repeat(32) +
        '55'.repeat(32),
    );
    expect(decodeRecoveryPayloadV1(wire)).toEqual({ ok: true, payload });
    expect(decodeRecoveryPayloadV1(wire.subarray(0, 139))).toEqual(invalid);
    const extra = new Uint8Array(141);
    extra.set(wire);
    expect(decodeRecoveryPayloadV1(extra)).toEqual(invalid);
  });

  it('rejects missing or unknown fields, getters, malformed keys and versions', () => {
    const base = example();
    const candidates: unknown[] = [
      null,
      {},
      { ...base, extra: true },
      { ...base, identity: { ...base.identity, extra: 1 } },
      { ...base, identity: { ...base.identity, dhPublicKey: key(1).subarray(1) } },
      { ...base, identity: { ...base.identity, signingPrivateKey: 'invalid' } },
      { ...base, archiveKeys: [{ version: 1 }] },
      { ...base, archiveKeys: [{ version: 1, key: key(1), extra: true }] },
      { ...base, archiveKeys: [{ version: 0, key: key(1) }] },
      { ...base, archiveKeys: [{ version: 1.5, key: key(1) }] },
      { ...base, archiveKeys: [{ version: 0x1_0000_0000, key: key(1) }] },
      {
        ...base,
        archiveKeys: [
          { version: 2, key: key(1) },
          { version: 2, key: key(2) },
        ],
      },
      {
        ...base,
        archiveKeys: [
          { version: 2, key: key(1) },
          { version: 1, key: key(2) },
        ],
      },
      {
        ...base,
        get identity() {
          throw new Error('must not run');
        },
      },
    ];
    for (const candidate of candidates)
      expect(serializeRecoveryPayloadV1(candidate as RecoveryPayloadV1)).toEqual(invalid);
  });

  it('rejects malformed lengths, count inconsistencies, unordered versions and unsupported headers', () => {
    const wire = serialize(example());
    for (const index of [0, 8, 9, 10]) {
      const altered = wire.slice();
      altered[index] = altered[index]! ^ 0x7f;
      expect(decodeRecoveryPayloadV1(altered)).toEqual({ ok: false, code: 'UNSUPPORTED_FORMAT' });
    }
    for (const count of [0, 1, 3]) {
      const altered = wire.slice();
      altered[11] = count;
      expect(decodeRecoveryPayloadV1(altered)).toEqual(invalid);
    }
    const tooMany = wire.slice();
    tooMany[11] = 65;
    expect(decodeRecoveryPayloadV1(tooMany)).toEqual({ ok: false, code: 'LIMIT_EXCEEDED' });
    const zeroVersion = wire.slice();
    zeroVersion.fill(0, 140, 144);
    expect(decodeRecoveryPayloadV1(zeroVersion)).toEqual(invalid);
    const duplicate = wire.slice();
    duplicate.set([0, 0, 0, 1], 176);
    expect(decodeRecoveryPayloadV1(duplicate)).toEqual(invalid);
    expect(decodeRecoveryPayloadV1(wire.subarray(0, wire.length - 1))).toEqual(invalid);
    const extra = new Uint8Array(wire.length + 1);
    extra.set(wire);
    expect(decodeRecoveryPayloadV1(extra)).toEqual(invalid);
  });

  it.each([false, true])(
    'round trips inside the V1 envelope without Node Buffer (empty archives: %s)',
    async (emptyArchives) => {
      vi.stubGlobal('Buffer', undefined);
      try {
        const payload = emptyArchives ? { ...example(), archiveKeys: [] } : example();
        const wire = serialize(payload);
        const secret = key(9);
        let calls = 0;
        const envelope = await createDirectVaultV1(
          wire,
          secret,
          { account: 'AAECAwQFBgcICQoLDA0ODw', generation: 1 },
          {
            fill: async (buffer) => {
              buffer.fill(++calls);
            },
          },
        );
        const opened = openDirectVaultV1(envelope, secret);
        if (!opened.ok) throw new Error(opened.code);
        expect(decodeRecoveryPayloadV1(opened.plaintext)).toEqual({ ok: true, payload });
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});
