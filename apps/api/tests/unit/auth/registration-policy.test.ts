import { describe, expect, it } from 'vitest';
import {
  checkRegistrationPassword,
  validateRegistrationPassword,
} from '../../../src/auth/registration/registration-policy.js';

describe('registration password policy', () => {
  it.each([
    'a'.repeat(15),
    ' '.repeat(15),
    '😀'.repeat(15),
    'é'.repeat(15),
    'e\u0301'.repeat(8),
    'a'.repeat(1024),
    '😀'.repeat(256),
    '\0'.repeat(15),
  ])('accepts valid exact vault UTF-8 input', (value) => {
    expect(() => validateRegistrationPassword(value)).not.toThrow();
  });
  it.each([
    '',
    'a'.repeat(14),
    '😀'.repeat(14),
    'a'.repeat(1025),
    '😀'.repeat(257),
    'a'.repeat(15) + '\ud800',
  ])('rejects invalid lengths and ill-formed Unicode', (value) => {
    expect(() => validateRegistrationPassword(value)).toThrow('INVALID_PASSWORD');
  });
  it('passes the full unmodified password to the blocklist and fails closed', async () => {
    const password = '  e\u0301 full password  ';
    let observed: string | undefined;
    await checkRegistrationPassword(password, {
      async isBlocked(value) {
        observed = value;
        return false;
      },
    });
    expect(observed).toBe(password);
    await expect(checkRegistrationPassword(password)).rejects.toThrow('POLICY_UNAVAILABLE');
    await expect(
      checkRegistrationPassword(password, {
        async isBlocked() {
          throw new Error('private detail');
        },
      }),
    ).rejects.toMatchObject({ message: 'POLICY_UNAVAILABLE' });
    await expect(
      checkRegistrationPassword(password, {
        async isBlocked() {
          return true;
        },
      }),
    ).rejects.toThrow('BLOCKED_PASSWORD');
  });
});
