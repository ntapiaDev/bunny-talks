import { readFileSync } from 'node:fs';
import canonicalize from 'canonicalize';
import { canonicalize as alternative, canonicalizeEx } from 'json-canonicalize';
import { visit } from 'jsonc-parser';
import { describe, expect, it, vi } from 'vitest';

const options = { disallowComments: true, allowTrailingComma: false };

function observe(text: string) {
  const properties: string[] = [];
  const errors: number[] = [];
  visit(
    text,
    { onObjectProperty: (name) => properties.push(name), onError: (error) => errors.push(error) },
    options,
  );
  return { properties, errors };
}

describe('jsonc-parser 3.3.1 event characterization', () => {
  it.each([
    ['{"account":1,"account":2}', 'account'],
    ['{"account":1,"acc\\u006funt":2}', 'account'],
  ])('emits both decoded property names: %s', (source, name) => {
    const result = observe(source);
    expect(result.errors).toEqual([]);
    expect(result.properties).toEqual([name, name]);
  });

  it.each(['{/* comment */"a":1}', '{"a":1,}', '{"a":', '{"a" 1}'])(
    'reports syntax errors for %s',
    (source) => {
      expect(observe(source).errors.length).toBeGreaterThan(0);
    },
  );

  it('recovers and continues after an error unless the caller interrupts', () => {
    const source = '{/* bad */"a":1}';
    expect(observe(source).properties).toEqual(['a']);
    const aborted = new Error('stop');
    const afterError = vi.fn();
    expect(() =>
      visit(
        source,
        {
          onError: () => {
            throw aborted;
          },
          onObjectProperty: afterError,
        },
        options,
      ),
    ).toThrow(aborted);
    expect(afterError).not.toHaveBeenCalled();
  });

  it('passes decoded names and allows caller checks for unknown fields and field counts', () => {
    const stop = new Error('reject');
    let count = 0;
    expect(() =>
      visit(
        '{"a":1,"extra":2,"later":3}',
        {
          onObjectProperty: (name) => {
            count += 1;
            if (name !== 'a' || count > 2) throw stop;
          },
        },
        options,
      ),
    ).toThrow(stop);
    expect(count).toBe(2);
  });

  it('reports long property names after they have been scanned', () => {
    const name = 'x'.repeat(4096);
    const source = `{"${name}":1}`;
    const result = observe(source);
    expect(Buffer.byteLength(source)).toBe(4102);
    expect(result.errors).toEqual([]);
    expect(result.properties[0]).toHaveLength(4096);
  });

  it('allows caller interruption on nesting but false only suppresses callbacks', () => {
    const source = '{"a":{"b":{"c":1}},"later":2}';
    const seen: string[] = [];
    let depth = 0;
    const stop = new Error('depth');
    expect(() =>
      visit(
        source,
        {
          onObjectBegin: () => {
            if (++depth > 2) throw stop;
          },
          onObjectProperty: (name) => seen.push(name),
        },
        options,
      ),
    ).toThrow(stop);
    expect(seen).toEqual(['a', 'b']);
    const after: string[] = [];
    let begins = 0;
    visit(
      source,
      {
        onObjectBegin: () => (++begins === 2 ? false : undefined),
        onObjectProperty: (name) => after.push(name),
        onObjectEnd: () => {},
      },
      options,
    );
    expect(after).toEqual(['a', 'later']);
  });

  it('delivers a long string only after scanning it, so callback limits are not preallocation limits', () => {
    const value = 'x'.repeat(131_073);
    const source = `{"a":"${value}","later":1}`;
    expect(Buffer.byteLength(source)).toBe(131_091);
    const stop = new Error('length');
    const seen: string[] = [];
    expect(() =>
      visit(
        source,
        {
          onObjectProperty: (name) => seen.push(name),
          onLiteralValue: (literal) => {
            if (typeof literal === 'string' && literal.length > 64) throw stop;
          },
        },
        options,
      ),
    ).toThrow(stop);
    expect(seen).toEqual(['a']);
  });

  it('accepts escaped lone surrogate syntax and does not itself enforce Unicode scalar values', () => {
    const values: unknown[] = [];
    const errors: number[] = [];
    visit(
      '{"a":"\\ud800"}',
      { onLiteralValue: (value) => values.push(value), onError: (error) => errors.push(error) },
      options,
    );
    expect(errors).toEqual([]);
    expect(values).toEqual(['\ud800']);
  });
});

