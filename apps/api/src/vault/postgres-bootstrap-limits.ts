import { createHmac, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { AuthenticationError } from '../auth/authentication-error.js';
import { takePostgresBudget } from '../shared/database/postgres-budget.js';
import type { BootstrapConfig } from './bootstrap-config.js';

/** Independent admission tables; never touches vault receipts, sessions or authorization. */
export class PostgresBootstrapLimits {
  public constructor(
    private readonly client: PrismaClient,
    private readonly config: BootstrapConfig,
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
    } catch {
      throw new AuthenticationError('UNAVAILABLE');
    }
  }

  public async admit(
    source: string,
    account: string,
    device: string,
    activation: boolean,
  ): Promise<void> {
    const accepted = await this.transaction(async (tx) => {
      // Global admission bounds key allocation; partial consumption survives a later denial.
      const scopes: [string, string, number][] = [
        ['requests-global', '', this.config.requestsGlobally],
        ['source', source, this.config.requestsPerSource],
        ['account', account, this.config.requestsPerAccount],
        ['device', device, this.config.requestsPerDevice],
      ];
      if (activation) scopes.push(['hash-global', '', this.config.hashesPerWindow]);
      for (const [scope, value, limit] of scopes) {
        const key = createHmac('sha256', this.config.quotaKey)
          .update(`vault-bootstrap-v1\0${scope}\0${value}`)
          .digest('hex');
        if (!(await takePostgresBudget(tx, 'BootstrapBudget', key, this.config.windowMs, limit)))
          return false;
      }
      return true;
    });
    if (!accepted) throw new AuthenticationError('RATE_LIMITED');
  }

  public async acquire(): Promise<{ release: () => Promise<void> }> {
    const id = randomUUID();
    const accepted = await this.transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(44043, 3)::text`;
      const rows = await tx.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) FROM "BootstrapLease" WHERE "expiresAt" > clock_timestamp()`;
      if (rows[0]!.count >= BigInt(this.config.concurrency)) return false;
      await tx.$executeRaw`INSERT INTO "BootstrapLease" ("id", "expiresAt") VALUES (${id}::uuid, clock_timestamp() + ${this.config.leaseMs} * interval '1 millisecond')`;
      return true;
    });
    if (!accepted) throw new AuthenticationError('BUSY');
    return {
      release: async () => {
        try {
          await this.client.bootstrapLease.deleteMany({ where: { id } });
        } catch {
          /* Lease expiry recovers release failure without hiding a durable result. */
        }
      },
    };
  }

  public async cleanup(): Promise<void> {
    await this.transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM "BootstrapBudget" WHERE "key" IN (SELECT "key" FROM "BootstrapBudget" WHERE "expiresAt" < clock_timestamp() - interval '1 hour' LIMIT 100 FOR UPDATE SKIP LOCKED)`;
      await tx.$executeRaw`DELETE FROM "BootstrapLease" WHERE "id" IN (SELECT "id" FROM "BootstrapLease" WHERE "expiresAt" <= clock_timestamp() LIMIT 100 FOR UPDATE SKIP LOCKED)`;
    });
  }
}
