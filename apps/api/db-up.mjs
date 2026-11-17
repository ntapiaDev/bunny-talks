import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { validateLocalMigrationUrl } from './migrate-local.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const envFile = fileURLToPath(new URL('./.env', import.meta.url));
const composeKeys = [
  'POSTGRES_USER',
  'POSTGRES_DB',
  'POSTGRES_PASSWORD',
  'BUNNY_DEV_PASSWORD',
  'BUNNY_TEST_PASSWORD',
];
const composeArgs = [
  'compose',
  '--project-directory',
  root,
  '--env-file',
  envFile,
  '-f',
  `${root}compose.yaml`,
  '-p',
  'bunny-talks',
];

export function effectiveEnvironment(fileContent, shell) {
  return { ...parseEnv(fileContent), ...shell };
}

export function validateConfiguration(env) {
  const fail = () => {
    throw new Error('Configuration PostgreSQL locale invalide');
  };
  if (env.POSTGRES_USER !== 'bunny_admin' || env.POSTGRES_DB !== 'postgres') fail();
  const passwords = [env.POSTGRES_PASSWORD, env.BUNNY_DEV_PASSWORD, env.BUNNY_TEST_PASSWORD];
  if (
    passwords.some(
      (value) =>
        typeof value !== 'string' || [...value].length < 16 || value.startsWith('replace_with_'),
    ) ||
    new Set(passwords).size !== 3
  )
    fail();
  let dev;
  let test;
  try {
    if (typeof env.DATABASE_URL !== 'string' || /[?#]/.test(env.DATABASE_URL)) fail();
    dev = validateLocalMigrationUrl(env.DATABASE_URL);
    if (typeof env.TEST_DATABASE_URL !== 'string' || /[?#]/.test(env.TEST_DATABASE_URL)) fail();
    test = new URL(env.TEST_DATABASE_URL);
    if (
      !['postgres:', 'postgresql:'].includes(test.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(test.hostname) ||
      test.port !== '15432' ||
      test.username !== 'bunny_test' ||
      test.pathname !== '/bunny_talks_test' ||
      !test.password ||
      test.search ||
      test.hash
    )
      fail();
    if (
      decodeURIComponent(dev.password) !== env.BUNNY_DEV_PASSWORD ||
      decodeURIComponent(test.password) !== env.BUNNY_TEST_PASSWORD
    )
      fail();
  } catch {
    fail();
  }
  return { dev, test };
}

export function validateComposeConfiguration(env, config) {
  const fail = () => {
    throw new Error('Configuration Docker Compose incohérente');
  };
  const service = config?.services?.postgres;
  if (
    config?.name !== 'bunny-talks' ||
    service?.image !== 'postgres:18.7' ||
    config?.volumes?.bunny_postgres_data?.name !== 'bunny-talks_bunny_postgres_data'
  )
    fail();
  // Compose config serializes literal dollar signs as $$ for safe re-interpolation.
  const mismatch = composeKeys.find((key) => {
    const value = service.environment?.[key];
    return typeof value !== 'string' || value.replaceAll('$$', '$') !== env[key];
  });
  if (mismatch) throw new Error(`Configuration Docker Compose incohérente : ${mismatch}`);
  const ports = service.ports;
  if (
    !Array.isArray(ports) ||
    ports.length !== 1 ||
    ports[0].host_ip !== '127.0.0.1' ||
    String(ports[0].published) !== '15432' ||
    Number(ports[0].target) !== 5432 ||
    ports[0].protocol !== 'tcp'
  )
    fail();
  const mounts = service.volumes;
  if (
    !Array.isArray(mounts) ||
    mounts.filter((mount) => mount.target === '/var/lib/postgresql').length !== 1 ||
    !mounts.some(
      (mount) =>
        mount.type === 'volume' &&
        mount.source === 'bunny_postgres_data' &&
        mount.target === '/var/lib/postgresql' &&
        !mount.read_only,
    ) ||
    !Array.isArray(service.healthcheck?.test) ||
    service.healthcheck.test.length === 0 ||
    service.healthcheck.disable
  )
    fail();
}

export async function startLocalDatabase(env, { compose, authenticate }) {
  const urls = validateConfiguration(env);
  const fixed = Object.fromEntries(composeKeys.map((key) => [key, env[key]]));
  let resolved;
  try {
    resolved = JSON.parse(compose(['config', '--format', 'json'], fixed));
  } catch {
    throw new Error('Impossible de vérifier la configuration Docker Compose');
  }
  validateComposeConfiguration(env, resolved);
  try {
    compose(['up', '-d', '--wait', '--wait-timeout', '60', 'postgres'], fixed);
  } catch {
    throw new Error('Échec du démarrage ou du healthcheck PostgreSQL');
  }
  const endpoints = [
    {
      user: 'bunny_admin',
      database: 'postgres',
      host: '127.0.0.1',
      password: env.POSTGRES_PASSWORD,
    },
    {
      user: 'bunny_dev',
      database: 'bunny_talks',
      host: urls.dev.hostname.replace(/^\[|\]$/g, ''),
      password: env.BUNNY_DEV_PASSWORD,
    },
    {
      user: 'bunny_test',
      database: 'bunny_talks_test',
      host: urls.test.hostname.replace(/^\[|\]$/g, ''),
      password: env.BUNNY_TEST_PASSWORD,
    },
  ];
  for (const endpoint of endpoints) {
    try {
      await authenticate({ ...endpoint, port: 15432 });
    } catch {
      throw new Error(
        `Connexion PostgreSQL impossible pour ${endpoint.user} ; un mot de passe enregistré dans le volume existant peut différer de la configuration actuelle`,
      );
    }
  }
}

async function main() {
  const shell = { ...process.env };
  const env = effectiveEnvironment(readFileSync(envFile, 'utf8'), shell);
  await startLocalDatabase(env, {
    compose(args, fixed = {}) {
      return execFileSync('docker', [...composeArgs, ...args], {
        cwd: root,
        env: { ...shell, ...fixed },
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 90000,
      });
    },
    async authenticate(config) {
      const client = new pg.Client({ ...config, connectionTimeoutMillis: 3000 });
      try {
        await client.connect();
        await client.query('SELECT 1');
      } finally {
        await client.end().catch(() => {});
      }
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
    process.stdout.write(
      'PostgreSQL prêt : authentifications administrateur, développement et test vérifiées.\n',
    );
  } catch (error) {
    const allowed = [
      'Configuration PostgreSQL locale invalide',
      'Configuration Docker Compose incohérente',
      'Impossible de vérifier la configuration Docker Compose',
      'Échec du démarrage ou du healthcheck PostgreSQL',
    ];
    const message =
      allowed.includes(error?.message) ||
      composeKeys.some(
        (key) => error?.message === `Configuration Docker Compose incohérente : ${key}`,
      ) ||
      /^Connexion PostgreSQL impossible pour bunny_(admin|dev|test) ; un mot de passe enregistré dans le volume existant peut différer de la configuration actuelle$/.test(
        error?.message ?? '',
      )
        ? error.message
        : 'Impossible de lire la configuration PostgreSQL locale';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
