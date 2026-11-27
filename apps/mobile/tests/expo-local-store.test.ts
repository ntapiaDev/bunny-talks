import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  localExpoStorePaths,
  openExistingStore,
  openFreshStore,
} from '../src/infrastructure/crypto/expo-local-store';

const fixture = vi.hoisted(() => ({
  directory: '',
  keys: new Map<string, string>(),
  opened: new Set<string>(),
  connections: new Set<{ close(): void }>(),
  openSdk: vi.fn(),
  readKey: vi.fn(),
  writeKey: vi.fn(),
  deleteKey: vi.fn(),
  listError: false,
  coordinationEvents: [] as string[],
  afterCommit: vi.fn(),
}));
const coordination = 'bunny-local-crypto-reservations.db';

vi.mock('expo-file-system', () => {
  class File {
    readonly path: string;
    constructor(parent: Directory, name: string) {
      this.path = join(parent.path, name);
    }
    get name() {
      return basename(this.path);
    }
    info() {
      if (!existsSync(this.path)) return { exists: false };
      const stat = statSync(this.path);
      if (!stat.isFile()) throw new Error('Synthetic invalid path');
      return { exists: true, size: stat.size };
    }
  }
  class Directory {
    readonly path: string;
    constructor(uri: string) {
      this.path = fileURLToPath(uri);
    }
    get name() {
      return basename(this.path);
    }
    list() {
      if (fixture.listError) return [];
      return readdirSync(this.path, { withFileTypes: true }).map((entry) =>
        entry.isFile()
          ? new File(this, entry.name)
          : new Directory(`file://${join(this.path, entry.name)}`),
      );
    }
  }
  return { File, Directory };
});

vi.mock('expo-sqlite', () => ({
  get defaultDatabaseDirectory() {
    return fixture.directory;
  },
  async openDatabaseAsync(name: string, options: { useNewConnection?: boolean }) {
    expect(name).toBe(coordination);
    expect(options.useNewConnection).toBe(true);
    const sql = new DatabaseSync(join(fixture.directory, name));
    fixture.connections.add(sql);
    return {
      async execAsync(query: string) {
        sql.exec(query);
        if (query === 'COMMIT') {
          fixture.coordinationEvents.push('commit');
          fixture.afterCommit();
        }
      },
      async runAsync(query: string, ...bindings: string[]) {
        return sql.prepare(query).run(...bindings);
      },
      async getFirstAsync(query: string, ...bindings: string[]) {
        const row = sql.prepare(query).get(...bindings) ?? null;
        if (row && query.startsWith('SELECT name,')) fixture.coordinationEvents.push('read');
        return row;
      },
      async closeAsync() {
        sql.close();
        fixture.connections.delete(sql);
      },
    };
  },
}));

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'test-options',
  getItemAsync: fixture.readKey,
  setItemAsync: fixture.writeKey,
  deleteItemAsync: fixture.deleteKey,
}));

vi.mock('@open-e2ee/signal-protocol-sdk/local/store/expo', () => ({
  expoStore: fixture.openSdk,
}));

const context = {
  account: 'synthetic-account',
  device: 'synthetic-device',
  vaultId: 'AQEBAQEBAQEBAQEBAQEBAQ',
};
const paths = localExpoStorePaths(context);
const alternate = { ...context, device: 'other-device' };

function reservation() {
  const sql = new DatabaseSync(join(fixture.directory, coordination), { readOnly: true });
  try {
    return sql.prepare('SELECT name, vault_id FROM reservation WHERE scope = ?').get(paths.scope);
  } finally {
    sql.close();
  }
}

const validKey = Buffer.alloc(32, 0x31).toString('base64');
type FakeVault = {
  getSecret(name: string): Promise<Uint8Array | null>;
  setSecret(name: string, key: Uint8Array): Promise<void>;
  deleteSecret(name: string): Promise<void>;
};

