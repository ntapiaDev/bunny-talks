import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { loadLocalEnv } from '../local-env.mjs';
import { PostgresSessionRepository } from '../src/postgres-session-repository.js';
import * as tokens from '../src/session-token.js';
import { createTestDatabase } from './postgres-test-database.js';

loadLocalEnv();
describe('persistent sessions on PostgreSQL 18.7', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let client: PrismaClient;
  let now = Date.UTC(2026, 10, 15);
  const clock = () => new Date(now);
  let repository: PostgresSessionRepository;
  beforeAll(async () => {
    db = await createTestDatabase();
    client = db.createClient();
    repository = new PostgresSessionRepository(client, { absoluteMs: 10000, idleMs: 1000 }, clock);
  }, 30000);
  afterAll(async () => {
    await db?.dispose();
  });
  async function fixture() {
    const id = `session-test:${randomUUID()}`;
    await client.account.create({
      data: { id, credential: { create: { verifier: 'fixture-only' } } },
    });
    return { account: id, ...(await repository.createAfterAuthentication(id)) };
  }
  it('fails safely on an identifier collision without replacing the stored session', async () => {
    const f = await fixture();
    const generated = tokens.generateSessionToken();
    const original = await client.session.findUniqueOrThrow({ where: { id: f.session.id } });
    const mock = vi
      .spyOn(tokens, 'generateSessionToken')
      .mockReturnValueOnce({ ...generated, id: f.session.id });
    try {
      await expect(
        repository.createAfterAuthentication(f.account, f.session.deviceId),
      ).rejects.toMatchObject({ message: 'OUTCOME_UNKNOWN' });
    } finally {
      mock.mockRestore();
    }
    expect(await client.session.findUniqueOrThrow({ where: { id: f.session.id } })).toEqual(
      original,
    );
    await expect(repository.read(f.token)).resolves.toBeDefined();
  });
  it('uses distinct UUIDs and keeps a device stable across sessions', async () => {
    const f = await fixture();
    expect(f.session.deviceId).toMatch(tokens.uuidPattern);
    expect(f.session.id).toMatch(tokens.uuidPattern);
    expect(f.session.deviceId).not.toBe(f.session.id);
    expect(f.session.deviceState).toBe('pending');
    const second = await repository.createAfterAuthentication(f.account, f.session.deviceId);
    expect(second.session.deviceId).toBe(f.session.deviceId);
    expect(second.session.id).not.toBe(f.session.id);
    expect(second.session.id).toMatch(tokens.uuidPattern);
  });
  it('rolls back a new device when a session ID collides', async () => {
    const f = await fixture();
    const deviceId = randomUUID();
    const generated = tokens.generateSessionToken();
    const sessionMock = vi
      .spyOn(tokens, 'generateSessionToken')
      .mockReturnValueOnce({ ...generated, id: f.session.id });
    const deviceMock = vi.spyOn(tokens, 'generateDeviceId').mockReturnValueOnce(deviceId);
    try {
      await expect(repository.createAfterAuthentication(f.account)).rejects.toMatchObject({
        message: 'OUTCOME_UNKNOWN',
      });
    } finally {
      sessionMock.mockRestore();
      deviceMock.mockRestore();
    }
    expect(await client.device.findUnique({ where: { id: deviceId } })).toBeNull();
    expect(await client.session.count({ where: { accountId: f.account } })).toBe(1);
    await expect(repository.read(f.token)).resolves.toBeDefined();
  });
  it('rejects a device ID collision without creating a session', async () => {
    const f = await fixture();
    const mock = vi.spyOn(tokens, 'generateDeviceId').mockReturnValueOnce(f.session.deviceId);
    try {
      await expect(repository.createAfterAuthentication(f.account)).rejects.toMatchObject({
        message: 'OUTCOME_UNKNOWN',
      });
    } finally {
      mock.mockRestore();
    }
    expect(await client.device.count({ where: { accountId: f.account } })).toBe(1);
    expect(await client.session.count({ where: { accountId: f.account } })).toBe(1);
  });
  it('rejects matching generated device and session IDs before writing', async () => {
    const f = await fixture();
    const generated = tokens.generateSessionToken();
    const sessionMock = vi.spyOn(tokens, 'generateSessionToken').mockReturnValueOnce(generated);
    const deviceMock = vi.spyOn(tokens, 'generateDeviceId').mockReturnValueOnce(generated.id);
    try {
      await expect(repository.createAfterAuthentication(f.account)).rejects.toMatchObject({
        message: 'UNAVAILABLE',
      });
    } finally {
      sessionMock.mockRestore();
      deviceMock.mockRestore();
    }
    expect(await client.device.count({ where: { accountId: f.account } })).toBe(1);
    expect(await client.session.count({ where: { accountId: f.account } })).toBe(1);
  });
  it('persists only hashes, survives client recreation and leaves devices pending', async () => {
    const f = await fixture();
    const stored = await client.session.findUniqueOrThrow({ where: { id: f.session.id } });
    expect(stored.tokenHash).toHaveLength(32);
    expect(
      JSON.stringify(stored, (_key, value: unknown) =>
        typeof value === 'bigint' ? String(value) : value,
      ),
    ).not.toContain(f.token);
    expect(f.session.deviceState).toBe('pending');
    const device = await client.device.findUniqueOrThrow({ where: { id: f.session.deviceId } });
    expect(device.authorizedAt).toBeNull();
    const recreated = new PostgresSessionRepository(db.createClient(), undefined, clock);
    expect((await recreated.read(f.token)).id).toBe(f.session.id);
    const wrong = `${f.token.slice(0, 40)}${Buffer.alloc(32, 9).toString('base64url')}`;
    await expect(repository.validate(wrong)).rejects.toMatchObject({ message: 'INVALID_SESSION' });
    await expect(repository.read(f.session.id)).rejects.toMatchObject({
      message: 'INVALID_SESSION',
    });
    await client.passwordCredential.update({
      where: { accountId: f.account },
      data: { revision: { increment: 1 } },
    });
    expect((await repository.validate(f.token)).id).toBe(f.session.id);
  });
  it('enforces inactivity, updates activity and never extends absolute lifetime', async () => {
    const f = await fixture();
    const start = now;
    now = start + 999;
    await repository.validate(f.token);
    now = start + 1998;
    await repository.validate(f.token);
    now = start + 2998;
    await expect(repository.read(f.token)).rejects.toThrow('INVALID_SESSION');
    const absolute = new PostgresSessionRepository(
      client,
      { absoluteMs: 100, idleMs: null },
      clock,
    );
    const s = await absolute.createAfterAuthentication(f.account);
    now += 99;
    expect((await absolute.validate(s.token)).expiresAt.getTime()).toBe(now + 1);
    now += 1;
    await expect(absolute.validate(s.token)).rejects.toThrow('INVALID_SESSION');
  });
  it('scopes listing and revocation to the authenticated account and preserves other sessions', async () => {
    const a = await fixture();
    const b = await fixture();
    const second = await repository.createAfterAuthentication(a.account, a.session.deviceId);
    await repository.revokeSession(a.token, b.session.id);
    await expect(repository.read(b.token)).resolves.toBeDefined();
    expect((await repository.listActive(a.token)).map((s) => s.id).sort()).toEqual(
      [a.session.id, second.session.id].sort(),
    );
    await repository.revokeSession(a.token, second.session.id);
    await expect(repository.validate(second.token)).rejects.toThrow('INVALID_SESSION');
    await expect(repository.validate(a.token)).resolves.toBeDefined();
  });
  it('revalidates and revokes only the current session, never accepting an incorrect secret', async () => {
    const f = await fixture();
    const second = await repository.createAfterAuthentication(f.account, f.session.deviceId);
    const wrong = `${f.token.slice(0, 40)}${Buffer.alloc(32, 9).toString('base64url')}`;
    await expect(repository.revokeCurrent(wrong)).rejects.toThrow('INVALID_SESSION');
    await expect(repository.read(f.token)).resolves.toBeDefined();
    await repository.revokeCurrent(f.token);
    await expect(repository.read(f.token)).rejects.toThrow('INVALID_SESSION');
    await expect(repository.revokeCurrent(f.token)).rejects.toThrow('INVALID_SESSION');
    await expect(repository.read(second.token)).resolves.toBeDefined();
    const device = await client.device.findUniqueOrThrow({ where: { id: f.session.deviceId } });
    expect(device.revokedAt).toBeNull();
    expect(device.authorizedAt).toBeNull();
  });
  it('distinguishes authorized devices and invalidates all sessions of a revoked device', async () => {
    const f = await fixture();
    const other = await repository.createAfterAuthentication(f.account);
    await client.device.update({
      where: { id: f.session.deviceId },
      data: { authorizedAt: new Date(now) },
    });
    expect((await repository.read(f.token)).deviceState).toBe('authorized');
    const second = await repository.createAfterAuthentication(f.account, f.session.deviceId);
    await repository.revokeDevicesAfterAuthorization(f.account, [f.session.deviceId]);
    await expect(repository.validate(f.token)).rejects.toThrow('INVALID_SESSION');
    await expect(repository.read(second.token)).rejects.toThrow('INVALID_SESSION');
    await expect(repository.read(other.token)).resolves.toBeDefined();
    await expect(
      repository.createAfterAuthentication(f.account, f.session.deviceId),
    ).rejects.toThrow('INVALID_SESSION');
  });
  it('rejects cross-account references and invalid database states', async () => {
    const a = await fixture();
    const b = await fixture();
    await expect(
      client.session.create({
        data: { id: randomUUID(), accountId: b.account, deviceId: a.session.deviceId },
      }),
    ).rejects.toBeDefined();
    await expect(
      client.session.update({ where: { id: a.session.id }, data: { expiresAt: new Date(0) } }),
    ).rejects.toBeDefined();
    await expect(
      client.session.update({ where: { id: a.session.id }, data: { tokenHash: Buffer.alloc(1) } }),
    ).rejects.toBeDefined();
    await expect(
      repository.createAfterAuthentication(b.account, a.session.deviceId),
    ).rejects.toThrow('INVALID_SESSION');
  });
  it('waits for a concurrent device revocation and rejects after its commit', async () => {
    const f = await fixture();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const revocation = client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${f.account} FOR UPDATE`;
      await tx.device.update({
        where: { id: f.session.deviceId },
        data: { revokedAt: new Date(now) },
      });
      reached();
      await gate;
    });
    await ready;
    let done = false;
    const verification = repository
      .validate(f.token)
      .then(
        () => 'valid',
        () => 'invalid',
      )
      .finally(() => {
        done = true;
      });
    try {
      await delay(60);
      expect(done).toBe(false);
    } finally {
      release();
    }
    await revocation;
    expect(await verification).toBe('invalid');
  });
  it('allows a verification committed before revocation without retroactive cancellation', async () => {
    const f = await fixture();
    const state = await repository.validate(f.token);
    await repository.revokeDevicesAfterAuthorization(f.account, [f.session.deviceId]);
    expect(state.id).toBe(f.session.id);
    await expect(repository.validate(f.token)).rejects.toThrow('INVALID_SESSION');
  });
});
