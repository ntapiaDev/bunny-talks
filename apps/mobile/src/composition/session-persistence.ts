import type { LoginResponse, SessionDto, SessionIdentityDto } from '@bunny-talks/contracts';
import {
  loginResponseSchema,
  sessionDtoSchema,
  sessionIdentityResponseSchema,
  sessionTokenSchema,
} from '@bunny-talks/validation';

export interface SessionSecretStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export interface SessionMetadataStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

type SessionMetadata = {
  readonly version: 1;
  readonly state: 'needs-validation' | 'active' | 'invalid';
  readonly session: SessionIdentityDto | SessionDto;
};

export class SessionPersistenceError extends Error {
  public constructor(
    readonly code: 'INVALID_INPUT' | 'PARTIAL_STATE' | 'CONFLICT' | 'OUTCOME_UNKNOWN',
  ) {
    super(`Session persistence: ${code}`);
    this.name = 'SessionPersistenceError';
  }
}

export type PersistedSession =
  | { readonly status: 'none' }
  | { readonly status: 'partial' }
  | { readonly status: 'expired'; readonly session: SessionIdentityDto | SessionDto }
  | { readonly status: 'invalid'; readonly session: SessionIdentityDto | SessionDto }
  | {
      readonly status: 'needs-validation' | 'active';
      readonly sessionToken: string;
      readonly session: SessionIdentityDto | SessionDto;
    };

function parseMetadata(raw: string): SessionMetadata | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !['needs-validation', 'active', 'invalid'].includes(String(record.state))
  )
    return undefined;
  const parsedSession = sessionDtoSchema.safeParse(record.session);
  const parsedIdentity = sessionIdentityResponseSchema.safeParse(record.session);
  const session = parsedSession.success
    ? parsedSession.data
    : parsedIdentity.success
      ? parsedIdentity.data
      : undefined;
  if (!session || (record.state === 'active' && !parsedSession.success)) return undefined;
  const result = { version: 1 as const, state: record.state as SessionMetadata['state'], session };
  if (JSON.stringify(result) !== raw) return undefined;
  return result;
}

async function writeAndConfirm(
  read: () => Promise<string | null>,
  write: (value: string) => Promise<void>,
  value: string,
): Promise<void> {
  try {
    await write(value);
  } catch {
    // A native write can commit and still report failure; only exact readback resolves it.
  }
  let observed: string | null;
  try {
    observed = await read();
  } catch {
    throw new SessionPersistenceError('OUTCOME_UNKNOWN');
  }
  if (observed !== value) throw new SessionPersistenceError('OUTCOME_UNKNOWN');
}

export function createSessionPersistence(dependencies: {
  readonly secret: SessionSecretStorage;
  readonly metadata: SessionMetadataStorage;
  readonly now?: () => number;
}) {
  if (
    !dependencies ||
    typeof dependencies.secret?.read !== 'function' ||
    typeof dependencies.metadata?.read !== 'function'
  )
    throw new SessionPersistenceError('INVALID_INPUT');
  const now = dependencies.now ?? Date.now;
  let queue = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>) => {
    const result = queue.then(work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const readRaw = async () =>
    Promise.all([dependencies.secret.read(), dependencies.metadata.read()]);

  return {
    saveLogin(response: LoginResponse): Promise<void> {
      return serialize(async () => {
        const parsed = loginResponseSchema.safeParse(response);
        if (!parsed.success) throw new SessionPersistenceError('INVALID_INPUT');
        const [existingSecret, existingMetadata] = await readRaw();
        if (existingSecret !== null || existingMetadata !== null) {
          throw new SessionPersistenceError('CONFLICT');
        }
        await writeAndConfirm(
          dependencies.secret.read,
          dependencies.secret.write,
          parsed.data.sessionToken,
        );
        const metadata = JSON.stringify({
          version: 1,
          state: 'needs-validation',
          session: parsed.data.session,
        } satisfies SessionMetadata);
        await writeAndConfirm(dependencies.metadata.read, dependencies.metadata.write, metadata);
      });
    },
    read(): Promise<PersistedSession> {
      return serialize(async () => {
        const [token, rawMetadata] = await readRaw();
        if (token === null && rawMetadata === null) return { status: 'none' };
        if (token === null || rawMetadata === null) return { status: 'partial' };
        const parsedMetadata = parseMetadata(rawMetadata);
        if (!parsedMetadata || !sessionTokenSchema.safeParse(token).success) {
          return { status: 'partial' };
        }
        if (token.split('.')[1] !== parsedMetadata.session.sessionId) return { status: 'partial' };
        if (parsedMetadata.state === 'invalid') {
          return { status: 'invalid', session: parsedMetadata.session };
        }
        const expiresAt = Date.parse(parsedMetadata.session.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
          return { status: 'expired', session: parsedMetadata.session };
        }
        return {
          status: parsedMetadata.state,
          sessionToken: token,
          session: parsedMetadata.session,
        };
      });
    },
    acceptValidatedSession(dto: SessionDto): Promise<void> {
      return serialize(async () => {
        const parsed = sessionDtoSchema.safeParse(dto);
        const [token, rawMetadata] = await readRaw();
        const previous = rawMetadata === null ? undefined : parseMetadata(rawMetadata);
        if (
          !parsed.success ||
          !previous ||
          previous.state === 'invalid' ||
          token === null ||
          !sessionTokenSchema.safeParse(token).success ||
          token.split('.')[1] !== parsed.data.sessionId ||
          previous.session.sessionId !== parsed.data.sessionId ||
          previous.session.accountId !== parsed.data.accountId ||
          previous.session.deviceId !== parsed.data.deviceId ||
          previous.session.expiresAt !== parsed.data.expiresAt ||
          Date.parse(parsed.data.expiresAt) <= now()
        ) {
          throw new SessionPersistenceError('PARTIAL_STATE');
        }
        const next = JSON.stringify({
          version: 1,
          state: 'active',
          session: parsed.data,
        } satisfies SessionMetadata);
        await writeAndConfirm(dependencies.metadata.read, dependencies.metadata.write, next);
      });
    },
    suspendAfterUnauthorized(): Promise<void> {
      return serialize(async () => {
        const [token, rawMetadata] = await readRaw();
        const previous = rawMetadata === null ? undefined : parseMetadata(rawMetadata);
        if (
          token === null ||
          !sessionTokenSchema.safeParse(token).success ||
          !previous ||
          token.split('.')[1] !== previous.session.sessionId
        ) {
          throw new SessionPersistenceError('PARTIAL_STATE');
        }
        const next = JSON.stringify({ ...previous, state: 'invalid' } satisfies SessionMetadata);
        await writeAndConfirm(dependencies.metadata.read, dependencies.metadata.write, next);
      });
    },
  };
}
