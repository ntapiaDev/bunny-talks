import type { Prisma, PrismaClient, Session } from '../../../generated/prisma/client.js';
import { AuthenticationError } from '../authentication-error.js';
import type { LoginCredential, VerifiedLogin } from '../verified-login.js';
import { requireVerifiedLogin } from '../verified-login.js';
import { requireSessionInTransaction } from './session-authentication.js';
import { sessionIsActive } from './session-lifecycle.js';
import {
  generateDeviceId,
  generateSessionToken,
  parseSessionToken,
  SessionError,
  uuidPattern,
} from './session-token.js';

export { sessionIsActive } from './session-lifecycle.js';

export interface SessionPolicy {
  readonly absoluteMs: number;
  readonly idleMs: number | null;
}
const day = 86_400_000;
const defaultPolicy: SessionPolicy = { absoluteMs: 30 * day, idleMs: 7 * day };
export interface SessionState {
  readonly id: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
  readonly deviceState: 'pending' | 'authorized';
}
export interface SessionCredentialSnapshot {
  readonly session: SessionState;
  readonly credentialRevision: string;
}
function state(row: Session, authorizedAt: Date | null): SessionState {
  return {
    id: row.id,
    accountId: row.accountId,
    deviceId: row.deviceId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
    deviceState: authorizedAt ? 'authorized' : 'pending',
  };
}
/** Trusted infrastructure only. Never expose this repository as an HTTP controller. */
export class PostgresSessionRepository {
  private readonly policy: SessionPolicy;
  public constructor(
    private readonly client: PrismaClient,
    policy: SessionPolicy = defaultPolicy,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (
      !Number.isSafeInteger(policy.absoluteMs) ||
      policy.absoluteMs <= 0 ||
      policy.absoluteMs > 90 * day ||
      (policy.idleMs !== null &&
        (!Number.isSafeInteger(policy.idleMs) ||
          policy.idleMs <= 0 ||
          policy.idleMs > Math.min(policy.absoluteMs, 2_147_483_647)))
    )
      throw new SessionError('INVALID_INPUT');
    this.policy = { ...policy };
  }
  private now(): Date {
    const now = new Date(this.clock().getTime());
    if (!Number.isFinite(now.getTime())) throw new SessionError('UNAVAILABLE');
    return now;
  }
  private async locked<T>(
    accountId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('lock_timeout', '1000ms', true), set_config('statement_timeout', '3000ms', true)`;
          const rows = await tx.$queryRaw<
            { id: string }[]
          >`SELECT "id" FROM "Account" WHERE "id" = ${accountId} FOR UPDATE`;
          if (rows.length !== 1) throw new SessionError('INVALID_SESSION');
          return work(tx);
        },
        { isolationLevel: 'ReadCommitted', maxWait: 2000, timeout: 5000 },
      );
    } catch (error) {
      if (error instanceof SessionError || error instanceof AuthenticationError) throw error;
      throw new SessionError('OUTCOME_UNKNOWN');
    }
  }

  /** Caller must have verified the password and bound the device to that login.
   * accountId is a storage selector, never evidence of authentication.
   * Reuse requires an independently verified binding to this login context.
   * A client-supplied device ID and knowledge of the password do not prove that binding.
   * Omit deviceId for a new pending device. No device proof is implemented here.
   */
  public async createAfterAuthentication(
    accountId: string,
    deviceId?: string,
  ): Promise<{ token: string; session: SessionState }> {
    return this.create(accountId, deviceId);
  }

  /** No client device selector; proof can only originate from actual password verification. */
  public async createAfterLogin(
    verified: VerifiedLogin,
    leaseId: string,
    maximumRecords: number,
  ): Promise<{ token: string; session: SessionState }> {
    const credential = requireVerifiedLogin(verified);
    if (!uuidPattern.test(leaseId) || !Number.isSafeInteger(maximumRecords) || maximumRecords < 1)
      throw new SessionError('INVALID_INPUT');
    return this.create(credential.accountId, undefined, {
      credential,
      leaseId,
      maximumRecords,
    });
  }

  private async create(
    accountId: string,
    deviceId?: string,
    login?: { credential: LoginCredential; leaseId: string; maximumRecords: number },
  ): Promise<{ token: string; session: SessionState }> {
    if (
      !/^[!-~]{1,128}$/.test(accountId) ||
      (deviceId !== undefined && !uuidPattern.test(deviceId))
    )
      throw new SessionError('INVALID_INPUT');
    const generated = generateSessionToken();
    try {
      const newDeviceId = deviceId === undefined ? generateDeviceId() : undefined;
      if (newDeviceId === generated.id) throw new SessionError('UNAVAILABLE');
      return await this.locked(accountId, async (tx) => {
        const now = this.now();
        if (login) {
          const before = login.credential;
          const identity = await tx.emailIdentity.findUnique({ where: { accountId } });
          const credential = await tx.passwordCredential.findUnique({ where: { accountId } });
          if (
            !identity ||
            !credential ||
            identity.canonical !== before.canonical ||
            identity.verifiedAt.getTime() !== before.verifiedAtMs ||
            identity.verifiedAt > now ||
            credential.verifier !== before.verifier ||
            credential.revision !== before.revision ||
            (credential.verifierUpdatedAt?.getTime() ?? null) !== before.verifierUpdatedAtMs
          )
            throw new AuthenticationError('INVALID_CREDENTIALS');
          // Expired owners cannot publish a session, even if their native calculation resumes.
          const leases = await tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "LoginLease" WHERE "id" = ${login.leaseId}::uuid
              AND "expiresAt" > clock_timestamp() FOR UPDATE`;
          if (leases.length !== 1) throw new AuthenticationError('BUSY');
          // Preserve audit/history: cap all retained records rather than deleting referenced ones.
          if (
            (await tx.session.count({ where: { accountId } })) >= login.maximumRecords ||
            (await tx.device.count({ where: { accountId } })) >= login.maximumRecords
          )
            throw new AuthenticationError('RATE_LIMITED');
        }
        const device =
          deviceId === undefined
            ? await tx.device.create({ data: { id: newDeviceId!, accountId } })
            : await tx.device.findUnique({ where: { accountId_id: { accountId, id: deviceId } } });
        if (!device || device.revokedAt) throw new SessionError('INVALID_SESSION');
        const row = await tx.session.create({
          data: {
            id: generated.id,
            accountId,
            deviceId: device.id,
            tokenHash: Uint8Array.from(generated.hash),
            createdAt: now,
            lastSeenAt: now,
            expiresAt: new Date(now.getTime() + this.policy.absoluteMs),
            idleTimeoutMs: this.policy.idleMs,
          },
        });
        return { token: generated.token, session: state(row, device.authorizedAt) };
      });
    } finally {
      generated.hash.fill(0);
    }
  }

  private async authenticated<T>(
    token: unknown,
    work: (
      tx: Prisma.TransactionClient,
      row: Session,
      authorizedAt: Date | null,
      now: Date,
    ) => Promise<T>,
  ): Promise<T> {
    const parsed = parseSessionToken(token);
    try {
      // Lookup only chooses the lock; all authentication decisions are repeated under it.
      const selector = await this.client.session.findUnique({
        where: { id: parsed.id },
        select: { accountId: true },
      });
      if (!selector) throw new SessionError('INVALID_SESSION');
      return await this.locked(selector.accountId, async (tx) => {
        const now = this.now();
        const row = await requireSessionInTransaction(tx, selector.accountId, parsed, now);
        return work(tx, row, row.device.authorizedAt, now);
      });
    } catch (error) {
      if (error instanceof SessionError || error instanceof AuthenticationError) throw error;
      throw new SessionError('UNAVAILABLE');
    } finally {
      parsed.hash.fill(0);
    }
  }
  /** Successful use advances inactivity only, never absolute expiration. */
  public async validate(token: unknown): Promise<SessionState> {
    return this.authenticated(token, async (tx, row, authorizedAt, now) => {
      const updated = await tx.session.update({ where: { id: row.id }, data: { lastSeenAt: now } });
      return state(updated, authorizedAt);
    });
  }
  public async read(token: unknown): Promise<SessionState> {
    return this.authenticated(token, async (_tx, row, authorizedAt) => state(row, authorizedAt));
  }
  /** Reads the current credential revision only for this authenticated account. */
  public async readWithCredentialRevision(token: unknown): Promise<SessionCredentialSnapshot> {
    return this.authenticated(token, async (tx, row, authorizedAt) => {
      const credential = await tx.passwordCredential.findUnique({
        where: { accountId: row.accountId },
        select: { revision: true },
      });
      if (!credential) throw new SessionError('UNAVAILABLE');
      return {
        session: state(row, authorizedAt),
        credentialRevision: credential.revision.toString(),
      };
    });
  }
  public async listActive(token: unknown): Promise<SessionState[]> {
    return this.authenticated(token, async (tx, caller, _authorizedAt, now) => {
      const rows = await tx.session.findMany({
        where: { accountId: caller.accountId, revokedAt: null, device: { revokedAt: null } },
        include: { device: true },
        orderBy: { createdAt: 'desc' },
      });
      return rows
        .filter((row) => sessionIsActive(row, now))
        .map((row) => state(row, row.device.authorizedAt));
    });
  }
  public async revokeSession(token: unknown, targetId: string): Promise<void> {
    if (!uuidPattern.test(targetId)) throw new SessionError('INVALID_INPUT');
    return this.authenticated(token, async (tx, caller, _authorizedAt, now) => {
      await tx.session.updateMany({
        where: { id: targetId, accountId: caller.accountId, revokedAt: null },
        data: { revokedAt: now },
      });
    });
  }
  /** Revalidates the bearer under the account lock and revokes only that session. */
  public async revokeCurrent(token: unknown): Promise<void> {
    return this.authenticated(token, async (tx, caller, _authorizedAt, now) => {
      await tx.session.update({ where: { id: caller.id }, data: { revokedAt: now } });
    });
  }
  /** Storage primitive only: caller must authorize the sensitive action (4.3C/SEC-CRYPTO-003).
   * A transaction revokes selected devices and all their sessions, without rotating E2EE keys.
   */
  public async revokeDevicesAfterAuthorization(
    accountId: string,
    deviceIds: readonly string[],
  ): Promise<void> {
    if (
      !/^[!-~]{1,128}$/.test(accountId) ||
      deviceIds.length > 100 ||
      deviceIds.some((id) => !uuidPattern.test(id))
    )
      throw new SessionError('INVALID_INPUT');
    return this.locked(accountId, async (tx) => {
      const now = this.now();
      await tx.device.updateMany({
        where: { accountId, id: { in: [...deviceIds] }, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.session.updateMany({
        where: { accountId, deviceId: { in: [...deviceIds] }, revokedAt: null },
        data: { revokedAt: now },
      });
    });
  }
}
