import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { validateDisposablePostgres } from './qualify-local-postgres-guard.mjs';

// Only explicitly labelled disposable containers are accepted. No lifecycle operations here.
const name = process.argv[2];
assert.match(name ?? '', /^bunny45a-[a-z0-9-]+$/);
function docker(args, input) {
  return spawnSync('docker', args, { input, encoding: 'utf8' });
}
const inspection = docker(['inspect', name]);
assert.equal(inspection.status, 0, 'Disposable container is required');
const [container] = JSON.parse(inspection.stdout);
validateDisposablePostgres(container);
function sql(statement, role = 'bunny_admin', database = 'postgres', success = true) {
  const result = docker(
    [
      'exec',
      '-i',
      name,
      'sh',
      '-c',
      'export PGPASSWORD="$' +
        (role === 'bunny_dev'
          ? 'BUNNY_DEV_PASSWORD'
          : role === 'bunny_test'
            ? 'BUNNY_TEST_PASSWORD'
            : 'POSTGRES_PASSWORD') +
        '"; exec psql -X -h 127.0.0.1 -U "$1" -d "$2" -v ON_ERROR_STOP=1 -At',
      'sh',
      role,
      database,
    ],
    statement,
  );
  if (success) assert.equal(result.status, 0, 'SQL qualification failed (details suppressed)');
  else {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /permission denied for database/);
  }
  return result.stdout.trim();
}
assert.equal(
  sql(
    "SELECT count(*) FROM pg_roles WHERE rolname IN ('bunny_dev','bunny_test') AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls",
  ),
  '2',
);
sql('SELECT 1', 'bunny_test', 'bunny_talks', false);
sql('SELECT 1', 'bunny_dev', 'bunny_talks_test', false);
assert.equal(
  sql(
    "SELECT count(*) FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ('bunny_dev','bunny_test'))",
  ),
  '0',
);
sql(
  'CREATE SCHEMA qualification_temporary; DROP SCHEMA qualification_temporary;',
  'bunny_test',
  'bunny_talks_test',
);
sql(
  'CREATE TABLE IF NOT EXISTS qualification_witness (id integer PRIMARY KEY); INSERT INTO qualification_witness VALUES (45) ON CONFLICT DO NOTHING;',
  'bunny_dev',
  'bunny_talks',
);
function provision(success) {
  const result = docker(['exec', name, '/docker-entrypoint-initdb.d/01-provision.sh']);
  assert.equal(result.status === 0, success, 'Unexpected provisioning outcome');
  assert.ok(!result.stdout.includes('PASSWORD'));
}
provision(true);
assert.equal(sql('SELECT id FROM qualification_witness', 'bunny_dev', 'bunny_talks'), '45');
// Simulated interrupted provisioning: a database exists but its ACL is incompatible.
sql('GRANT CONNECT ON DATABASE bunny_talks TO PUBLIC;');
provision(false);
assert.equal(sql("SELECT has_database_privilege('bunny_test','bunny_talks','CONNECT')"), 't');
sql('REVOKE CONNECT ON DATABASE bunny_talks FROM PUBLIC;');
// Conflicting privileges must be refused, never silently repaired.
sql('ALTER ROLE bunny_test CREATEDB;');
provision(false);
assert.equal(sql("SELECT rolcreatedb FROM pg_roles WHERE rolname='bunny_test'"), 't');
sql('ALTER ROLE bunny_test NOCREATEDB;');
provision(true);
// Existing credentials must not be replaced by new environment values.
assert.equal(
  docker([
    'exec',
    '-e',
    'BUNNY_TEST_PASSWORD=unused_replacement_password',
    name,
    '/docker-entrypoint-initdb.d/01-provision.sh',
  ]).status,
  0,
);
sql('SELECT 1', 'bunny_test', 'bunny_talks_test');
assert.notEqual(
  docker([
    'exec',
    '-e',
    'POSTGRES_USER=bunny_dev',
    name,
    '/docker-entrypoint-initdb.d/01-provision.sh',
  ]).status,
  0,
);
assert.notEqual(
  docker([
    'exec',
    '-e',
    'BUNNY_TEST_PASSWORD=short',
    name,
    '/docker-entrypoint-initdb.d/01-provision.sh',
  ]).status,
  0,
);
const logs = docker(['logs', name]);
for (const entry of container.Config.Env) {
  if (/^(POSTGRES_PASSWORD|BUNNY_DEV_PASSWORD|BUNNY_TEST_PASSWORD)=/.test(entry)) {
    const secret = entry.slice(entry.indexOf('=') + 1);
    assert.ok(!(logs.stdout + logs.stderr).includes(secret), 'Credential found in container logs');
  }
}
process.stdout.write(
  'SQL qualification passed: cross-connections refused, roles bounded, schemas usable, witness preserved, provisioning idempotent, conflicts and partial state refused\n',
);
