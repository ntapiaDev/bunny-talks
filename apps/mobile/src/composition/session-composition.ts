import type { LoginResponse, SessionDto, SessionIdentityDto } from '@bunny-talks/contracts';
import {
  loginResponseSchema,
  loginSchema,
  sessionDtoSchema,
  sessionIdentityResponseSchema,
  sessionTokenSchema,
} from '@bunny-talks/validation';
import { ApplicationHttpError } from '../infrastructure/http/application-http';
import type { createSessionPersistence, PersistedSession } from './session-persistence';

export type SessionRequest = (input: {
  readonly path: string;
  readonly method: 'GET' | 'POST';
  readonly body?: unknown;
  readonly bearerToken?: string;
  readonly expectedStatuses: readonly number[];
}) => Promise<unknown>;

export class SessionCompositionError extends Error {
  public constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'INVALID_RESPONSE'
      | 'SESSION_MISMATCH'
      | 'SESSION_EXISTS'
      | 'LOGIN_OUTCOME_UNKNOWN'
      | 'SESSION_OWNER_EXISTS'
      | 'OPERATION_BUSY'
      | 'SESSION_INVALID'
      | 'SESSION_VALIDATION_REQUIRED',
  ) {
    super(`Session composition: ${code}`);
    this.name = 'SessionCompositionError';
  }
}

export interface SessionService {
  login(input: unknown): Promise<LoginResponse>;
  read(token: string, expected: SessionIdentityDto | SessionDto): Promise<SessionDto>;
}

/** Composes existing login/session HTTP routes without refreshing or replacing a bearer. */
export function createSessionService(request: SessionRequest): SessionService {
  if (typeof request !== 'function') throw new SessionCompositionError('INVALID_INPUT');
  return {
    async login(input) {
      const parsedInput = loginSchema.safeParse(input);
      if (!parsedInput.success) throw new SessionCompositionError('INVALID_INPUT');
      const response = await request({
        path: '/v1/auth/login',
        method: 'POST',
        body: parsedInput.data,
        expectedStatuses: [201],
      });
      const parsed = loginResponseSchema.safeParse(response);
      if (!parsed.success) throw new SessionCompositionError('INVALID_RESPONSE');
      return parsed.data;
    },
    async read(token, expected) {
      if (!sessionTokenSchema.safeParse(token).success) {
        throw new SessionCompositionError('INVALID_INPUT');
      }
      const expectedSession = sessionDtoSchema.safeParse(expected);
      const expectedIdentity = expectedSession.success
        ? expectedSession.data
        : sessionIdentityResponseSchema.safeParse(expected).data;
      if (!expectedIdentity || token.split('.')[1] !== expectedIdentity.sessionId) {
        throw new SessionCompositionError('INVALID_INPUT');
      }
      const response = await request({
        path: '/v1/session',
        method: 'GET',
        bearerToken: token,
        expectedStatuses: [200],
      });
      const parsed = sessionDtoSchema.safeParse(response);
      if (!parsed.success) throw new SessionCompositionError('INVALID_RESPONSE');
      const session = parsed.data;
      if (
        session.sessionId !== expectedIdentity.sessionId ||
        session.accountId !== expectedIdentity.accountId ||
        session.deviceId !== expectedIdentity.deviceId ||
        session.expiresAt !== expectedIdentity.expiresAt
      ) {
        throw new SessionCompositionError('SESSION_MISMATCH');
      }
      return session;
    },
  };
}

export function isHttpStatus(error: unknown, ...statuses: number[]): boolean {
  return (
    error instanceof ApplicationHttpError &&
    error.kind === 'status' &&
    error.status !== undefined &&
    statuses.includes(error.status)
  );
}

export function isHttpRequestNotSent(error: unknown): boolean {
  return (
    error instanceof ApplicationHttpError &&
    (error.kind === 'request' || error.kind === 'configuration')
  );
}

export interface BootstrapSessionAccess {
  withValidatedSession<T>(
    work: (
      current: Readonly<{ sessionToken: string; session: Readonly<SessionDto> }>,
      requireRevalidation: () => void,
    ) => Promise<T>,
  ): Promise<T>;
}

function withoutBearer(saved: PersistedSession) {
  if (saved.status === 'active' || saved.status === 'needs-validation') {
    return { status: saved.status, session: saved.session };
  }
  return saved;
}

