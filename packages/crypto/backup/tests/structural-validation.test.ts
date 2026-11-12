import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateEnvelopeStructureV1 } from '../src/index.js';

const encoder = new TextEncoder();
const vector = JSON.parse(
  readFileSync(
    new URL('../../engine/tests/fixtures/recovery-direct-v1-vector.json', import.meta.url),
    'utf8',
  ),
) as { envelopeCanonical: string };
const valid = vector.envelopeCanonical;
const parsed = () => JSON.parse(valid) as { ciphertext: string; header: Record<string, unknown> };
const check = (text: string) => validateEnvelopeStructureV1(encoder.encode(text));

describe('structural envelope validation V1', () => {
  it('accepts the CRYPTO-008 vector without claiming authentication', () => {
    const input = encoder.encode(valid);
    const original = input.slice();
    const result = validateEnvelopeStructureV1(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected valid fixture');
    expect(result.envelope.status).toBe('structural-only-unauthenticated');
    expect(result.envelope.header.generation).toBe(1);
    expect(Object.isFrozen(result.envelope)).toBe(true);
    expect(Object.isFrozen(result.envelope.header)).toBe(true);
    expect(input).toEqual(original);
    input.fill(0);
    expect(result.envelope.ciphertext).toBe(parsed().ciphertext);
  });

  it('accepts structurally valid data even if ciphertext was modified', () => {
    const value = parsed();
    value.ciphertext = `A${value.ciphertext.slice(1)}`;
    expect(check(JSON.stringify(value)).ok).toBe(true);
  });

  it('uses literal JSON escape bytes for the duplicate and surrogate fixtures', () => {
    const duplicate = valid.replace(
      '"account":',
      '"acc\\u006funt":"AAECAwQFBgcICQoLDA0ODw","account":',
    );
    const surrogate = valid.replace('"purpose":"identity-recovery"', '"purpose":"\\ud800"');
    expect(Buffer.from(duplicate).includes(Buffer.from(String.raw`"acc\u006funt"`))).toBe(true);
    expect(Buffer.from(surrogate).includes(Buffer.from(String.raw`"\ud800"`))).toBe(true);
    expect(check(duplicate)).toEqual({ ok: false, code: 'INVALID_ENVELOPE' });
    expect(check(surrogate)).toEqual({ ok: false, code: 'INVALID_ENVELOPE' });
  });

  it.each([
    valid.replace('"ciphertext":', '"missing":'),
    valid.replace('"header":', '"unexpected":'),
    valid.replace('"generation":1,', ''),
    valid.replace('"account":', '"extra":1,"account":'),
    valid.replace('"account":', '"account":"AAECAwQFBgcICQoLDA0ODw","account":'),
    valid.replace('"account":', '"acc\\u006funt":"AAECAwQFBgcICQoLDA0ODw","account":'),
    valid.replace('"account":', '/* comment */"account":'),
    valid.replace('"version":1}', '"version":1,}'),
    valid.slice(0, -1),
    '[]',
    'null',
    '',
    ` ${valid}`,
    valid.replace('"version":1', '"version":1.0'),
    valid.replace('"account":', '"acc\\u006funt":'),
    valid.replace('"purpose":"identity-recovery"', '"purpose":"\\ud800"'),
    valid.replace('"generation":1', '"generation":0'),
    valid.replace('"generation":1', '"generation":-1'),
    valid.replace('"generation":1', '"generation":9007199254740992'),
    valid.replace('"generation":1', '"generation":1.5'),
    valid.replace('"generation":1', '"generation":"1"'),
    valid.replace('"purpose":"identity-recovery"', '"purpose":"other"'),
    valid.replace('"account":"AAECAwQFBgcICQoLDA0ODw"', '"account":"AAECAwQFBgcICQoLDA0ODx"'),
    valid.replace('"salt":"AAECAwQFBgcICQoLDA0ODw"', '"salt":"AAECAwQFBgcICQoLDA0ODw="'),
    valid.replace(
      '"nonce":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYX"',
      '"nonce":"AAECAwQFBgcICQoLDA0ODxAREhMUFRY"',
    ),
    valid.replace(/"ciphertext":"[^"]+"/, '"ciphertext":"AA"'),
  ])('rejects malformed or noncanonical input %#', (input) => {
    expect(check(input).ok).toBe(false);
  });

  it.each([
    valid.replace('"version":1', '"version":2'),
    valid.replace('"format":"bunny-recovery-vault-direct"', '"format":"other"'),
    valid.replace('"profile":"hkdf-sha256-xchacha20poly1305-v1"', '"profile":"other"'),
  ])('rejects an unsupported format %#', (input) => {
    expect(check(input)).toEqual({ ok: false, code: 'UNSUPPORTED_FORMAT' });
  });

  it('rejects malformed UTF-8 and BOM', () => {
    expect(validateEnvelopeStructureV1(Uint8Array.of(0xc3, 0x28)).ok).toBe(false);
    const original = encoder.encode(valid);
    const bom = new Uint8Array(original.length + 3);
    bom.set([0xef, 0xbb, 0xbf]);
    bom.set(original, 3);
    expect(validateEnvelopeStructureV1(bom).ok).toBe(false);
  });

  it.each([
    valid.replace('"purpose":"identity-recovery"', '"purpose":"\\uZZZZ"'),
    valid.replace('"purpose":"identity-recovery"', '"purpose":"line\nbreak"'),
    valid.replace('"generation":1', '"generation":1e400'),
    valid.replace('"generation":1', '"generation":-1e400'),
  ])('returns a structured error for a hostile token %#', (input) => {
    expect(check(input)).toEqual({ ok: false, code: 'INVALID_ENVELOPE' });
  });

  it('rejects input above the byte limit before decoding', () => {
    expect(validateEnvelopeStructureV1(new Uint8Array(131_073))).toEqual({
      ok: false,
      code: 'LIMIT_EXCEEDED',
    });
    expect(validateEnvelopeStructureV1(new Uint8Array(131_072)).ok).toBe(false);
  });

  it('accepts the maximum ciphertext and rejects one byte more', () => {
    const value = parsed();
    value.ciphertext = Buffer.alloc(65_552).toString('base64url');
    expect(check(JSON.stringify(value)).ok).toBe(true);
    value.ciphertext = Buffer.alloc(65_553).toString('base64url');
    expect(check(JSON.stringify(value)).ok).toBe(false);
  });

  it('accepts only canonical final Base64url bits for a 16-byte account', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const value = parsed();
    for (let index = 0; index < alphabet.length; index += 1) {
      value.header.account = `AAECAwQFBgcICQoLDA0OD${alphabet[index]}`;
      expect(check(JSON.stringify(value)).ok).toBe(index % 16 === 0);
    }
  });

  it('rejects very deep input before visiting nested contents', () => {
    const deep = '{"header":{"account":' + '{"account":'.repeat(9_000) + '{}' + '}'.repeat(9_002);
    expect(check(deep)).toEqual({ ok: false, code: 'LIMIT_EXCEEDED' });
  });
});