describe('input decoding behavior', () => {
  it('rejects malformed UTF-8 with fatal decoding', () => {
    expect(() =>
      new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.of(0xc3, 0x28)),
    ).toThrow();
  });

  it('shows default UTF-8 decoding strips BOM, while ignoreBOM preserves it for rejection', () => {
    const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d);
    expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe('{}');
    expect(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)).toBe(
      '\ufeff{}',
    );
  });
});

describe('JCS candidates', () => {
  const candidates = [
    ['canonicalize', canonicalize],
    ['json-canonicalize', alternative],
  ] as const;
  for (const [name, serialize] of candidates) {
    it(`${name} matches RFC 8785 section 3.2.4 UTF-8 bytes`, () => {
      const value = {
        numbers: [Number('333333333.33333329'), 1e30, 4.5, 2e-3, 1e-27],
        string: `€$\u000f\nA'B"\\\\"/`,
        literals: [null, true, false],
      };
      const expected =
        '7b226c69746572616c73223a5b6e756c6c2c747275652c66616c73655d2c226e756d62657273223a5b3333333333333333332e333333333333332c31652b33302c342e352c302e3030322c31652d32375d2c22737472696e67223a22e282ac245c75303030665c6e4127425c225c5c5c5c5c222f227d';
      expect(Buffer.from(serialize(value)!, 'utf8').toString('hex')).toBe(expected);
    });

    it(`${name} orders the RFC 8785 Unicode property names by UTF-16`, () => {
      const value = {
        '€': 'Euro Sign',
        '\r': 'Carriage Return',
        '\ufb33': 'Hebrew Letter Dalet With Dagesh',
        '1': 'One',
        '😀': 'Emoji: Grinning Face',
        '\u0080': 'Control',
        ö: 'Latin Small Letter O With Diaeresis',
      };
      expect(serialize(value)).toBe(
        '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
      );
    });

    it(`${name} matches direct V1 fixture bytes`, () => {
      const fixture = JSON.parse(
        readFileSync(new URL('./fixtures/recovery-direct-v1-vector.json', import.meta.url), 'utf8'),
      ) as { envelopeCanonical: string };
      expect(serialize(JSON.parse(fixture.envelopeCanonical))).toBe(fixture.envelopeCanonical);
    });

    it(`${name} rejects non-finite numbers and BigInt`, () => {
      for (const value of [NaN, Infinity, -Infinity, 1n]) expect(() => serialize(value)).toThrow();
    });

    it(`${name} serializes RFC 8785 finite numeric boundary examples`, () => {
      expect(serialize([-0, Number.MIN_VALUE, Number.MAX_VALUE, 1e-6, 1e-7])).toBe(
        '[0,5e-324,1.7976931348623157e+308,0.000001,1e-7]',
      );
    });

    it(`${name} distinguishes canonical bytes from an equivalent non-canonical JSON input`, () => {
      const input = '{ "z": 1, "a": "\\u0061" }';
      expect(serialize(JSON.parse(input))).toBe('{"a":"a","z":1}');
      expect(serialize(JSON.parse(input))).not.toBe(input);
    });
  }

  it('canonicalize rejects an isolated surrogate; json-canonicalize serializes it', () => {
    expect(() => canonicalize('\ud800')).toThrow();
    expect(alternative('\ud800')).toBe('"\\ud800"');
  });

  it('neither default serializer rejects every non-JSON JS value', () => {
    expect(canonicalize({ a: undefined })).toBe('{}');
    expect(alternative({ a: undefined })).toBe('{}');
    expect(alternative({ a: () => 1 })).toBe('{"a":undefined}');
    expect(() => canonicalizeEx({ a: undefined }, { strictUndefined: true })).toThrow();
  });
});
