import assert from 'node:assert/strict';
import { URL } from 'node:url';
import pg from 'pg';

export function validateTestDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    assert.fail('Invalid test database configuration');
  }
  assert.ok(
    ['postgres:', 'postgresql:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.pathname === '/bunny_talks_test' &&
      url.username === 'bunny_test' &&
      url.password &&
      !url.search &&
      !url.hash,
    'Invalid test database configuration',
  );
  return url;
}

export async function verifyTestDatabase(client) {
  const result = await client.query(`SELECT current_database() AS database, current_user AS role,
    session_user AS session_role, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
    r.rolbypassrls, EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) AS member,
    has_database_privilege(current_user, 'bunny_talks', 'CONNECT') AS dev_access,
    current_setting('server_version') AS version
    FROM pg_roles r WHERE r.rolname = current_user`);
  const row = result.rows[0];
  assert.ok(
    row &&
      row.database === 'bunny_talks_test' &&
      row.role === 'bunny_test' &&
      row.session_role === 'bunny_test' &&
      !row.rolsuper &&
      !row.rolcreatedb &&
      !row.rolcreaterole &&
      !row.rolreplication &&
      !row.rolbypassrls &&
      !row.member &&
      !row.dev_access &&
      /^18\.7(?:\s|$)/.test(row.version),
    'Unsafe test database permissions or identity',
  );
}

export async function openTestDatabase(value) {
  const url = validateTestDatabaseUrl(value);
  const client = new pg.Client({ connectionString: url.toString() });
  try {
    await client.connect();
    await verifyTestDatabase(client);
    return { client, url };
  } catch {
    await client.end().catch(() => {});
    throw new Error('Test database connection or safety verification failed');
  }
}
