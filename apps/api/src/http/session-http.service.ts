import type { SessionState } from '../postgres-session-repository.js';
import { PostgresSessionRepository } from '../postgres-session-repository.js';
import type { Database } from './database.js';

export interface SessionDto {
  readonly accountId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceState: 'pending' | 'authorized';
  readonly expiresAt: string;
}

export function sessionDto(session: SessionState): SessionDto {
  return {
    accountId: session.accountId,
    sessionId: session.id,
    deviceId: session.deviceId,
    deviceState: session.deviceState,
    expiresAt: session.expiresAt.toISOString(),
  };
}

/** A deliberately narrow transport capability; no creation or E2EE operations. */
export class SessionHttpService {
  private readonly repository: PostgresSessionRepository;
  public constructor(database: Database) {
    this.repository = new PostgresSessionRepository(database.client);
  }
  public async authenticate(token: string): Promise<SessionState> {
    return this.repository.validate(token);
  }
  public async revokeCurrent(token: string): Promise<void> {
    await this.repository.revokeCurrent(token);
  }
}
