import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { URL, pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadLocalEnv } from './local-env.mjs';

export function validateLocalMigrationUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    assert.fail('Invalid local migration configuration');
  }
  assert.ok(
    ['postgres:', 'postgresql:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.port === '15432' &&
      url.pathname === '/bunny_talks' &&
      url.username === 'bunny_dev' &&
      url.password &&
      !url.search &&
      !url.hash,
    'Invalid local migration configuration',
  );
  return url;
}

export async function verifyLocalMigrationConnection(client) {
  const { rows } = await client.query(`SELECT current_user = 'bunny_dev'
      AND session_user = 'bunny_dev' AND current_database() = 'bunny_talks'
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
      AND NOT rolbypassrls
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
      AND NOT has_database_privilege(current_user, 'bunny_talks_test', 'CONNECT') AS safe, current_setting('server_version') AS version
      FROM pg_roles r WHERE rolname = current_user`);
  assert.ok(
    rows[0]?.safe && /^18\.7(?:\s|$)/.test(rows[0]?.version ?? ''),
    'Unsafe local migration identity, permissions or PostgreSQL version',
  );
}

export async function migrateLocal() {
  loadLocalEnv();
  const url = validateLocalMigrationUrl(process.env.DATABASE_URL);
  const client = new pg.Client({ connectionString: url.toString() });
  try {
    await client.connect();
    await verifyLocalMigrationConnection(client);
  } finally {
    await client.end();
  }
  // The CLI opens its own connections. Fixed credentials and server permissions remain essential.
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: new URL('.', import.meta.url),
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'pipe',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await migrateLocal();
    process.stdout.write('Local migrations applied\n');
  } catch {
    process.stderr.write(
      'Local migration refused or failed; inspect destination and migration status\n',
    );
    process.exitCode = 1;
  }
}
