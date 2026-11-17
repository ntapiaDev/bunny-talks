import { createHmac, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../../generated/prisma/client.js';
import { takePostgresBudget } from '../../shared/database/postgres-budget.js';
import { AuthenticationError } from '../authentication-error.js';
import type { LoginConfig } from './login-config.js';

export class PostgresLoginLimits {
  public constructor(
    private readonly client: PrismaClient,
    private readonly config: LoginConfig,
  ) {}

  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('lock_timeout', '500ms', true), set_config('statement_timeout', '1000ms', true)`;
          return work(tx);
        },
        { maxWait: 500, timeout: 1500 },
      );
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError('UNAVAILABLE');
    }
  }

  public async admit(source: string, canonical: string): Promise<void> {
    const accepted = await this.transaction(async (tx) => {
      // Preserve partial consumption on denial. Bound key cardinality before email/source allocation.
      for (const [scope, value, limit] of [
        ['requests-global', '', this.config.requestsGlobally],
        ['source', source, this.config.requestsPerSource],
        ['email', canonical, this.config.requestsPerEmail],
        ['hash-global', '', this.config.hashesPerWindow],
      ] as const) {
        const key = createHmac('sha256', this.config.hmacKey)
          .update(`login-v1\0${scope}\0${value}`)
          .digest('hex');
        if (!(await takePostgresBudget(tx, 'LoginBudget', key, this.config.windowMs, limit)))
          return false;
      }
      return true;
    });
    if (!accepted) throw new AuthenticationError('RATE_LIMITED');
  }

  public async acquire(): Promise<{ id: string; release: () => Promise<void> }> {
    const id = randomUUID();
    const accepted = await this.transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(44042, 3)::text`;
      const rows = await tx.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) FROM "LoginLease" WHERE "expiresAt" > clock_timestamp()`;
      if (rows[0]!.count >= BigInt(this.config.concurrency)) return false;
      await tx.$executeRaw`INSERT INTO "LoginLease" ("id", "expiresAt") VALUES (${id}::uuid, clock_timestamp() + ${this.config.leaseMs} * interval '1 millisecond')`;
      return true;
    });
    if (!accepted) throw new AuthenticationError('BUSY');
    return {
      id,
      release: async () => {
        try {
          await this.client.loginLease.deleteMany({ where: { id } });
        } catch {
          /* Expiration recovers a failed release; never override a committed outcome. */
        }
      },
    };
  }

  public async cleanup(): Promise<void> {
    await this.transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM "LoginBudget" WHERE "key" IN (SELECT "key" FROM "LoginBudget" WHERE "expiresAt" < clock_timestamp() - interval '1 hour' LIMIT 100 FOR UPDATE SKIP LOCKED)`;
      await tx.$executeRaw`DELETE FROM "LoginLease" WHERE "id" IN (SELECT "id" FROM "LoginLease" WHERE "expiresAt" <= clock_timestamp() LIMIT 100 FOR UPDATE SKIP LOCKED)`;
    });
  }
}
