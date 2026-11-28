import type { SessionDto, SessionIdentityDto } from '@bunny-talks/contracts';
import type {
  PostgresSessionRepository,
  SessionCredentialSnapshot,
  SessionState,
} from './postgres-session-repository.js';

export function sessionIdentityDto(session: SessionState): SessionIdentityDto {
  return {
    accountId: session.accountId,
    sessionId: session.id,
    deviceId: session.deviceId,
    deviceState: session.deviceState,
    expiresAt: session.expiresAt.toISOString(),
  };
}

export function sessionDto(snapshot: SessionCredentialSnapshot): SessionDto {
  return {
    ...sessionIdentityDto(snapshot.session),
    credentialRevision: snapshot.credentialRevision,
  };
}

/** A deliberately narrow transport capability; no creation or E2EE operations. */
export class SessionHttpService {
  public constructor(
    private readonly repository: Pick<
      PostgresSessionRepository,
      'validate' | 'readWithCredentialRevision' | 'revokeCurrent'
    >,
  ) {}
  public async authenticate(token: string): Promise<SessionState> {
    return this.repository.validate(token);
  }
  public async read(token: string): Promise<SessionDto> {
    return sessionDto(await this.repository.readWithCredentialRevision(token));
  }
  public async revokeCurrent(token: string): Promise<void> {
    await this.repository.revokeCurrent(token);
  }
}
