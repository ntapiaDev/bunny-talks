import { describe, expect, it, vi } from 'vitest';
import {
  effectiveEnvironment,
  startLocalDatabase,
  validateConfiguration,
} from '../../../db-up.mjs';

const admin = 'admin-fixture-password-123';
const dev = 'dev-fixture-password-123';
const test = 'test-fixture-password-123';
const fixture = () => ({
  POSTGRES_USER: 'bunny_admin',
  POSTGRES_DB: 'postgres',
  POSTGRES_PASSWORD: admin,
  BUNNY_DEV_PASSWORD: dev,
  BUNNY_TEST_PASSWORD: test,
  DATABASE_URL: `postgresql://bunny_dev:${dev}@127.0.0.1:15432/bunny_talks`,
  TEST_DATABASE_URL: `postgresql://bunny_test:${test}@127.0.0.1:15432/bunny_talks_test`,
});
const resolved = (env) => ({
  name: 'bunny-talks',
  volumes: { bunny_postgres_data: { name: 'bunny-talks_bunny_postgres_data' } },
  services: {
    postgres: {
      image: 'postgres:18.7',
      environment: { ...env },
      ports: [{ host_ip: '127.0.0.1', published: '15432', target: 5432, protocol: 'tcp' }],
      volumes: [{ type: 'volume', source: 'bunny_postgres_data', target: '/var/lib/postgresql' }],
      healthcheck: { test: ['CMD-SHELL', 'pg_isready'] },
    },
  },
});
const doubles = (env = fixture()) => ({
  compose: vi.fn((args) => (args[0] === 'config' ? JSON.stringify(resolved(env)) : '')),
  authenticate: vi.fn(async () => {}),
});

