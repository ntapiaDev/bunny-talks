import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';
import pg from 'pg';
import { test } from 'vitest';
import { loadLocalEnv } from '../../../local-env.mjs';

loadLocalEnv();
test('preserves historical accounts and unknown verifier dates when migrating to 4.4A', async () => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.pathname, '/bunny_talks_test');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
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
    const migrate = (name) =>
      client.query(
        readFileSync(
          new URL(`../../../prisma/migrations/${name}/migration.sql`, import.meta.url),
          'utf8',
        ),
      );
    await migrate('20261115000000_vault_foundation');
    await migrate('20261115010000_persistent_sessions');
    await migrate('20261115020000_reauthentication_grants');
    await client.query('INSERT INTO "Account" (id) VALUES ($1)', ['historical-account']);
    await client.query(
      'INSERT INTO "PasswordCredential" ("accountId", verifier, revision) VALUES ($1, $2, 7)',
      ['historical-account', 'historical-opaque-verifier'],
    );
    await migrate('20261115030000_email_registration');
    let row = (await client.query('SELECT * FROM "PasswordCredential"')).rows[0];
    assert.equal(row.accountId, 'historical-account');
    assert.equal(row.verifier, 'historical-opaque-verifier');
    assert.equal(row.revision, '7');
    assert.equal(row.verifierUpdatedAt, null);
    assert.equal((await client.query('SELECT count(*) FROM "EmailIdentity"')).rows[0].count, '0');
    assert.equal(
      (await client.query('SELECT count(*) FROM "EmailRegistration"')).rows[0].count,
      '0',
    );
    await client.query(
      'UPDATE "PasswordCredential" SET verifier = verifier, "verifierUpdatedAt" = now()',
    );
    assert.equal(
      (await client.query('SELECT "verifierUpdatedAt" FROM "PasswordCredential"')).rows[0]
        .verifierUpdatedAt,
      null,
    );
    await client.query('BEGIN');
    await client.query('UPDATE "PasswordCredential" SET verifier = $1', ['replacement-fixture']);
    assert.ok(
      (await client.query('SELECT "verifierUpdatedAt" FROM "PasswordCredential"')).rows[0]
        .verifierUpdatedAt instanceof Date,
    );
    await client.query('ROLLBACK');
    row = (await client.query('SELECT * FROM "PasswordCredential"')).rows[0];
    assert.equal(row.verifierUpdatedAt, null);
    assert.equal(row.verifier, 'historical-opaque-verifier');
    await client.query('UPDATE "PasswordCredential" SET verifier = $1', ['replacement-fixture']);
    assert.ok(
      (await client.query('SELECT "verifierUpdatedAt" FROM "PasswordCredential"')).rows[0]
        .verifierUpdatedAt instanceof Date,
    );
    await client.query('INSERT INTO "Account" (id) VALUES ($1), ($2)', ['case-one', 'case-two']);
    await client.query(
      'INSERT INTO "EmailIdentity" ("accountId", canonical, display, "verifiedAt") VALUES ($1, $2, $3, now()), ($4, $5, $6, now())',
      [
        'case-one',
        'Alice@example.com',
        'Alice@Example.com',
        'case-two',
        'alice@example.com',
        'alice@example.com',
      ],
    );
    await assert.rejects(migrate('20261115040000_email_casefold'));
    await client.query('ROLLBACK');
    assert.equal((await client.query('SELECT count(*) FROM "EmailIdentity"')).rows[0].count, '2');
    await client.query('DELETE FROM "EmailIdentity" WHERE "accountId" = $1', ['case-two']);
    await migrate('20261115040000_email_casefold');
    const identity = (
      await client.query('SELECT canonical, display FROM "EmailIdentity" WHERE "accountId" = $1', [
        'case-one',
      ])
    ).rows[0];
    assert.equal(identity.canonical, 'alice@example.com');
    assert.equal(identity.display, 'Alice@Example.com');
  } finally {
    if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  }
});
