import { beforeAll, describe, expect, it } from 'vitest';
import { createPasswordVerifier } from '../../../src/auth/password-verifier.js';
import type { LoginCredential } from '../../../src/auth/verified-login.js';
import { requireVerifiedLogin, VerifiedLogin } from '../../../src/auth/verified-login.js';

describe('runtime password verification capability', () => {
  let credential: LoginCredential;
  let proof: VerifiedLogin;
  const password = 'runtime proof password';
  beforeAll(async () => {
    credential = {
      accountId: 'account-a',
      canonical: 'a@example.com',
      verifiedAtMs: 1,
      verifier: await createPasswordVerifier(password),
      revision: 1n,
      verifierUpdatedAtMs: 1,
    };
    proof = (await VerifiedLogin.verify(password, credential))!;
  });

  it('accepts a real Argon2id success and exposes only its immutable snapshot', () => {
    expect(requireVerifiedLogin(proof)).toEqual(credential);
    expect(proof.credential).toBe(requireVerifiedLogin(proof));
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.credential)).toBe(true);
    expect(Reflect.set(proof.credential, 'accountId', 'account-b')).toBe(false);
    expect(
      Reflect.defineProperty(proof, 'credential', {
        value: { ...credential, accountId: 'account-b' },
      }),
    ).toBe(false);
    expect(requireVerifiedLogin(proof).accountId).toBe('account-a');
  });
  it('never issues a proof after an incorrect real password verification', async () => {
    expect(await VerifiedLogin.verify('incorrect password', credential)).toBeUndefined();
    expect(() => requireVerifiedLogin(undefined)).toThrow('INVALID_CREDENTIALS');
  });
  it.each([
    'structural',
    'created-prototype',
    'replaced-prototype',
    'direct-constructor',
    'inherited-proof',
    'proxy',
  ])('rejects a %s forgery regardless of its fields or prototype', (kind) => {
    const forged: unknown =
      kind === 'structural'
        ? { credential }
        : kind === 'created-prototype'
          ? Object.create(VerifiedLogin.prototype)
          : kind === 'replaced-prototype'
            ? Object.setPrototypeOf({ credential }, VerifiedLogin.prototype)
            : kind === 'direct-constructor'
              ? Reflect.construct(VerifiedLogin, [credential])
              : kind === 'inherited-proof'
                ? Object.create(proof)
                : new Proxy(proof, {});
    expect(() => requireVerifiedLogin(forged)).toThrow('INVALID_CREDENTIALS');
  });
  it('does not evaluate a forged credential getter while checking provenance', () => {
    let reads = 0;
    const forged = {
      get credential() {
        reads++;
        return credential;
      },
    };
    expect(() => requireVerifiedLogin(forged)).toThrow('INVALID_CREDENTIALS');
    expect(reads).toBe(0);
  });
  it('prevents prototype replacement on an authentic frozen proof', () => {
    expect(() =>
      Object.setPrototypeOf(proof, { credential: { ...credential, accountId: 'account-b' } }),
    ).toThrow(TypeError);
    expect(requireVerifiedLogin(proof).accountId).toBe('account-a');
  });
});
