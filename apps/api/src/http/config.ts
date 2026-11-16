import { isIP } from 'node:net';

export interface HttpConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly mode: 'development' | 'test' | 'production';
}

/** Never include environment values in configuration errors. */
export function readHttpConfig(env: Readonly<Record<string, string | undefined>>): HttpConfig {
  const fail = (): never => {
    throw new Error('Invalid HTTP server configuration');
  };
  const mode = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(mode)) fail();
  const host = env.API_HOST ?? '127.0.0.1';
  if (isIP(host) === 0) fail();
  const portText = env.API_PORT ?? '3000';
  if (!/^(?:0|[1-9][0-9]{0,4})$/.test(portText)) fail();
  const port = Number(portText);
  if (port > 65535 || (port === 0 && mode !== 'test')) fail();
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) fail();
  try {
    const url = new URL(databaseUrl!);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      url.pathname.length < 2 ||
      url.hash
    )
      fail();
    const allowedParameters = new Set(['schema', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey']);
    for (const key of url.searchParams.keys()) {
      if (!allowedParameters.has(key) || url.searchParams.getAll(key).length !== 1) fail();
    }
    const schema = url.searchParams.get('schema');
    if (schema !== null && !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema)) fail();
    const sslmode = url.searchParams.get('sslmode');
    if (sslmode !== null && !['disable', 'verify-full'].includes(sslmode)) fail();
    // Remote connections must explicitly authenticate the database server's certificate.
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.searchParams.get('sslmode') !== 'verify-full'
    )
      fail();
    if (mode === 'production' && url.searchParams.get('sslmode') !== 'verify-full') fail();
  } catch {
    fail();
  }
  return { databaseUrl: databaseUrl!, host, port, mode: mode as HttpConfig['mode'] };
}
