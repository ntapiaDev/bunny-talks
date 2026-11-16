import { describe, expect, it } from 'vitest';
import {
  createPasswordVerifier,
  validatePasswordVerifier,
  verifyPassword,
} from '../../../src/auth/password-verifier.js';

describe('native Argon2id integration', () => {
  it('matches an independent Noble Argon2id result for the exact profile', async () => {
    const verifier =
      '$argon2id$v=19$m=19456,t=2,p=1$AAECAwQFBgcICQoLDA0ODw$uhCypLIURHvvp2fsFoGNBT11OfBhnMToZHZ34scn258';
    await expect(verifyPassword('test-password', verifier)).resolves.toBe(true);
  });

  it('creates independent salts and verifies exact passwords', async () => {
    const password = ' é\0 e\u0301 ';
    const first = await createPasswordVerifier(password);
    const second = await createPasswordVerifier(password);
    expect(validatePasswordVerifier(first)).toBe(true);
    expect(first.split('$')[4]).not.toBe(second.split('$')[4]);
    await expect(verifyPassword(password, first)).resolves.toBe(true);
    await expect(verifyPassword(' e\u0301\0 e\u0301 ', first)).resolves.toBe(false);
    await expect(verifyPassword(password.trim(), first)).resolves.toBe(false);
  });
});
