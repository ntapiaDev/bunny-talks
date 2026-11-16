import { createHmac, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../../generated/prisma/client.js';
import type { RegistrationConfig } from './registration-config.js';
import { RegistrationError } from './registration-policy.js';

const minute = 60000;
const hour = 3600000;

/** Shared admission budgets. No password, proof, email or source address is persisted here. */
export class PostgresRegistrationLimits {
  public constructor(
    private readonly client: PrismaClient,
    private readonly config: RegistrationConfig,
  ) {}

  private key(scope: string, value: string): string {
    return createHmac('sha256', this.config.hmacKey).update(`${scope}\0${value}`).digest('hex');
  }

  private async take(
    tx: Prisma.TransactionClient,
    scope: string,
    value: string,
    windowMs: number,
    limit: number,
  ): Promise<boolean> {
    const key = this.key(scope, value);
    const rows = await tx.$queryRaw<{ key: string }[]>`
      INSERT INTO "RegistrationBudget" ("key", "startedAt", "expiresAt", "hits")
      VALUES (${key}, clock_timestamp(), clock_timestamp() + ${windowMs} * interval '1 millisecond', 1)
      ON CONFLICT ("key") DO UPDATE SET
        "hits" = CASE WHEN "RegistrationBudget"."expiresAt" <= clock_timestamp() THEN 1 ELSE "RegistrationBudget"."hits" + 1 END,
        "startedAt" = CASE WHEN "RegistrationBudget"."expiresAt" <= clock_timestamp() THEN clock_timestamp() ELSE "RegistrationBudget"."startedAt" END,
        "expiresAt" = CASE WHEN "RegistrationBudget"."expiresAt" <= clock_timestamp() THEN clock_timestamp() + ${windowMs} * interval '1 millisecond' ELSE "RegistrationBudget"."expiresAt" END
      WHERE "RegistrationBudget"."expiresAt" <= clock_timestamp() OR "RegistrationBudget"."hits" < ${limit}
      RETURNING "key"`;
    return rows.length === 1;
  }

  public async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('lock_timeout', '500ms', true), set_config('statement_timeout', '1000ms', true)`;
          return work(tx);
        },
        { maxWait: 500, timeout: 1500 },
      );
    } catch (error) {
      if (error instanceof RegistrationError) throw error;
      throw new RegistrationError('UNAVAILABLE');
    }
  }

  /** The email budget serializes admission and insertion, including across API instances. */
  public async admitEmail(tx: Prisma.TransactionClient, canonical: string): Promise<boolean> {
    if (!(await this.take(tx, 'email-hour', canonical, hour, this.config.limits.sendsPerEmail)))
      return false;
    return this.take(tx, 'email-cooldown', canonical, this.config.limits.cooldownMs, 1);
  }

  public async source(
    kind: 'request' | 'complete',
    source: string,
    proofId?: string,
  ): Promise<void> {
    const accepted = await this.transaction(async (tx) => {
      // Global first: bound storage growth even with many distinct sources.
      if (
        !(await this.take(
          tx,
          `${kind}-global`,
          '',
          minute,
          kind === 'request'
            ? this.config.limits.requestsGlobally
            : this.config.limits.hashesPerMinute * 5,
        ))
      )
        return false;
      if (
        !(await this.take(
          tx,
          `${kind}-source`,
          source,
          kind === 'request' ? hour : minute,
          kind === 'request'
            ? this.config.limits.requestsPerSource
            : this.config.limits.completionsPerSource,
        ))
      )
        return false;
      if (
        proofId &&
        !(await this.take(tx, 'proof', proofId, 1800000, this.config.limits.attemptsPerProof))
      )
        return false;
      return true;
    });
    if (!accepted) throw new RegistrationError('RATE_LIMITED');
  }

  public async hash(): Promise<void> {
    if (
      !(await this.transaction((tx) =>
        this.take(tx, 'hash-global', '', minute, this.config.limits.hashesPerMinute),
      ))
    )
      throw new RegistrationError('RATE_LIMITED');
  }

  public async acquire(kind: 'request' | 'complete'): Promise<() => Promise<void>> {
    const id = randomUUID();
    const accepted = await this.transaction(async (tx) => {
      // A fixed advisory key only protects short lease admission, never SMTP or Argon2id.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(44042, ${kind === 'request' ? 1 : 2})::text`;
      const rows = await tx.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) FROM "RegistrationLease" WHERE "kind" = ${kind} AND "expiresAt" > clock_timestamp()`;
      const maximum =
        kind === 'request'
          ? this.config.limits.concurrentRequests
          : this.config.limits.concurrentCompletions;
      if (rows[0]!.count >= BigInt(maximum)) return false;
      await tx.$executeRaw`INSERT INTO "RegistrationLease" ("id", "kind", "expiresAt") VALUES (${id}::uuid, ${kind}, clock_timestamp() + interval '60 seconds')`;
      return true;
    });
    if (!accepted) throw new RegistrationError('RATE_LIMITED');
    return async () => {
      try {
        await this.client.$executeRaw`DELETE FROM "RegistrationLease" WHERE "id" = ${id}::uuid`;
      } catch {
        /* A release failure cannot change a committed registration outcome; the lease expires. */
      }
    };
  }

  /** Bounded cooperative housekeeping; completed receipts are deliberately never deleted. */
  public async cleanup(): Promise<void> {
    await this.transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM "RegistrationBudget" WHERE "key" IN (SELECT "key" FROM "RegistrationBudget" WHERE "expiresAt" < clock_timestamp() - interval '1 hour' LIMIT 100 FOR UPDATE SKIP LOCKED)`;
      await tx.$executeRaw`DELETE FROM "RegistrationLease" WHERE "id" IN (SELECT "id" FROM "RegistrationLease" WHERE "expiresAt" <= clock_timestamp() LIMIT 100 FOR UPDATE SKIP LOCKED)`;
      await tx.$executeRaw`DELETE FROM "EmailRegistration" WHERE "id" IN (SELECT "id" FROM "EmailRegistration" WHERE "completedAt" IS NULL AND "expiresAt" < clock_timestamp() - interval '24 hours' LIMIT 100 FOR UPDATE SKIP LOCKED)`;
    });
  }
}
