import { defineConfig } from 'prisma/config';
import { loadLocalEnv } from './local-env.mjs';

loadLocalEnv();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