describe('local database startup', () => {
  it('starts only after validation, freezes Compose values and verifies all three TCP identities', async () => {
    const env = fixture();
    const tools = doubles(env);
    await startLocalDatabase(env, tools);
    expect(tools.compose).toHaveBeenCalledTimes(2);
    expect(tools.compose.mock.calls[0][0]).toEqual(['config', '--format', 'json']);
    expect(tools.compose.mock.calls[1][0]).toEqual([
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '60',
      'postgres',
    ]);
    expect(tools.compose.mock.calls[1][1]).toMatchObject({
      POSTGRES_PASSWORD: admin,
      BUNNY_DEV_PASSWORD: dev,
      BUNNY_TEST_PASSWORD: test,
    });
    expect(tools.compose.mock.calls[0][1]).toBe(tools.compose.mock.calls[1][1]);
    expect(
      tools.authenticate.mock.calls.map(([value]) => [value.user, value.database, value.port]),
    ).toEqual([
      ['bunny_admin', 'postgres', 15432],
      ['bunny_dev', 'bunny_talks', 15432],
      ['bunny_test', 'bunny_talks_test', 15432],
    ]);
  });
  it.each([
    { POSTGRES_PASSWORD: 'replace_with_admin_password' },
    { BUNNY_DEV_PASSWORD: 'replace_with_dev_password' },
    { BUNNY_TEST_PASSWORD: 'replace_with_test_password' },
    { BUNNY_TEST_PASSWORD: 'short' },
    { BUNNY_TEST_PASSWORD: admin },
    { POSTGRES_USER: 'bunny_dev' },
    { POSTGRES_DB: 'bunny_talks' },
    { DATABASE_URL: `postgresql://bunny_dev:${dev}@127.0.0.1:55432/bunny_talks` },
    { TEST_DATABASE_URL: `postgresql://bunny_test:${test}@127.0.0.1:5432/bunny_talks_test` },
    { TEST_DATABASE_URL: `postgresql://bunny_test:${test}@remote.invalid:15432/bunny_talks_test` },
    {
      TEST_DATABASE_URL: `postgresql://bunny_test:${test}@localhost:15432/bunny_talks_test?host=remote`,
    },
    { TEST_DATABASE_URL: `postgresql://bunny_test:${test}@localhost:15432/bunny_talks_test?` },
    { DATABASE_URL: `postgresql://bunny_dev:wrong@localhost:15432/bunny_talks` },
  ])('rejects invalid input without invoking Docker', async (patch) => {
    const env = { ...fixture(), ...patch };
    const tools = doubles(env);
    await expect(startLocalDatabase(env, tools)).rejects.toThrow(
      'Configuration PostgreSQL locale invalide',
    );
    expect(tools.compose).not.toHaveBeenCalled();
    expect(tools.authenticate).not.toHaveBeenCalled();
  });
  it('decodes URL-encoded special characters before comparing passwords', () => {
    const env = fixture();
    env.BUNNY_DEV_PASSWORD = 'dev:@/%? password special';
    env.DATABASE_URL = `postgresql://bunny_dev:${encodeURIComponent(env.BUNNY_DEV_PASSWORD)}@localhost:15432/bunny_talks`;
    expect(() => validateConfiguration(env)).not.toThrow();
    env.DATABASE_URL = env.DATABASE_URL.replace('%3A', '%ZZ');
    expect(() => validateConfiguration(env)).toThrow('Configuration PostgreSQL locale invalide');
  });
  it('preserves shell precedence over file variables', () => {
    const env = effectiveEnvironment('POSTGRES_USER=from_file\nPOSTGRES_DB=postgres\n', {
      POSTGRES_USER: 'bunny_admin',
    });
    expect(env.POSTGRES_USER).toBe('bunny_admin');
    expect(env.POSTGRES_DB).toBe('postgres');
  });
  it('rejects Compose interpolation differences before starting', async () => {
    const env = fixture();
    const other = { ...env, BUNNY_DEV_PASSWORD: 'different-resolved-password' };
    const tools = doubles(other);
    await expect(startLocalDatabase(env, tools)).rejects.toThrow(
      'Configuration Docker Compose incohérente : BUNNY_DEV_PASSWORD',
    );
    expect(tools.compose).toHaveBeenCalledTimes(1);
    expect(tools.authenticate).not.toHaveBeenCalled();
  });
  it('passes a literal dollar password unchanged to both Compose calls and authentication', async () => {
    const env = fixture();
    env.BUNNY_DEV_PASSWORD = 'fixture-$UNSET-dev-password';
    env.DATABASE_URL = `postgresql://bunny_dev:${encodeURIComponent(env.BUNNY_DEV_PASSWORD)}@127.0.0.1:15432/bunny_talks`;
    const tools = doubles(env);
    const config = resolved(env);
    config.services.postgres.environment.BUNNY_DEV_PASSWORD = env.BUNNY_DEV_PASSWORD.replaceAll(
      '$',
      () => '$$',
    );
    tools.compose.mockImplementation((args) =>
      args[0] === 'config' ? JSON.stringify(config) : '',
    );
    await startLocalDatabase(env, tools);
    expect(tools.compose.mock.calls[0][1]).toBe(tools.compose.mock.calls[1][1]);
    expect(tools.compose.mock.calls[0][1].BUNNY_DEV_PASSWORD).toBe(env.BUNNY_DEV_PASSWORD);
    expect(tools.authenticate.mock.calls[1][0].password).toBe(env.BUNNY_DEV_PASSWORD);
  });
  it.each(['mount', 'healthcheck', 'public-port', 'volume-name'])(
    'rejects an incompatible resolved Compose %s before startup',
    async (fault) => {
      const env = fixture();
      const config = resolved(env);
      if (fault === 'mount') config.services.postgres.volumes[0].source = 'other';
      if (fault === 'healthcheck') config.services.postgres.healthcheck.test = [];
      if (fault === 'public-port') config.services.postgres.ports[0].host_ip = '0.0.0.0';
      if (fault === 'volume-name') config.volumes.bunny_postgres_data.name = 'other';
      const tools = doubles(env);
      tools.compose.mockReturnValue(JSON.stringify(config));
      await expect(startLocalDatabase(env, tools)).rejects.toThrow(
        'Configuration Docker Compose incohérente',
      );
      expect(tools.compose).toHaveBeenCalledTimes(1);
      expect(tools.authenticate).not.toHaveBeenCalled();
    },
  );
  it('suppresses raw Compose errors and secrets', async () => {
    const tools = doubles();
    tools.compose.mockImplementation(() => {
      throw new Error(`leak ${admin}`);
    });
    const error = await startLocalDatabase(fixture(), tools).catch((e) => e);
    expect(error.message).toBe('Impossible de vérifier la configuration Docker Compose');
    expect(error.message).not.toContain(admin);
    expect(tools.authenticate).not.toHaveBeenCalled();
  });
  it('suppresses startup failures and skips authentication', async () => {
    const env = fixture();
    const tools = doubles(env);
    tools.compose.mockImplementation((args) => {
      if (args[0] === 'config') return JSON.stringify(resolved(env));
      throw new Error(`leak ${dev}`);
    });
    const error = await startLocalDatabase(env, tools).catch((e) => e);
    expect(error.message).toBe('Échec du démarrage ou du healthcheck PostgreSQL');
    expect(error.message).not.toContain(dev);
    expect(tools.authenticate).not.toHaveBeenCalled();
  });
  it('suppresses authentication errors after startup and explains existing volume passwords', async () => {
    const env = fixture();
    const tools = doubles(env);
    tools.authenticate.mockRejectedValueOnce(new Error(`leak ${admin}`));
    const error = await startLocalDatabase(env, tools).catch((e) => e);
    expect(error.message).toContain('volume existant');
    expect(error.message).not.toContain(admin);
    expect(tools.compose).toHaveBeenCalledTimes(2);
    expect(tools.authenticate).toHaveBeenCalledTimes(1);
  });
});
