import { randomBytes as cipherRandomBytes } from '@noble/ciphers/utils.js';
import { randomBytes as hashRandomBytes } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Node JSON and UTF-8 behavior relevant to recovery', () => {
  it('shows JSON.parse silently overwrites simple and escaped duplicate keys', () => {
    expect(JSON.parse('{"account":1,"account":2}')).toEqual({ account: 2 });
    const source = String.raw`{"account":1,"acc\u006funt":2}`;
    expect(Buffer.from(source).toString('hex')).toBe(
      '7b226163636f756e74223a312c226163635c7530303666756e74223a327d',
    );
    expect(JSON.parse(source)).toEqual({ account: 2 });
  });

  it('rejects malformed UTF-8 only with fatal decoding', () => {
    const bytes = Uint8Array.of(0xc3, 0x28);
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow();
    expect(new TextDecoder('utf-8').decode(bytes)).toContain('\ufffd');
  });

  it('shows valid JSON syntax can contain an unpaired surrogate', () => {
    const parsed = JSON.parse('"\\ud800"') as string;
    expect(parsed.length).toBe(1);
    expect(parsed.charCodeAt(0)).toBe(0xd800);
  });

  it('shows JSON.stringify does not canonicalize property order', () => {
    const value = { z: 1, a: 2 };
    expect(JSON.stringify(value)).toBe('{"z":1,"a":2}');
    // RFC 8785 property ordering for this input is {"a":2,"z":1}.
    expect(JSON.stringify(value)).not.toBe('{"a":2,"z":1}');
  });

  it('throws for incomplete JSON but accepts large inputs without application limits', () => {
    expect(() => JSON.parse('{"account":')).toThrow(SyntaxError);
    const input = JSON.stringify({ payload: 'x'.repeat(131_072) });
    expect(input.length).toBeGreaterThan(131_072);
    expect((JSON.parse(input) as { payload: string }).payload).toHaveLength(131_072);
  });
});

describe('Noble public randomBytes behavior under Node', () => {
  for (const [name, randomBytes] of [
    ['ciphers', cipherRandomBytes],
    ['hashes', hashRandomBytes],
  ] as const) {
    it(`${name} uses the available platform source`, () => {
      expect(randomBytes(32)).toHaveLength(32);
    });

    it(`${name} fails when the platform source is absent`, () => {
      vi.stubGlobal('crypto', undefined);
      expect(() => randomBytes(32)).toThrow('crypto.getRandomValues must be defined');
    });

    it(`${name} propagates an error from the platform source`, () => {
      vi.stubGlobal('crypto', {
        getRandomValues: () => {
          throw new Error('source unavailable');
        },
      });
      expect(() => randomBytes(32)).toThrow('source unavailable');
    });

    it(`${name} rejects requests exceeding the Web Crypto call limit`, () => {
      expect(() => randomBytes(65_537)).toThrow(RangeError);
    });
  }
});
