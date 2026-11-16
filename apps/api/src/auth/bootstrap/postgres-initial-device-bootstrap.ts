import type { VaultOperationResult } from '@bunny-talks/contracts';
import type { Prisma, PrismaClient } from '../../../generated/prisma/client.js';
import type { PostgresVaultRepository } from '../../vault/postgres-vault-repository.js';
import { VaultRepositoryError } from '../../vault/vault-repository-error.js';
import { PasswordVerifierError, verifyPassword } from '../password-verifier.js';
import { PostgresSessionRepository } from '../sessions/postgres-session-repository.js';
import { requireSessionInTransaction } from '../sessions/session-authentication.js';
import { parseSessionToken, SessionError } from '../sessions/session-token.js';
import { InitialBootstrapError } from './initial-bootstrap-error.js';

type InitialMutation = ReturnType<PostgresVaultRepository['prepareInitialPublication']>;

/** Internal first-device activation only; no HTTP or cryptographic possession proof. */
export class PostgresInitialDeviceBootstrap {
  public constructor(
    private readonly client: PrismaClient,
    private readonly vault: PostgresVaultRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private now(): Date {
    const now = new Date(this.clock().getTime());
    if (!Number.isFinite(now.getTime())) throw new InitialBootstrapError('OUTCOME_UNKNOWN');
    return now;
  }

  private async locked<T>(account: string, work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.client.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('lock_timeout', '1000ms', true), set_config('statement_timeout', '3000ms', true)`;
        const rows = await tx.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM "Account" WHERE "id" = ${account} FOR UPDATE`;
        if (rows.length !== 1) throw new InitialBootstrapError('INVALID_AUTHENTICATION');
        return work(tx);
      },
      { isolationLevel: 'ReadCommitted', maxWait: 2000, timeout: 5000 },
    );
  }

  private async sanitized<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof InitialBootstrapError ||
        error instanceof PasswordVerifierError ||
        error instanceof SessionError ||
        error instanceof VaultRepositoryError
      )
        throw error;
      // A driver/commit failure never proves rollback. Recover the exact receipt first.
      throw new InitialBootstrapError('OUTCOME_UNKNOWN');
    }
  }

  private async requireVerifiedAccount(tx: Prisma.TransactionClient, accountId: string, now: Date) {
    const identity = await tx.emailIdentity.findUnique({ where: { accountId } });
    if (!identity || identity.verifiedAt > now)
      throw new InitialBootstrapError('INVALID_AUTHENTICATION');
  }

  /** Argon2id runs outside the activation transaction; no caller-supplied authentication flags. */
  public async activate(
    sessionToken: unknown,
    password: string,
    request: unknown,
    candidateDigest: unknown,
  ) {
    return this.sanitized(async () => {
      const input = this.vault.prepareInitialPublication(request, candidateDigest);
      const session = await new PostgresSessionRepository(this.client, undefined, this.clock).read(
        sessionToken,
      );
      const accountId = session.accountId;
      if (accountId !== input.identity.account)
        throw new InitialBootstrapError('INVALID_AUTHENTICATION');
      const before = await this.client.passwordCredential.findUnique({ where: { accountId } });
      const startedAt = this.now();
      if (!before || !(await verifyPassword(password, before.verifier)))
        throw new InitialBootstrapError('INVALID_AUTHENTICATION');
      const token = parseSessionToken(sessionToken);
      try {
        return await this.locked(accountId, async (tx) => {
          const now = this.now();
          const current = await requireSessionInTransaction(tx, accountId, token, now);
          await this.requireVerifiedAccount(tx, accountId, now);
          const credential = await tx.passwordCredential.findUnique({ where: { accountId } });
          if (
            current.deviceId !== session.deviceId ||
            !credential ||
            credential.verifier !== before.verifier ||
            credential.revision !== before.revision ||
            now < startedAt ||
            now.getTime() - startedAt.getTime() >= 300000
          )
            throw new InitialBootstrapError('INVALID_AUTHENTICATION');

          const previous = await this.readReceipt(tx, input, current.deviceId);
          if (previous.status !== 'unknown') return previous;
          await this.requireNeverInitialized(tx, accountId);
          const result = await this.vault.executeInTransaction(tx, input);
          if (result.status === 'committed') {
            await tx.device.update({
              where: { id: current.deviceId },
              data: { authorizedAt: now },
            });
          }
          await tx.initialBootstrapOperation.create({
            data: {
              accountId,
              operationId: input.identity.operationId,
              deviceId: current.deviceId,
            },
          });
          return result;
        });
      } finally {
        token.hash.fill(0);
      }
    });
  }

  /** Read-only recovery: current session, original device, exact request; no password or creation. */
  public async recoverReceipt(
    sessionToken: unknown,
    request: unknown,
    candidateDigest: unknown,
  ): Promise<VaultOperationResult> {
    return this.sanitized(async () => {
      const input = this.vault.prepareInitialPublication(request, candidateDigest);
      const token = parseSessionToken(sessionToken);
      try {
        return await this.locked(input.identity.account, async (tx) => {
          const now = this.now();
          const session = await requireSessionInTransaction(tx, input.identity.account, token, now);
          await this.requireVerifiedAccount(tx, session.accountId, now);
          return this.readReceipt(tx, input, session.deviceId);
        });
      } finally {
        token.hash.fill(0);
      }
    });
  }

  private async readReceipt(
    tx: Prisma.TransactionClient,
    input: InitialMutation,
    deviceId: string,
  ): Promise<VaultOperationResult> {
    const where = {
      accountId_operationId: {
        accountId: input.identity.account,
        operationId: input.identity.operationId,
      },
    };
    const binding = await tx.initialBootstrapOperation.findUnique({ where });
    if (!binding) {
      if (await tx.vaultOperation.findUnique({ where }))
        throw new InitialBootstrapError('HISTORICAL_STATE');
      return { transportVersion: 1, status: 'unknown' };
    }
    if (binding.deviceId !== deviceId) throw new InitialBootstrapError('REPLAY_FORBIDDEN');
    // This path cannot apply a mutation, even if storage were to lose a receipt.
    return this.vault.executeInTransaction(tx, input, true);
  }

  private async requireNeverInitialized(tx: Prisma.TransactionClient, accountId: string) {
    const success = await tx.initialBootstrapOperation.findFirst({
      where: { accountId, operation: { status: 'COMMITTED' } },
    });
    if (success) throw new InitialBootstrapError('NOT_ELIGIBLE');
    // Check durable history, not just the current number of authorized devices.
    if (
      (await tx.vaultState.findUnique({ where: { accountId } })) ||
      (await tx.vaultPublication.findFirst({ where: { accountId } })) ||
      (await tx.vaultOperation.findFirst({ where: { accountId, status: 'COMMITTED' } })) ||
      (await tx.device.findFirst({ where: { accountId, authorizedAt: { not: null } } }))
    )
      throw new InitialBootstrapError('HISTORICAL_STATE');
  }
}
