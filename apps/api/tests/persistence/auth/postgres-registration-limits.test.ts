import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { loadLocalEnv } from '../../../local-env.mjs';
import { PostgresEmailRegistration } from '../../../src/auth/registration/postgres-email-registration.js';
import { PostgresRegistrationLimits } from '../../../src/auth/registration/postgres-registration-limits.js';
import { createTestDatabase } from '../../support/postgres-test-database.js';
import {
  CapturingRegistrationEmail,
  registrationTestConfig,
} from '../../support/registration-fixture.js';

loadLocalEnv();
describe('distributed registration budgets and cleanup on PostgreSQL 18.7', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let client: PrismaClient;
  let other: PrismaClient;
  beforeAll(async () => {
    db = await createTestDatabase();
    client = db.createClient();
    other = db.createClient();
  }, 30000);
  beforeEach(async () => {
    await client.registrationBudget.deleteMany();
    await client.registrationLease.deleteMany();
  });
  afterAll(async () => {
    await db?.dispose();
  });
  it('enforces the exact source boundary under races across independent connections', async () => {
    const config = registrationTestConfig();
    const configured = { ...config, limits: { ...config.limits, requestsPerSource: 3 } };
    const a = new PostgresRegistrationLimits(client, configured);
    const b = new PostgresRegistrationLimits(other, configured);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 ? a : b).source('request', 'shared-source'),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    expect(
      results
        .filter((result) => result.status === 'rejected')
        .every(
          (result) =>
            result.status === 'rejected' && String(result.reason).includes('RATE_LIMITED'),
        ),
    ).toBe(true);
  });
  it('bounds distinct source cardinality with a global budget before source insertion', async () => {
    const config = registrationTestConfig();
    const limits = new PostgresRegistrationLimits(client, {
      ...config,
      limits: { ...config.limits, requestsGlobally: 2 },
    });
    await limits.source('request', 'a');
    await limits.source('request', 'b');
    await expect(limits.source('request', 'c')).rejects.toThrow('RATE_LIMITED');
    expect(await client.registrationBudget.count()).toBe(3);
  });
  it('resets expired windows and never stores raw sources, addresses or proofs', async () => {
    const config = registrationTestConfig();
    const limits = new PostgresRegistrationLimits(client, {
      ...config,
      limits: { ...config.limits, completionsPerSource: 1 },
    });
    await limits.source('complete', '192.0.2.20', randomUUID());
    await expect(limits.source('complete', '192.0.2.20')).rejects.toThrow('RATE_LIMITED');
    await client.registrationBudget.updateMany({
      data: {
        startedAt: new Date(Date.now() - 7200000),
        expiresAt: new Date(Date.now() - 3600000),
      },
    });
    await limits.source('complete', '192.0.2.20');
    const rows = await client.registrationBudget.findMany();
    expect(rows.every((row) => /^[a-f0-9]{64}$/.test(row.key))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('192.0.2.20');
  });
  it('limits Argon2id starts at the exact shared boundary', async () => {
    const config = registrationTestConfig();
    const configured = { ...config, limits: { ...config.limits, hashesPerMinute: 2 } };
    const a = new PostgresRegistrationLimits(client, configured);
    const b = new PostgresRegistrationLimits(other, configured);
    await a.hash();
    await b.hash();
    await expect(a.hash()).rejects.toThrow('RATE_LIMITED');
  });
  it('admits only two concurrent completions globally and releases slots without open transactions', async () => {
    const config = registrationTestConfig();
    const a = new PostgresRegistrationLimits(client, config);
    const b = new PostgresRegistrationLimits(other, config);
    const releases = await Promise.all([a.acquire('complete'), b.acquire('complete')]);
    try {
      await expect(a.acquire('complete')).rejects.toThrow('RATE_LIMITED');
      expect(await client.registrationLease.count()).toBe(2);
      await releases[0]!();
      const release = await b.acquire('complete');
      await release();
    } finally {
      await Promise.all(releases.map((release) => release()));
    }
    expect(await client.registrationLease.count()).toBe(0);
  });
  it('recovers slots after a crashed owner lease expires', async () => {
    const config = registrationTestConfig();
    const limits = new PostgresRegistrationLimits(client, {
      ...config,
      limits: { ...config.limits, concurrentRequests: 1 },
    });
    const release = await limits.acquire('request');
    await expect(limits.acquire('request')).rejects.toThrow('RATE_LIMITED');
    await client.registrationLease.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    const next = await limits.acquire('request');
    await next();
    await release();
  });
  it('keeps email cooldown and hourly caps atomic even after a delivery failure', async () => {
    const config = registrationTestConfig();
    const limits = new PostgresRegistrationLimits(client, {
      ...config,
      limits: { ...config.limits, sendsPerEmail: 2 },
    });
    const transport = new CapturingRegistrationEmail();
    transport.uncertain = true;
    const service = new PostgresEmailRegistration(client, transport, undefined, undefined, limits);
    const email = `${randomUUID()}@Example.com`;
    await expect(service.requestVerification(email)).rejects.toThrow('DELIVERY_UNAVAILABLE');
    expect(await service.requestVerification(email.toUpperCase())).toEqual({
      status: 'verification-requested',
    });
    expect(await service.requestVerification(email)).toEqual({ status: 'verification-requested' });
    expect(transport.messages).toHaveLength(1);
    expect(
      await client.emailRegistration.count({ where: { canonical: email.toLowerCase() } }),
    ).toBe(1);
  });
  it('enforces email cooldown and hourly reservation boundaries independently, then resets expired windows', async () => {
    const config = registrationTestConfig();
    const limits = new PostgresRegistrationLimits(client, {
      ...config,
      limits: { ...config.limits, sendsPerEmail: 2 },
    });
    const email = `${randomUUID()}@example.com`;
    const admit = () => limits.transaction((tx) => limits.admitEmail(tx, email));
    expect(await admit()).toBe(true);
    expect(await admit()).toBe(false);
    // Expire just the one-minute cooldown; the hourly reservation cap must still reject.
    await client.registrationBudget.updateMany({
      where: { expiresAt: { lt: new Date(Date.now() + 120000) } },
      data: { startedAt: new Date(Date.now() - 120000), expiresAt: new Date(Date.now() - 60000) },
    });
    expect(await admit()).toBe(false);
    await client.registrationBudget.updateMany({
      data: {
        startedAt: new Date(Date.now() - 7200000),
        expiresAt: new Date(Date.now() - 3600000),
      },
    });
    expect(await admit()).toBe(true);
  });
  it('only cleans abandoned expired intentions, preserving recent expirations and durable receipts', async () => {
    const transport = new CapturingRegistrationEmail();
    const fresh = new PostgresEmailRegistration(client, transport, {
      async isBlocked() {
        return false;
      },
    });
    const abandoned = new PostgresEmailRegistration(
      client,
      transport,
      undefined,
      () => new Date(Date.now() - 3 * 86400000),
    );
    const recent = new PostgresEmailRegistration(
      client,
      transport,
      undefined,
      () => new Date(Date.now() - 1800001),
    );
    const email = `${randomUUID()}@example.com`;
    await fresh.requestVerification(email);
    const token = transport.messages.at(-1)!.token;
    await fresh.finalize({ email, token, password: 'cleanup receipt password' });
    await abandoned.requestVerification(`${randomUUID()}@example.com`);
    const oldId = transport.messages.at(-1)!.token.split('.')[1]!;
    await recent.requestVerification(`${randomUUID()}@example.com`);
    const recentId = transport.messages.at(-1)!.token.split('.')[1]!;
    await new PostgresRegistrationLimits(client, registrationTestConfig()).cleanup();
    expect(await client.emailRegistration.findUnique({ where: { id: oldId } })).toBeNull();
    expect(await client.emailRegistration.findUnique({ where: { id: recentId } })).not.toBeNull();
    expect(
      await fresh.finalize({ email, token, password: 'unchanged replay password' }),
    ).toMatchObject({ status: 'account-created' });
  });
});
