import { describe, expect, it } from 'vitest';
import {
  canonicalizeLoginEmail,
  emailSchema,
  loginEmailSchema,
} from '../src/schemas/email.schema.js';

describe('emailSchema', () => {
  it('accepts a valid email address', () => {
    expect(emailSchema.safeParse('user@example.com').success).toBe(true);
  });

  it('rejects an invalid email address', () => {
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
  });

  it('rejects an empty value', () => {
    expect(emailSchema.safeParse('').success).toBe(false);
  });
});

describe('V1 login email identity', () => {
  it('folds ASCII case and retains display spelling', () => {
    expect(canonicalizeLoginEmail('Alice.Name+tag@EXAMPLE.COM')).toEqual({
      display: 'Alice.Name+tag@EXAMPLE.COM',
      canonical: 'alice.name+tag@example.com',
    });
    const variants = [
      'alice@example.com',
      'Alice@example.com',
      'a.lice@example.com',
      'alice+tag@example.com',
    ];
    expect(new Set(variants.map((v) => canonicalizeLoginEmail(v).canonical)).size).toBe(3);
    expect(
      ['Alice@Example.com', 'alice@example.com', 'ALICE@EXAMPLE.COM'].map(
        (v) => canonicalizeLoginEmail(v).canonical,
      ),
    ).toEqual(['alice@example.com', 'alice@example.com', 'alice@example.com']);
  });
  it('accepts exactly 254 ASCII octets and refuses 255', () => {
    const address =
      'a'.repeat(64) + '@' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(57) + '.com';
    expect(address).toHaveLength(254);
    expect(loginEmailSchema.safeParse(address).success).toBe(true);
    expect(loginEmailSchema.safeParse(address.replace('.com', '.comm')).success).toBe(false);
  });
  it.each([
    null,
    '',
    'a',
    ' a@example.com',
    'a@example.com ',
    'a..b@example.com',
    'a@-domain.com',
    'a@domain-.com',
    'a@localhost',
    'a@exam_ple.com',
    'é@example.com',
    'a@éxample.com',
    'a＠example.com',
    '"a"@example.com',
    'a@example.com\n',
    'a'.repeat(65) + '@example.com',
    'a@' + 'b'.repeat(64) + '.com',
    'a@' + ('b'.repeat(63) + '.').repeat(4) + 'com',
  ])('rejects unsupported or ambiguous input %j', (value) => {
    expect(loginEmailSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    "o'connor@example.com",
    'a+b@example.com',
    'a_b@sub.example.com',
    'a-b@example.com',
    'a@xn--bcher-kva.de',
    'a'.repeat(64) + '@example.com',
  ])('accepts %s without provider heuristics', (value) => {
    expect(loginEmailSchema.safeParse(value).success).toBe(true);
  });
});
