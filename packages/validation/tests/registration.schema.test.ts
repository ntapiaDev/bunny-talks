import { describe, expect, it } from 'vitest';
import { registrationCompleteSchema, registrationRequestSchema } from '../src/index.js';

describe('strict registration HTTP bodies', () => {
  const input = {
    email: 'Alice+tag@EXAMPLE.COM',
    token: 'e1.proof',
    password: '  exact e\u0301 😀 password  ',
  };
  it('preserves the original email and exact password without canonicalizing transport data', () => {
    expect(registrationCompleteSchema.parse(input)).toEqual(input);
    expect(registrationRequestSchema.parse({ email: input.email })).toEqual({ email: input.email });
  });
  it.each(['accountId', 'emailVerified', 'verifier', 'deviceId', 'extra'])(
    'rejects privileged or unexpected property %s',
    (key) => {
      expect(registrationCompleteSchema.safeParse({ ...input, [key]: 'untrusted' }).success).toBe(
        false,
      );
      expect(registrationRequestSchema.safeParse({ email: input.email, [key]: true }).success).toBe(
        false,
      );
    },
  );
  it.each([
    null,
    [],
    'text',
    {},
    { email: 42 },
    { email: 'é@example.com' },
    { email: ' Alice@example.com' },
  ])('rejects malformed request %#', (body) => {
    expect(registrationRequestSchema.safeParse(body).success).toBe(false);
  });
  it.each([
    { token: 42 },
    { token: '' },
    { token: 'x'.repeat(129) },
    { password: 42 },
    { password: 'x'.repeat(1025) },
  ])('bounds completion fields %#', (override) => {
    expect(registrationCompleteSchema.safeParse({ ...input, ...override }).success).toBe(false);
  });
});
