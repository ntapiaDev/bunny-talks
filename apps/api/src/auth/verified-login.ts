import { AuthenticationError } from './authentication-error.js';
import { validatePasswordVerifier, verifyPassword } from './password-verifier.js';

export interface LoginCredential {
  readonly accountId: string;
  readonly canonical: string;
  readonly verifiedAtMs: number;
  readonly verifier: string;
  readonly revision: bigint;
  readonly verifierUpdatedAtMs: number | null;
}

// Only the successful verification branch may register a proof. Constructor/prototype identity
// and caller-controlled properties are never evidence of authentication.
const verifiedCredentials = new WeakMap<object, LoginCredential>();

export function requireVerifiedLogin(proof: unknown): LoginCredential {
  const credential =
    typeof proof === 'object' && proof !== null ? verifiedCredentials.get(proof) : undefined;
  if (!credential) throw new AuthenticationError('INVALID_CREDENTIALS');
  return credential;
}

// Generated once with createPasswordVerifier and the current server profile.
// Public fixture password: "public dummy login verifier v1". Matching it never authenticates.
export const dummyLoginVerifier =
  '$argon2id$v=19$m=19456,t=2,p=1$F83okHiW1R2mnT6aTbmDuw$JxHRLtT5qz0cFGGNfNuaPvu7Wau0iX3BZcwtnR/zmmc';

/** Only successful real password verification registers an authentic runtime capability. */
export class VerifiedLogin {
  readonly #credential: LoginCredential;
  private constructor(credential: LoginCredential) {
    this.#credential = Object.freeze({ ...credential });
  }
  public get credential(): LoginCredential {
    return requireVerifiedLogin(this);
  }

  public static async verify(
    password: string,
    credential: LoginCredential | null,
  ): Promise<VerifiedLogin | undefined> {
    const snapshot = credential === null ? null : Object.freeze({ ...credential });
    const usable =
      snapshot !== null &&
      snapshot.revision > 0n &&
      Number.isFinite(snapshot.verifiedAtMs) &&
      snapshot.verifiedAtMs <= Date.now() &&
      validatePasswordVerifier(snapshot.verifier);
    const matches = await verifyPassword(password, usable ? snapshot.verifier : dummyLoginVerifier);
    if (usable && matches) {
      const proof = new VerifiedLogin(snapshot);
      verifiedCredentials.set(proof, proof.#credential);
      Object.freeze(proof);
      return proof;
    }
    return undefined;
  }
}
