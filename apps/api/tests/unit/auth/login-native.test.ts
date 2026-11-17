import { expect, it } from 'vitest';
import { validatePasswordVerifier, verifyPassword } from '../../../src/auth/password-verifier.js';
import { dummyLoginVerifier, VerifiedLogin } from '../../../src/auth/verified-login.js';

it('uses a valid current-cost dummy PHC without authenticating even its known matching password', async () => {
  expect(validatePasswordVerifier(dummyLoginVerifier)).toBe(true);
  expect(await verifyPassword('public dummy login verifier v1', dummyLoginVerifier)).toBe(true);
  expect(await verifyPassword('wrong password', dummyLoginVerifier)).toBe(false);
  expect(await VerifiedLogin.verify('public dummy login verifier v1', null)).toBeUndefined();
});
