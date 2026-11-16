import type { OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../generated/prisma/client.js';

/** Owned by the Nest application, including the adapter's PostgreSQL pool. */
export class Database implements OnModuleDestroy {
  public readonly client: PrismaClient;
  public constructor(databaseUrl: string) {
    const url = new URL(databaseUrl);
    const schema = url.searchParams.get('schema') ?? 'public';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema))
      throw new Error('Invalid HTTP server configuration');
    url.searchParams.delete('schema');
    this.client = new PrismaClient({
      adapter: new PrismaPg(
        {
          connectionString: url.toString(),
          options: `-c search_path=${schema}`,
          application_name: 'bunny-talks-http',
          max: 8,
          connectionTimeoutMillis: 2000,
          idleTimeoutMillis: 30000,
          query_timeout: 5000,
        },
        { schema },
      ),
    });
  }
  public async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
