import { timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../../generated/prisma/client.js';
import type {
  PostgresVaultRepository,
  PreparedPasswordChange,
} from '../../vault/postgres-vault-repository.js';
import { PasswordVerifierError, verifyPassword } from '../password-verifier.js';
import { PostgresSessionRepository } from '../sessions/postgres-session-repository.js';
import { requireSessionInTransaction } from '../sessions/session-authentication.js';
import {
  generateOpaqueToken,
  parseOpaqueToken,
  parseSessionToken,
  SessionError,
} from '../sessions/session-token.js';
import { passwordChangeIntent, ReauthenticationError } from './reauthentication-intent.js';

/** Internal composition: no HTTP, E2EE authorization, or arbitrary mutation callbacks. */
export class PostgresReauthentication {
  public constructor(
    private readonly client: PrismaClient,
    private readonly vault: PostgresVaultRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  private now() {
    const t = new Date(this.clock().getTime());
    if (!Number.isFinite(t.getTime())) throw new ReauthenticationError('INVALID_GRANT');
    return t;
  }
  private async locked<T>(account: string, work: (tx: Prisma.TransactionClient) => Promise<T>) {
    try {
      return await this.client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('lock_timeout', '1000ms', true), set_config('statement_timeout', '3000ms', true)`;
          const rows = await tx.$queryRaw<
            { id: string }[]
          >`SELECT "id" FROM "Account" WHERE "id" = ${account} FOR UPDATE`;
          if (rows.length !== 1) throw new ReauthenticationError('INVALID_GRANT');
          return work(tx);
        },
        { isolationLevel: 'ReadCommitted', maxWait: 2000, timeout: 5000 },
      );
    } catch (error) {
      if (error instanceof ReauthenticationError) throw error;
      if (error instanceof SessionError && error.code === 'INVALID_SESSION') throw error;
      throw new ReauthenticationError('OUTCOME_UNKNOWN');
    }
  }
  /** Preparation must originate in the trusted server service and be retained exactly for replay. */
  public async issuePasswordChange(
    sessionToken: unknown,
    password: string,
    request: unknown,
    preparation: PreparedPasswordChange,
  ): Promise<string> {
    try {
      return await this.issue(sessionToken, password, request, preparation);
    } catch (error) {
      if (
        error instanceof ReauthenticationError ||
        error instanceof PasswordVerifierError ||
        error instanceof SessionError
      )
        throw error;
      throw new ReauthenticationError('OUTCOME_UNKNOWN');
    }
  }
  private async issue(
    sessionToken: unknown,
    password: string,
    request: unknown,
    preparation: PreparedPasswordChange,
  ): Promise<string> {
    const intent = passwordChangeIntent(request, preparation);
    const session = await new PostgresSessionRepository(this.client, undefined, this.clock).read(
      sessionToken,
    );
    if (session.accountId !== intent.request.account)
      throw new ReauthenticationError('INVALID_GRANT');
    const before = await this.client.passwordCredential.findUnique({
      where: { accountId: session.accountId },
    });
    if (!before || !(await verifyPassword(password, before.verifier)))
      throw new ReauthenticationError('INVALID_GRANT');
    const parsed = parseSessionToken(sessionToken);
    const grant = generateOpaqueToken('r1');
    try {
      return await this.locked(session.accountId, async (tx) => {
        const now = this.now();
        const currentSession = await requireSessionInTransaction(
          tx,
          session.accountId,
          parsed,
          now,
        );
        const credential = await tx.passwordCredential.findUnique({
          where: { accountId: session.accountId },
        });
        if (
          !credential ||
          credential.revision !== before.revision ||
          credential.verifier !== before.verifier ||
          currentSession.deviceId !== session.deviceId ||
          currentSession.device.authorizedAt === null ||
          credential.revision.toString() !== intent.request.expected.credentialRevision
        )
          throw new ReauthenticationError('INVALID_GRANT');
        await tx.reauthenticationGrant.create({
          data: {
            id: grant.id,
            tokenHash: Uint8Array.from(grant.hash),
            accountId: session.accountId,
            sessionId: session.id,
            deviceId: session.deviceId,
            kind: 'ordinary-password-change',
            operationId: intent.request.operationId,
            intentHash: Uint8Array.from(intent.hash),
            credentialRevision: credential.revision,
            createdAt: now,
            expiresAt: new Date(now.getTime() + 300000),
          },
        });
        return grant.token;
      });
    } finally {
      parsed.hash.fill(0);
      grant.hash.fill(0);
    }
  }
  public async changePassword(
    sessionToken: unknown,
    grantToken: unknown,
    request: unknown,
    preparation: PreparedPasswordChange,
  ) {
    const intent = passwordChangeIntent(request, preparation);
    const mutation = this.vault.preparePasswordChange(intent.request, preparation);
    const session = parseSessionToken(sessionToken);
    const grant = parseOpaqueToken(grantToken, 'r1');
    try {
      return await this.locked(intent.request.account, async (tx) => {
        const now = this.now();
        const current = await requireSessionInTransaction(tx, intent.request.account, session, now);
        if (current.device.authorizedAt === null) throw new ReauthenticationError('INVALID_GRANT');
        const row = await tx.reauthenticationGrant.findUnique({ where: { id: grant.id } });
        if (
          !row ||
          row.accountId !== current.accountId ||
          row.sessionId !== current.id ||
          row.deviceId !== current.deviceId ||
          row.kind !== 'ordinary-password-change' ||
          row.operationId !== intent.request.operationId ||
          !timingSafeEqual(row.tokenHash, grant.hash) ||
          !timingSafeEqual(row.intentHash, intent.hash)
        )
          throw new ReauthenticationError('INVALID_GRANT');
        // Consumed grants may only recover an exact durable receipt under current session authentication.
        if (row.consumedAt !== null) return this.vault.executeInTransaction(tx, mutation, true);
        const credential = await tx.passwordCredential.findUnique({
          where: { accountId: current.accountId },
        });
        if (
          !credential ||
          credential.revision !== row.credentialRevision ||
          now < row.createdAt ||
          now >= row.expiresAt
        )
          throw new ReauthenticationError('INVALID_GRANT');
        const existing = await tx.vaultOperation.findUnique({
          where: {
            accountId_operationId: { accountId: current.accountId, operationId: row.operationId },
          },
        });
        if (existing) throw new ReauthenticationError('INVALID_GRANT');
        const result = await this.vault.executeInTransaction(tx, mutation);
        await tx.reauthenticationGrant.update({ where: { id: row.id }, data: { consumedAt: now } });
        return result;
      });
    } finally {
      session.hash.fill(0);
      grant.hash.fill(0);
    }
  }
}
