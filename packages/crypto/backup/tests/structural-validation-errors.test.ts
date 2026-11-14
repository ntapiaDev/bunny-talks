import { readFileSync } from 'node:fs';
import type * as CanonicalizeModule from 'canonicalize';
import type * as JsoncParserModule from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateEnvelopeStructureV1 } from '../src/experimental.js';

const calls = vi.hoisted(() => ({
  begins: 0,
  properties: [] as string[],
  literals: 0,
  canonicalizations: 0,
  visitError: null as Error | null,
  canonicalizeError: null as Error | null,
}));

vi.mock('jsonc-parser', async (importOriginal) => {
  const original = await importOriginal<typeof JsoncParserModule>();
  return {
    ...original,
    visit: (...args: Parameters<typeof original.visit>) => {
      if (calls.visitError) throw calls.visitError;
      const [text, visitor, options] = args;
      const wrapped: typeof visitor = {
        ...visitor,
        onObjectBegin: (...event) => {
          calls.begins += 1;
          return visitor.onObjectBegin?.(...event);
        },
        onObjectProperty: (...event) => {
          calls.properties.push(event[0]);
          visitor.onObjectProperty?.(...event);
        },
        onLiteralValue: (...event) => {
          calls.literals += 1;
          visitor.onLiteralValue?.(...event);
        },
      };
      return original.visit(text, wrapped, options);
    },
  };
});

vi.mock('canonicalize', async (importOriginal) => {
  const original = await importOriginal<typeof CanonicalizeModule>();
  return {
    ...original,
    default: (...args: Parameters<typeof original.default>) => {
      calls.canonicalizations += 1;
      if (calls.canonicalizeError) throw calls.canonicalizeError;
      return original.default(...args);
    },
  };
});

const fixture = JSON.parse(
  readFileSync(
    new URL('../../engine/tests/fixtures/recovery-direct-v1-vector.json', import.meta.url),
    'utf8',
  ),
) as { envelopeCanonical: string };
const encoder = new TextEncoder();

beforeEach(() => {
  calls.begins = 0;
  calls.properties = [];
  calls.literals = 0;
  calls.canonicalizations = 0;
  calls.visitError = null;
  calls.canonicalizeError = null;
});
afterEach(() => vi.restoreAllMocks());

describe('validation error boundaries', () => {
  it('returns a structured rejection for a JSON.parse syntax failure', () => {
    vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw new SyntaxError('untrusted content');
    });
    expect(validateEnvelopeStructureV1(encoder.encode(fixture.envelopeCanonical))).toEqual({
      ok: false,
      code: 'INVALID_ENVELOPE',
    });
  });

  it('propagates unexpected JSON.parse failures', () => {
    const failure = new Error('unexpected parser failure');
    vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => validateEnvelopeStructureV1(encoder.encode(fixture.envelopeCanonical))).toThrow(
      failure,
    );
  });

  it.each(['visitError', 'canonicalizeError'] as const)(
    'does not hide unexpected SyntaxError from %s',
    (source) => {
      const failure = new SyntaxError('unexpected library failure');
      calls[source] = failure;
      expect(() => validateEnvelopeStructureV1(encoder.encode(fixture.envelopeCanonical))).toThrow(
        failure,
      );
    },
  );

  it('does not treat a missing TextDecoder implementation as malformed input', () => {
    vi.stubGlobal('TextDecoder', undefined);
    try {
      expect(() =>
        validateEnvelopeStructureV1(encoder.encode(fixture.envelopeCanonical)),
      ).toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects hostile Unicode and non-finite generation before canonicalization', () => {
    for (const text of [
      fixture.envelopeCanonical.replace('"purpose":"identity-recovery"', '"purpose":"\\ud800"'),
      fixture.envelopeCanonical.replace('"generation":1', '"generation":1e400'),
    ]) {
      expect(validateEnvelopeStructureV1(encoder.encode(text))).toEqual({
        ok: false,
        code: 'INVALID_ENVELOPE',
      });
    }
    expect(calls.canonicalizations).toBe(0);
  });
});

describe('hostile depth interruption', () => {
  it.each([1, 100, 9_000])(
    'stops on the third object without visiting a deeply nested suffix (%i objects)',
    (depth) => {
      const text =
        '{"header":{"account":' + '{"account":'.repeat(depth) + '0' + '}'.repeat(depth + 2);
      const result = validateEnvelopeStructureV1(encoder.encode(text));
      expect(result).toEqual({ ok: false, code: 'LIMIT_EXCEEDED' });
      expect(calls.begins).toBe(3);
      expect(calls.properties).toEqual(['header', 'account']);
      expect(calls.literals).toBe(0);
    },
  );

  it('rejects an array before visiting its elements', () => {
    const text =
      '{"header":{"account":[' + '{"account":'.repeat(100) + '0' + '}'.repeat(100) + ']}}';
    expect(validateEnvelopeStructureV1(encoder.encode(text))).toEqual({
      ok: false,
      code: 'INVALID_ENVELOPE',
    });
    expect(calls.begins).toBe(2);
    expect(calls.properties).toEqual(['header', 'account']);
    expect(calls.literals).toBe(0);
  });

  it('rejects an unknown nested field before visiting its value', () => {
    const text = '{"header":{"unknown":' + '{"account":'.repeat(100) + '0' + '}'.repeat(101) + '}';
    expect(validateEnvelopeStructureV1(encoder.encode(text))).toEqual({
      ok: false,
      code: 'INVALID_ENVELOPE',
    });
    expect(calls.begins).toBe(2);
    expect(calls.properties).toEqual(['header', 'unknown']);
    expect(calls.literals).toBe(0);
  });
});
