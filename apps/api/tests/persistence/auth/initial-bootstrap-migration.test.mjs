import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';
import { test } from 'vitest';
import { loadLocalEnv } from '../../../local-env.mjs';
import { openTestDatabase } from '../../support/test-database-guard.mjs';

loadLocalEnv();
test('adds bootstrap bindings without inventing history or reauthorizing historical devices', async () => {
  const { client } = await openTestDatabase(process.env.TEST_DATABASE_URL);
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  try {
    assert.match(
      (await client.query('SHOW server_version')).rows[0].server_version,
      /^18\.7(?:\s|$)/,
    );
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
    for (const name of [
      '20261115000000_vault_foundation',
      '20261115010000_persistent_sessions',
      '20261115020000_reauthentication_grants',
      '20261115030000_email_registration',
      '20261115040000_email_casefold',
    ])
      await migrate(name);
    await client.query('INSERT INTO "Account" (id) VALUES ($1), ($2)', [
      'historical',
      'never-initialized',
    ]);
    await client.query('INSERT INTO "PasswordCredential" ("accountId", verifier) VALUES ($1, $2)', [
      'historical',
      'opaque-historical-fixture',
    ]);
    const deviceId = randomUUID();
    const publicationId = randomUUID();
    const operationId = randomUUID();
    await client.query(
      'INSERT INTO "Device" (id, "accountId", "authorizedAt", "revokedAt") VALUES ($1, $2, now() - interval \'1 day\', now()), ($3, $2, NULL, NULL)',
      [deviceId, 'historical', randomUUID()],
    );
    await client.query('INSERT INTO "Session" (id, "accountId", "deviceId") VALUES ($1, $2, $3)', [
      randomUUID(),
      'historical',
      deviceId,
    ]);
    const vaultId = randomBytes(16).toString('base64url');
    const digest = randomBytes(32);
    await client.query(
      'INSERT INTO "VaultPublication" (id, "accountId", "vaultId", "cryptographicFormatVersion", generation, "contentRevision", "passwordRevision", "recoveryRevision", "envelopeCredentialRevision", bytes, digest) VALUES ($1, $2, $3, 1, 1, 1, 1, 1, 1, $4, $5)',
      [publicationId, 'historical', vaultId, Buffer.from('opaque-migration-fixture'), digest],
    );
    await client.query(
      'INSERT INTO "VaultState" ("accountId", "vaultId", "storageRevision", "activePublicationId") VALUES ($1, $2, 1, $3)',
      ['historical', vaultId, publicationId],
    );
    await client.query(
      'INSERT INTO "VaultOperation" ("accountId", "operationId", kind, "expectedCredentialRevision", "fingerprintKeyId", fingerprint, status, "resultStorageRevision", "resultCredentialRevision", "publicationDigest") VALUES ($1, $2, \'initial-publication\', 1, \'migration-fixture\', $3, \'COMMITTED\', 1, 1, $4)',
      ['historical', operationId, randomBytes(32), digest],
    );
    const tables = [
      'Account',
      'PasswordCredential',
      'Device',
      'Session',
      'VaultPublication',
      'VaultState',
      'VaultOperation',
    ];
    const snapshot = async () => {
      const rows = [];
      for (const table of tables)
        rows.push((await client.query(`SELECT * FROM "${table}" ORDER BY 1`)).rows);
      return rows;
    };
    const before = await snapshot();
    await migrate('20261115050000_initial_device_bootstrap');
    assert.equal(
      (await client.query('SELECT count(*) FROM "InitialBootstrapOperation"')).rows[0].count,
      '0',
    );
    const after = await snapshot();
    assert.deepEqual(after, before);
  } finally {
    if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  }
});
