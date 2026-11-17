import process from 'node:process';
import { PrismaPg } from '@prisma/adapter-pg';
import { expect, it } from 'vitest';
import { PrismaClient } from '../../../generated/prisma/client.js';
import { loadLocalEnv } from '../../../local-env.mjs';
import { validateTestDatabaseUrl, verifyTestDatabase } from '../../support/test-database-guard.mjs';

loadLocalEnv();
it('verifies every physical Prisma pool connection before lending it', async () => {
  const url = validateTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const verified = new Set();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: url.toString(),
      max: 2,
      onConnect: async (client) => {
        await verifyTestDatabase(client);
        const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
        verified.add(rows[0].pid);
      },
    }),
  });
  try {
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        prisma.$queryRawUnsafe('SELECT pg_backend_pid() AS pid, 1 AS value FROM pg_sleep(0.05)'),
      ),
    );
    expect(verified.size).toBe(2);
    for (const rows of results) expect(verified.has(rows[0].pid)).toBe(true);
  } finally {
    await prisma.$disconnect();
  }
});
it('rejects the physical connection before Prisma can execute its query', async () => {
  const url = validateTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: url.toString(),
      onConnect: async (client) => {
        await verifyTestDatabase(client);
        throw new Error('Rejected by connection guard');
      },
    }),
  });
  try {
    await expect(
      prisma.$executeRawUnsafe('CREATE SCHEMA pool_guard_must_not_exist'),
    ).rejects.toThrow();
    const checker = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.toString(), onConnect: verifyTestDatabase }),
    });
    try {
      expect(
        await checker.$queryRawUnsafe(
          "SELECT 1 FROM pg_namespace WHERE nspname='pool_guard_must_not_exist'",
        ),
      ).toEqual([]);
    } finally {
      await checker.$disconnect();
    }
  } finally {
    await prisma.$disconnect();
  }
});