const ownedSessionPersistence = new WeakSet<ReturnType<typeof createSessionPersistence>>();

export function createSessionWorkflow(
  sessions: SessionService,
  persistence: ReturnType<typeof createSessionPersistence>,
) {
  if (ownedSessionPersistence.has(persistence)) {
    throw new SessionCompositionError('SESSION_OWNER_EXISTS');
  }
  ownedSessionPersistence.add(persistence);

  let busy = false;
  async function exclusively<T>(work: () => Promise<T>): Promise<T> {
    if (busy) throw new SessionCompositionError('OPERATION_BUSY');
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  }

  let current: Readonly<{ sessionToken: string; session: Readonly<SessionDto> }> | undefined;
  let requiresValidation = true;
  let invalidSession: Readonly<SessionIdentityDto | SessionDto> | undefined;
  let loginOutcomeUncertain = false;
  const requireRevalidation = () => {
    requiresValidation = true;
  };
  const bootstrapSession: BootstrapSessionAccess = {
    withValidatedSession(work) {
      return exclusively(async () => {
        if (invalidSession) throw new SessionCompositionError('SESSION_INVALID');
        if (requiresValidation || !current || Date.parse(current.session.expiresAt) <= Date.now()) {
          throw new SessionCompositionError('SESSION_VALIDATION_REQUIRED');
        }
        return work(current, requireRevalidation);
      });
    },
  };

  return {
    bootstrapSession,
    async login(input: unknown) {
      const parsed = loginSchema.safeParse(input);
      if (!parsed.success) throw new SessionCompositionError('INVALID_INPUT');
      return exclusively(async () => {
        if (invalidSession) throw new SessionCompositionError('SESSION_EXISTS');
        const existing = await persistence.read();
        if (existing.status !== 'none') throw new SessionCompositionError('SESSION_EXISTS');
        if (loginOutcomeUncertain) throw new SessionCompositionError('LOGIN_OUTCOME_UNKNOWN');
        loginOutcomeUncertain = true;
        let response: LoginResponse;
        try {
          response = await sessions.login(parsed.data);
        } catch (error) {
          // These login statuses are produced before session creation or after a refused transaction.
          if (
            isHttpRequestNotSent(error) ||
            isHttpStatus(error, 400, 401, 404, 405, 413, 415, 429)
          ) {
            loginOutcomeUncertain = false;
          }
          throw error;
        }
        await persistence.saveLogin(response);
        const saved = await persistence.read();
        if (saved.status === 'needs-validation' && saved.sessionToken === response.sessionToken) {
          loginOutcomeUncertain = false;
        }
        return withoutBearer(saved);
      });
    },
    validateCurrent() {
      return exclusively(async () => {
        requireRevalidation();
        if (invalidSession) return { status: 'invalid' as const, session: invalidSession };
        const saved = await persistence.read();
        if (saved.status === 'invalid') {
          invalidSession = Object.freeze({ ...saved.session });
          current = undefined;
        }
        if (saved.status !== 'needs-validation' && saved.status !== 'active') {
          return withoutBearer(saved);
        }
        if (current && current.sessionToken !== saved.sessionToken) {
          throw new SessionCompositionError('SESSION_MISMATCH');
        }
        let dto: SessionDto;
        try {
          dto = { ...(await sessions.read(saved.sessionToken, saved.session)) };
        } catch (error) {
          if (!isHttpStatus(error, 401)) throw error;
          invalidSession = Object.freeze({ ...saved.session });
          current = undefined;
          await persistence.suspendAfterUnauthorized().catch(() => undefined);
          return { status: 'invalid' as const, session: invalidSession };
        }
        await persistence.acceptValidatedSession(dto);
        const accepted = await persistence.read();
        if (
          accepted.status !== 'active' ||
          accepted.sessionToken !== saved.sessionToken ||
          JSON.stringify(accepted.session) !== JSON.stringify(dto)
        ) {
          throw new SessionCompositionError('SESSION_MISMATCH');
        }
        current = Object.freeze({
          sessionToken: saved.sessionToken,
          session: Object.freeze(dto),
        });
        requiresValidation = false;
        return withoutBearer(accepted);
      });
    },
  };
}
