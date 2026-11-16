import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';
import pg from 'pg';
import { test } from 'vitest';
import { loadLocalEnv } from '../../../local-env.mjs';

loadLocalEnv();
test('migrates historical revoked sessions without activating tokens', async () => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/bunny_talks_test');
  assert.equal(url.search, '');
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  let created = false;
  try {
    const version = await client.query('SHOW server_version');
    assert.match(version.rows[0].server_version, /^18\.7(?:\s|$)/);
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(
      readFileSync(
        new URL(
          '../../../prisma/migrations/20261115000000_vault_foundation/migration.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const device = randomUUID();
    const session = randomUUID();
    await client.query('INSERT INTO "Account" (id) VALUES ($1)', ['historical-test']);
    await client.query('INSERT INTO "Device" (id, "accountId") VALUES ($1, $2)', [
      device,
      'historical-test',
    ]);
    await client.query(
      'INSERT INTO "Session" (id, "accountId", "deviceId", "revokedAt") VALUES ($1,$2,$3,$4)',
      [session, 'historical-test', device, '2026-01-01T00:00:00Z'],
    );
    await client.query(
      readFileSync(
        new URL(
          '../../../prisma/migrations/20261115010000_persistent_sessions/migration.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const { rows } = await client.query('SELECT * FROM "Session" WHERE id = $1', [session]);
    assert.equal(rows[0].tokenHash, null);
    assert.equal(rows[0].expiresAt.getTime(), rows[0].createdAt.getTime());
    assert.equal(rows[0].revokedAt.toISOString(), '2026-01-01T00:00:00.000Z');
    const devices = await client.query('SELECT "authorizedAt" FROM "Device"');
    assert.equal(devices.rows[0].authorizedAt, null);
  } finally {
    if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  }
});
