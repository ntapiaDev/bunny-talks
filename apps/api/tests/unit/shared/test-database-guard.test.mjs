import { expect, it } from 'vitest';
import { validateTestDatabaseUrl, verifyTestDatabase } from '../../support/test-database-guard.mjs';

const safe = {
  database: 'bunny_talks_test',
  role: 'bunny_test',
  session_role: 'bunny_test',
  rolsuper: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolbypassrls: false,
  member: false,
  dev_access: false,
  version: '18.7',
};

it.each([
  'postgresql://bunny_test:secret@localhost/bunny_talks',
  'postgresql://bunny_dev:secret@localhost/bunny_talks_test',
  'postgresql://bunny_test:secret@localhost/bunny_talks_test?host=other',
  'postgresql://bunny_test:secret@remote/bunny_talks_test',
])('rejects unsafe test URLs', (url) => {
  expect(() => validateTestDatabaseUrl(url)).toThrow('Invalid test database configuration');
});

it.each([
  { database: 'bunny_talks' },
  { role: 'bunny_dev' },
  { session_role: 'bunny_admin' },
  { rolsuper: true },
  { rolcreatedb: true },
  { rolcreaterole: true },
  { rolreplication: true },
  { rolbypassrls: true },
  { member: true },
  { dev_access: true },
  { version: '18.6' },
])('rejects unsafe server state', async (overrides) => {
  const client = { query: async () => ({ rows: [{ ...safe, ...overrides }] }) };
  await expect(verifyTestDatabase(client)).rejects.toThrow('Unsafe test database');
});

it('accepts the expected server state', async () => {
  const client = { query: async () => ({ rows: [safe] }) };
  await expect(verifyTestDatabase(client)).resolves.toBeUndefined();
});