describe('Expo store opening against a real SQLite coordination file', () => {
  beforeEach(async () => {
    fixture.directory = await mkdtemp(join(tmpdir(), 'bunny-expo-local-store-'));
    fixture.keys.clear();
    fixture.opened.clear();
    fixture.listError = false;
    fixture.coordinationEvents.length = 0;
    fixture.afterCommit.mockReset();
    fixture.readKey
      .mockReset()
      .mockImplementation(async (slot: string) => fixture.keys.get(slot) ?? null);
    fixture.writeKey.mockReset().mockImplementation(async (slot: string, secret: string) => {
      fixture.keys.set(slot, secret);
    });
    fixture.deleteKey.mockReset();
    fixture.openSdk
      .mockReset()
      .mockImplementation(async ({ name, vault }: { name: string; vault: FakeVault }) => {
        if (fixture.opened.has(name)) throw new Error('Synthetic SDK exclusive database lock');
        const file = join(fixture.directory, name);
        const slot = `signal_protocol_sqlite_key.${name}`;
        const key = await vault.getSecret(slot);
        if (key === null) {
          expect(await vault.getSecret(`signal_protocol_sqlite_pending_key.${name}`)).toBeNull();
          await vault.setSecret(slot, new Uint8Array(32).fill(0x31));
          writeFileSync(file, Buffer.alloc(4096), { flag: 'wx' });
        }
        fixture.opened.add(name);
        return {
          async close() {
            fixture.opened.delete(name);
          },
        };
      });
  });

  afterEach(async () => {
    try {
      expect(fixture.connections.size).toBe(0);
    } finally {
      for (const connection of fixture.connections) connection.close();
      fixture.connections.clear();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('commits and rereads the reservation before provisioning, then releases the coordination database', async () => {
    fixture.afterCommit.mockImplementationOnce(() => {
      const contender = new DatabaseSync(join(fixture.directory, coordination));
      try {
        expect(() => contender.exec('BEGIN IMMEDIATE')).toThrow();
      } finally {
        contender.close();
      }
    });
    fixture.writeKey.mockImplementationOnce(async (slot: string, secret: string) => {
      expect(fixture.coordinationEvents).toEqual(['commit', 'read']);
      const other = new DatabaseSync(join(fixture.directory, coordination));
      try {
        expect(() => other.exec('BEGIN IMMEDIATE')).toThrow();
      } finally {
        other.close();
      }
      fixture.keys.set(slot, secret);
    });
    const first = await openFreshStore(context);
    expect(reservation()).toMatchObject({ name: paths.name, vault_id: context.vaultId });
    expect(fixture.connections.size).toBe(0);
    expect(fixture.writeKey).toHaveBeenCalledTimes(1);
    await expect(openExistingStore(context)).rejects.toMatchObject({ code: 'SDK' });
    await expect(openFreshStore(context)).rejects.toMatchObject({ code: 'RESERVATION' });
    const independent = await openFreshStore(alternate);
    expect(fixture.opened.size).toBe(2);
    await Promise.all([first.close(), independent.close()]);
    const resumed = await openExistingStore(context);
    expect(fixture.writeKey).toHaveBeenCalledTimes(2);
    await resumed.close();
  });

  it('hands over only after the SDK has acquired the live store, with no second writer before handover', async () => {
    const open = fixture.openSdk.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fixture.openSdk.mockImplementationOnce(async (...args: unknown[]) => {
      entered();
      await barrier;
      return open(...args);
    });
    const first = openFreshStore(context);
    await reached;
    try {
      await expect(openFreshStore(context)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      await expect(openFreshStore(alternate)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      expect(fixture.writeKey).not.toHaveBeenCalled();
      expect(fixture.openSdk).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await (await first).close();
    }
  });

  it('leaves a committed reservation intact after a lost commit response', async () => {
    fixture.afterCommit.mockImplementationOnce(() => {
      throw new Error('Synthetic lost reservation commit response');
    });
    const observer = vi.fn();
    await expect(openFreshStore(context, observer)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(observer.mock.calls).toEqual([
      ['allocation', 'attempt'],
      ['allocation', 'uncertain'],
    ]);
    expect(reservation()).toMatchObject({ name: paths.name, vault_id: context.vaultId });
    expect(fixture.openSdk).not.toHaveBeenCalled();
    expect(fixture.writeKey).not.toHaveBeenCalled();
    await expect(openFreshStore(context)).rejects.toMatchObject({ code: 'RESERVATION' });
  });

  it('never recreates a missing reservation or a file after an uncertain key write', async () => {
    await expect(openExistingStore(context)).rejects.toMatchObject({ code: 'RESERVATION' });
    expect(readdirSync(fixture.directory)).toEqual([]);
    fixture.writeKey.mockImplementationOnce(async (slot: string, key: string) => {
      fixture.keys.set(slot, key);
      throw new Error('Synthetic lost result after SecureStore commit');
    });
    await expect(openFreshStore(context)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(reservation()).toMatchObject({ name: paths.name, vault_id: context.vaultId });
    await expect(openExistingStore(context)).rejects.toMatchObject({ code: 'FILE' });
    await expect(openFreshStore(context)).rejects.toMatchObject({ code: 'RESERVATION' });
    expect(existsSync(join(fixture.directory, paths.name))).toBe(false);
    expect(fixture.keys.get(paths.slot) === validKey).toBe(true);
    expect(fixture.writeKey).toHaveBeenCalledTimes(1);
    expect(fixture.deleteKey).not.toHaveBeenCalled();
    expect(fixture.openSdk).toHaveBeenCalledTimes(1);
  });

  it.each(['file', 'wal', 'conversion', 'key', 'pending key', 'empty listing'] as const)(
    'preserves fresh-creation provenance when given residual %s',
    async (residual) => {
      if (residual === 'file') writeFileSync(join(fixture.directory, paths.name), Buffer.alloc(0));
      if (residual === 'wal')
        writeFileSync(join(fixture.directory, `${paths.name}-wal`), 'fixture');
      if (residual === 'conversion')
        writeFileSync(join(fixture.directory, `${paths.conversionName}-wal`), 'fixture');
      if (residual === 'key') fixture.keys.set(paths.slot, validKey);
      if (residual === 'pending key') fixture.keys.set(paths.pendingSlot, validKey);
      if (residual === 'empty listing') fixture.listError = true;
      await expect(openFreshStore(context)).rejects.toMatchObject({
        code: residual === 'key' || residual === 'pending key' ? 'KEY' : 'FILE',
      });
      expect(reservation()).toMatchObject({ name: paths.name });
      expect(fixture.openSdk).not.toHaveBeenCalled();
      expect(fixture.writeKey).not.toHaveBeenCalled();
      expect(fixture.deleteKey).not.toHaveBeenCalled();
    },
  );

  it.each([
    'empty',
    'short',
    'directory',
    'missing-key',
    'malformed-key',
    'pending-key',
    'unreadable-key',
    'other-vault',
  ] as const)('refuses %s before handing custody to the SDK', async (scenario) => {
    await (await openFreshStore(context)).close();
    const file = join(fixture.directory, paths.name);
    const filesBefore = readdirSync(fixture.directory);
    if (scenario === 'empty' || scenario === 'short')
      writeFileSync(file, Buffer.alloc(scenario === 'empty' ? 0 : 17));
    if (scenario === 'directory') {
      await rm(file);
      mkdirSync(file);
    }
    if (scenario === 'missing-key') fixture.keys.delete(paths.slot);
    if (scenario === 'malformed-key') fixture.keys.set(paths.slot, 'invalid');
    if (scenario === 'pending-key') fixture.keys.set(paths.pendingSlot, validKey);
    if (scenario === 'unreadable-key')
      fixture.readKey.mockRejectedValueOnce(new Error('Synthetic secure read failure'));
    const keysBefore = new Map(fixture.keys);
    await expect(
      openExistingStore(
        scenario === 'other-vault' ? { ...context, vaultId: 'AAAAAAAAAAAAAAAAAAAAAA' } : context,
      ),
    ).rejects.toBeDefined();
    expect(fixture.openSdk).toHaveBeenCalledTimes(1);
    expect(readdirSync(fixture.directory)).toEqual(filesBefore);
    expect([...keysBefore].every(([name, key]) => fixture.keys.get(name) === key)).toBe(true);
    expect(fixture.keys.size).toBe(keysBefore.size);
    expect(fixture.writeKey).toHaveBeenCalledTimes(1);
    expect(fixture.deleteKey).not.toHaveBeenCalled();
  });

  it('limits the reopen vault to a single read-only key and never invokes reset or conversion', async () => {
    await (await openFreshStore(context)).close();
    fixture.openSdk.mockImplementationOnce(
      async (options: {
        name: string;
        encryptionAtRest: boolean;
        convertPlaintext: boolean;
        vault: FakeVault;
      }) => {
        expect(options).toMatchObject({
          name: paths.name,
          encryptionAtRest: true,
          convertPlaintext: false,
        });
        const key = await options.vault.getSecret(paths.slot);
        expect(key?.byteLength).toBe(32);
        await expect(options.vault.getSecret(paths.pendingSlot)).rejects.toMatchObject({
          code: 'KEY',
        });
        await expect(options.vault.setSecret(paths.slot, new Uint8Array(32))).rejects.toMatchObject(
          { code: 'KEY' },
        );
        await expect(options.vault.deleteSecret(paths.slot)).rejects.toMatchObject({ code: 'KEY' });
        return { async close() {} };
      },
    );
    await (await openExistingStore(context)).close();
    expect(fixture.readKey).toHaveBeenCalledTimes(4);
    expect(fixture.writeKey).toHaveBeenCalledTimes(1);
  });
});
