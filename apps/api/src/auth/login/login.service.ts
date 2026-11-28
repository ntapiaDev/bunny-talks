import type { LoginInput } from '@bunny-talks/validation';
import { canonicalizeLoginEmail } from '@bunny-talks/validation';
import { AuthenticationError } from '../authentication-error.js';
import { PasswordVerifierError } from '../password-verifier.js';
import type { PostgresSessionRepository } from '../sessions/postgres-session-repository.js';
import { sessionIdentityDto } from '../sessions/session-http.service.js';
import { SessionError } from '../sessions/session-token.js';
import { VerifiedLogin } from '../verified-login.js';
import type { LoginConfig } from './login-config.js';
import type { PostgresLoginCredentials } from './postgres-login-credentials.js';
import type { PostgresLoginLimits } from './postgres-login-limits.js';

interface Dependencies {
  readonly config: LoginConfig;
  readonly credentials: Pick<PostgresLoginCredentials, 'find'>;
  readonly limits: Pick<PostgresLoginLimits, 'admit' | 'acquire' | 'cleanup'>;
  readonly sessions: Pick<PostgresSessionRepository, 'createAfterLogin'>;
}

/** Orchestrates admission, unlocked password computation, and atomic session creation. */
export class LoginService {
  public constructor(private readonly dependencies?: Dependencies) {}

  public async login(input: LoginInput, source: string) {
    if (!this.dependencies) throw new AuthenticationError('UNAVAILABLE');
    const { config, credentials, limits, sessions } = this.dependencies;
    const { canonical } = canonicalizeLoginEmail(input.email);
    try {
      await limits.admit(source, canonical);
      await limits.cleanup();
      const lease = await limits.acquire();
      try {
        const verified = await VerifiedLogin.verify(
          input.password,
          await credentials.find(canonical),
        );
        if (!verified) throw new AuthenticationError('INVALID_CREDENTIALS');
        const created = await sessions.createAfterLogin(
          verified,
          lease.id,
          config.maximumRecordsPerAccount,
        );
        return { sessionToken: created.token, session: sessionIdentityDto(created.session) };
      } finally {
        await lease.release();
      }
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      if (error instanceof PasswordVerifierError) {
        throw new AuthenticationError(error.code === 'BUSY' ? 'BUSY' : 'CRYPTO_UNAVAILABLE');
      }
      if (error instanceof SessionError) {
        throw new AuthenticationError(
          error.code === 'INVALID_SESSION'
            ? 'INVALID_CREDENTIALS'
            : error.code === 'OUTCOME_UNKNOWN'
              ? 'OUTCOME_UNKNOWN'
              : 'UNAVAILABLE',
        );
      }
      throw new AuthenticationError('UNAVAILABLE');
    }
  }
}
