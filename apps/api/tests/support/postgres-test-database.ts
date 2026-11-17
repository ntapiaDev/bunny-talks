import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { validateTestDatabaseUrl, verifyTestDatabase } from './test-database-guard.mjs';

/** Never resets a database: only a fresh, randomly named schema can be removed. */
export async function createTestDatabase(url: string | undefined = process.env.TEST_DATABASE_URL) {
  const parsed = validateTestDatabaseUrl(url);
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: parsed.toString(),
      onConnect: verifyTestDatabase,
    }),
  });
  const clients: PrismaClient[] = [];
  let created = false;
  const dispose = async () => {
    await Promise.all(clients.map((client) => client.$disconnect()));
    try {
      // The identifier is exclusively generated above, never obtained from input or the URL.
      if (created) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.$disconnect();
    }
  };
  try {
    const version = await admin.$queryRaw<{ server_version: string }[]>`SHOW server_version`;
    assert.match(version[0]!.server_version, /^18\.7(?:\s|$)/);
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    created = true;
    parsed.searchParams.set('schema', schema);
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: parsed.toString() },
      stdio: 'pipe',
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    url: parsed.toString(),
    admin,
    dispose,
    createClient(name: string = randomUUID()) {
      const client = new PrismaClient({
        adapter: new PrismaPg(
          {
            connectionString: parsed.toString(),
            options: `-c search_path=${schema}`,
            application_name: name,
            max: 4,
            onConnect: verifyTestDatabase,
          },
          { schema },
        ),
      });
      clients.push(client);
      return client;
    },
  };
}
