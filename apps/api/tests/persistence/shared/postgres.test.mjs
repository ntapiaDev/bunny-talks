import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { URL } from 'node:url';
import { test } from 'vitest';
import { loadLocalEnv } from '../../../local-env.mjs';
import { openTestDatabase } from '../../support/test-database-guard.mjs';

loadLocalEnv();

const url = process.env.TEST_DATABASE_URL;
test('migrations and PostgreSQL constraints', async () => {
  const { client } = await openTestDatabase(url);
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const migrationUrl = new URL(url);
    migrationUrl.searchParams.set('schema', schema);
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: migrationUrl.toString() },
      stdio: 'pipe',
    });
    await client.query(`SET search_path TO "${schema}"`);
    const constraints = await client.query(
      `SELECT conname, convalidated FROM pg_constraint
       WHERE connamespace = current_schema()::regnamespace`,
    );
    for (const name of [
      'VaultState_accountId_vaultId_activePublicationId_fkey',
      'VaultState_revision_positive',
      'VaultPublication_values',
      'VaultOperation_values',
    ]) {
      assert.ok(
        constraints.rows.some(
          (constraint) => constraint.conname === name && constraint.convalidated,
        ),
      );
    }
    const rejected = async (sql, params = []) => {
      await assert.rejects(client.query(sql, params), (error) =>
        ['23001', '23503', '23505', '23514', '22003'].includes(error.code),
      );
    };
    const first = 'fixture-account-1';
    const second = 'fixture-account-2';
    const vault = 'AAECAwQFBgcICQoLDA0ODw';
    const publicationId = randomUUID();
    const bytes = Buffer.from([0, 255, 17, 0, 128]);
    const digest = Buffer.alloc(32, 1);
    await client.query('INSERT INTO "Account" (id) VALUES ($1), ($2)', [first, second]);
    const deviceId = randomUUID();
    const sessionId = randomUUID();
    await client.query('INSERT INTO "Device" (id, "accountId") VALUES ($1, $2)', [deviceId, first]);
    await rejected('INSERT INTO "Session" (id, "accountId", "deviceId") VALUES ($1, $2, $3)', [
      sessionId,
      second,
      deviceId,
    ]);
    await client.query('INSERT INTO "Session" (id, "accountId", "deviceId") VALUES ($1, $2, $3)', [
      sessionId,
      first,
      deviceId,
    ]);
    await client.query('UPDATE "Session" SET "revokedAt" = now() WHERE id = $1', [sessionId]);
    const device = await client.query('SELECT "revokedAt" FROM "Device" WHERE id = $1', [deviceId]);
    assert.equal(device.rows[0].revokedAt, null);
    await rejected('DELETE FROM "Device" WHERE id = $1', [deviceId]);
    await client.query('INSERT INTO "PasswordCredential" ("accountId", verifier) VALUES ($1, $2)', [
      first,
      'fixture-verifier',
    ]);
    await rejected('INSERT INTO "PasswordCredential" ("accountId", verifier) VALUES ($1, $2)', [
      first,
      'fixture',
    ]);
    await rejected('INSERT INTO "PasswordCredential" ("accountId", verifier) VALUES ($1, $2)', [
      'missing',
      'fixture',
    ]);
    await rejected('UPDATE "PasswordCredential" SET revision = 0 WHERE "accountId" = $1', [first]);
    await client.query(
      'INSERT INTO "VaultPublication" (id, "accountId", "vaultId", "cryptographicFormatVersion", generation, "contentRevision", "passwordRevision", "recoveryRevision", "envelopeCredentialRevision", bytes, digest) VALUES ($1,$2,$3,1,1,1,1,1,1,$4,$5)',
      [publicationId, first, vault, bytes, digest],
    );
    const read = await client.query('SELECT bytes FROM "VaultPublication" WHERE id = $1', [
      publicationId,
    ]);
    assert.deepEqual(read.rows[0].bytes, bytes);
    await rejected('INSERT INTO "VaultState" VALUES ($1,$2,1,$3)', [second, vault, publicationId]);
    await rejected('INSERT INTO "VaultState" VALUES ($1,$2,1,$3)', [
      first,
      'AAAAAAAAAAAAAAAAAAAAAA',
      publicationId,
    ]);
    await client.query('INSERT INTO "VaultState" VALUES ($1,$2,1,$3)', [
      first,
      vault,
      publicationId,
    ]);
    await rejected('INSERT INTO "VaultState" VALUES ($1,$2,1,$3)', [first, vault, publicationId]);
    await rejected('UPDATE "VaultState" SET "storageRevision" = 0 WHERE "accountId" = $1', [first]);
    await rejected(
      'UPDATE "VaultState" SET "storageRevision" = 9223372036854775808 WHERE "accountId" = $1',
      [first],
    );
    await client.query(
      'UPDATE "VaultState" SET "storageRevision" = 9223372036854775807 WHERE "accountId" = $1',
      [first],
    );
    await rejected('DELETE FROM "Account" WHERE id = $1', [first]);
    await rejected('DELETE FROM "VaultPublication" WHERE id = $1', [publicationId]);
    await client.query('DELETE FROM "Account" WHERE id = $1', [second]);
    const operationId = randomUUID();
    const operation =
      'INSERT INTO "VaultOperation" ("accountId", "operationId", kind, "expectedCredentialRevision", "fingerprintKeyId", fingerprint, status, "resultStorageRevision", "resultCredentialRevision", "publicationDigest") VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9)';
    await client.query(operation, [
      first,
      operationId,
      'initial-publication',
      'fixture-key',
      digest,
      'COMMITTED',
      1,
      1,
      digest,
    ]);
    await rejected(operation, [
      first,
      operationId,
      'initial-publication',
      'fixture-key',
      digest,
      'COMMITTED',
      1,
      1,
      digest,
    ]);
    await rejected(operation, [
      first,
      randomUUID(),
      'initial-publication',
      'fixture-key',
      digest,
      'COMMITTED',
      null,
      1,
      digest,
    ]);
    await rejected(operation, [
      first,
      randomUUID(),
      'initial-publication',
      'fixture-key',
      digest,
      'UNKNOWN',
      null,
      null,
      null,
    ]);
    await client.query(
      'INSERT INTO "VaultOperation" ("accountId", "operationId", kind, "expectedCredentialRevision", "fingerprintKeyId", fingerprint, status, "rejectionCode") VALUES ($1,$2,$3,1,$4,$5,$6,$7)',
      [
        first,
        randomUUID(),
        'initial-publication',
        'fixture-key',
        digest,
        'REJECTED',
        'VERSION_CONFLICT',
      ],
    );
    await rejected(
      'INSERT INTO "VaultOperation" ("accountId", "operationId", kind, "expectedCredentialRevision", "fingerprintKeyId", fingerprint, status) VALUES ($1,$2,$3,1,$4,$5,$6)',
      [first, randomUUID(), 'initial-publication', 'fixture-key', digest, 'REJECTED'],
    );
  } finally {
    if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  }
}, 30000);
