import { describe, expect, it } from 'vitest';
import { loginSchema } from '../src/index.js';

describe('strict login input', () => {
  it('preserves exact UTF-8, whitespace, case and decomposed Unicode', () => {
    const input = { email: 'Alice@Example.com', password: '  e\u0301 😀 A  ' };
    expect(loginSchema.parse(input)).toEqual(input);
    expect(loginSchema.parse({ ...input, password: 'x' }).password).toBe('x');
  });
  it.each(['', '\ud800', '😀'.repeat(257), 'é'.repeat(513), 'x'.repeat(1025)])(
    'rejects invalid encoding/size %#',
    (password) => {
      expect(loginSchema.safeParse({ email: 'a@example.com', password }).success).toBe(false);
    },
  );
  it.each(['x'.repeat(1024), '😀'.repeat(256), 'é'.repeat(512)])(
    'accepts the byte boundary %#',
    (password) => {
      expect(loginSchema.safeParse({ email: 'a@example.com', password }).success).toBe(true);
    },
  );
  it.each([
    null,
    [],
    {},
    { email: 3, password: 'x' },
    { email: 'é@example.com', password: 'x' },
    { email: 'a@example.com', password: 3 },
  ])('rejects invalid types/email %#', (input) => {
    expect(loginSchema.safeParse(input).success).toBe(false);
  });
  it.each([
    'accountId',
    'deviceId',
    'sessionId',
    'authorizedAt',
    'emailVerified',
    'credentialRevision',
    'sessionToken',
  ])('rejects %s', (field) => {
    expect(
      loginSchema.safeParse({ email: 'a@example.com', password: 'x', [field]: 'chosen' }).success,
    ).toBe(false);
  });
});
