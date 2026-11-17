import { Prisma } from '../../../generated/prisma/client.js';

/** Fixed table allowlist; keys are already domain-separated HMACs. */
export async function takePostgresBudget(
  tx: Prisma.TransactionClient,
  tableName: 'RegistrationBudget' | 'LoginBudget' | 'BootstrapBudget',
  key: string,
  windowMs: number,
  limit: number,
): Promise<boolean> {
  const table = Prisma.raw(
    {
      RegistrationBudget: '"RegistrationBudget"',
      LoginBudget: '"LoginBudget"',
      BootstrapBudget: '"BootstrapBudget"',
    }[tableName],
  );
  const rows = await tx.$queryRaw<{ key: string }[]>(Prisma.sql`
    INSERT INTO ${table} ("key", "startedAt", "expiresAt", "hits")
    VALUES (${key}, clock_timestamp(), clock_timestamp() + ${windowMs} * interval '1 millisecond', 1)
    ON CONFLICT ("key") DO UPDATE SET
      "hits" = CASE WHEN ${table}."expiresAt" <= clock_timestamp() THEN 1 ELSE ${table}."hits" + 1 END,
      "startedAt" = CASE WHEN ${table}."expiresAt" <= clock_timestamp() THEN clock_timestamp() ELSE ${table}."startedAt" END,
      "expiresAt" = CASE WHEN ${table}."expiresAt" <= clock_timestamp() THEN clock_timestamp() + ${windowMs} * interval '1 millisecond' ELSE ${table}."expiresAt" END
    WHERE ${table}."expiresAt" <= clock_timestamp() OR ${table}."hits" < ${limit}
    RETURNING "key"`);
  return rows.length === 1;
}
