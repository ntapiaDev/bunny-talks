import { generateIdentityKeyPair } from '@open-e2ee/signal-protocol-sdk/keys';
import { describe, expect, it } from 'vitest';
import { prepareImportedIdentity } from '../src/index.js';

describe('prepareImportedIdentity', () => {
  it('prepares the exported account keys with a device registration ID', async () => {
    const source = await generateIdentityKeyPair();
    const exported = JSON.parse(
      JSON.stringify({ dhKey: source.dhKey, signingKey: source.signingKey }),
    );
    const before = JSON.stringify(exported);
    const prepared = prepareImportedIdentity(exported, 16380);
    expect(prepared.dhKey).toEqual(source.dhKey);
    expect(prepared.signingKey).toEqual(source.signingKey);
    expect(prepared.registrationId).toBe(16380);
    expect(JSON.stringify(exported)).toBe(before);
  });

  it('rejects malformed and mismatched identities', async () => {
    const first = await generateIdentityKeyPair();
    const second = await generateIdentityKeyPair();
    for (const identity of [
      null,
      {},
      { ...first, dhKey: { ...first.dhKey, publicKey: second.dhKey.publicKey } },
    ]) {
      expect(() => prepareImportedIdentity(identity, 1)).toThrow('Invalid exported identity');
    }
  });

  it('rejects registration IDs outside the conservative public range', async () => {
    const identity = await generateIdentityKeyPair();
    for (const id of [0, -1, 16381, 16383, 16384, 1.5, NaN, Infinity]) {
      expect(() => prepareImportedIdentity(identity, id)).toThrow('Invalid registration ID');
    }
    expect(prepareImportedIdentity(identity, 1).registrationId).toBe(1);
  });

  it('validates the snapshot rather than rereading accessor values', async () => {
    const first = await generateIdentityKeyPair();
    const second = await generateIdentityKeyPair();
    let reads = 0;
    const input = {
      get dhKey() {
        reads++;
        return reads === 1 ? first.dhKey : second.dhKey;
      },
      signingKey: first.signingKey,
    };
    const result = prepareImportedIdentity(input, 2);
    expect(reads).toBe(1);
    expect(result.dhKey).toEqual(first.dhKey);
  });
});
