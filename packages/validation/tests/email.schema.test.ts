import { describe, expect, it } from 'vitest';

import { emailSchema } from '../src/schemas/email.schema.js';

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
