import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { fixtureJson } from './fixture-data.ts';

export { fixtureJson } from './fixture-data.ts';

const memoryGzip = gzipSync(JSON.stringify({ data: 'x'.repeat(768 * 1024) }));

export async function startFixture(directory: string, basePort = 9443, host = '127.0.0.1') {
  const events: Array<{
    destination: string;
    path: string;
    method: string;
    authorization: boolean;
    authorizationMatchesFixture: boolean;
    cookie: boolean;
    expoFixtureCookie: boolean;
    nativeFixtureCookie: boolean;
    responseStarted: boolean;
    responseStartedAtMs: number | null;
    startedAtMs: number;
    closed: boolean;
    finished: boolean;
    closedAfterMs: number | null;
  }> = [];
  const handler = (destination: string) => (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'https://fixture.invalid').pathname;
    if (events.length >= 4096) {
      res.writeHead(503).end();
      return;
    }
    const started = Date.now();
    const cookieNames = (req.headers.cookie ?? '')
      .split(';')
      .map((cookie) => cookie.split('=', 1)[0]?.trim());
    const event = {
      destination,
      path,
      method: req.method ?? '',
      authorization: !!req.headers.authorization,
      authorizationMatchesFixture: req.headers.authorization === 'Bearer fixture-only',
      cookie: !!req.headers.cookie,
      expoFixtureCookie: cookieNames.includes('bunny_fixture_expo'),
      nativeFixtureCookie: cookieNames.includes('bunny_fixture_native'),
      responseStarted: false,
      responseStartedAtMs: null as number | null,
      startedAtMs: started,
      closed: false,
      finished: false,
      closedAfterMs: null as number | null,
    };
    events.push(event);
    req.resume();
    res.on('finish', () => {
      event.finished = true;
    });
    res.on('close', () => {
      event.closed = true;
      event.closedAfterMs = Date.now() - started;
    });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const match = /^\/redirect\/(301|302|303|307|308)\/(same|host|http)$/.exec(path);
    if (match) {
      const target =
        match[2] === 'http'
          ? `http://10.0.2.2:${basePort + 2}`
          : match[2] === 'host'
            ? `https://10.0.2.2:${basePort + 1}`
            : `https://10.0.2.2:${basePort}`;
      res.writeHead(Number(match[1]), { Location: `${target}/destination` }).end();
    } else if (
      ['/slow', '/slow/cancel', '/slow/memory-timeout', '/slow/memory-cancel'].includes(path)
    ) {
      res.writeHead(200);
      res.flushHeaders();
      res.write('{"message":"', (error) => {
        if (!error) {
          event.responseStarted = true;
          event.responseStartedAtMs = Date.now();
        }
      });
      const interval = setInterval(() => res.write('x'), 100);
      res.on('close', () => clearInterval(interval));
    } else if (path === '/truncated' || path === '/length') {
      res.writeHead(200, path === '/length' ? { 'Content-Length': '1000' } : {});
      res.flushHeaders();
      res.write('{}');
      const timer = setTimeout(() => res.destroy(), 100);
      res.on('close', () => clearTimeout(timer));
    } else if (path === '/memory/gzip') {
      res.setHeader('Content-Encoding', 'gzip');
      res.end(memoryGzip);
    } else if (path === '/gzip' || path === '/oversize') {
      res.setHeader('Content-Encoding', 'gzip');
      res.end(
        gzipSync(
          path === '/oversize' ? JSON.stringify({ data: 'x'.repeat(1_048_577) }) : fixtureJson,
        ),
      );
    } else if (path === '/cookie') {
      res.setHeader('Set-Cookie', 'fixture=only; Secure; HttpOnly; Path=/');
      res.end(fixtureJson);
    } else if (
      /^\/cookies\/[a-f0-9-]{36}\/(baseline|seed|expo-probe|native-probe|native-set|expo-after)$/.test(
        path,
      )
    ) {
      if (path.endsWith('/seed') || path.endsWith('/native-set')) {
        const name = path.endsWith('/seed') ? 'bunny_fixture_expo' : 'bunny_fixture_native';
        const scope = path.slice(0, path.lastIndexOf('/') + 1);
        res.setHeader(
          'Set-Cookie',
          `${name}=synthetic; Secure; HttpOnly; Max-Age=120; Path=${scope}`,
        );
      }
      res.end(fixtureJson);
    } else if (path === '/challenge') {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' }).end('{}');
    } else if (path === '/invalid') res.end('{invalid');
    else if (['/json', '/destination', '/reuse/one', '/reuse/two'].includes(path))
      res.end(fixtureJson);
    else res.writeHead(404).end('{}');
  };
  const credentials = async (name: string) => ({
    key: await readFile(`${directory}/${name}.key`),
    cert: await readFile(`${directory}/${name}.pem`),
  });
  const servers = [
    createHttpsServer(await credentials('server'), handler('A')),
    createHttpsServer(await credentials('server'), handler('B')),
    createHttpServer(handler('C')),
    createHttpsServer(await credentials('unknown'), handler('unknown')),
    createHttpsServer(await credentials('wrong'), handler('wrong')),
  ];
  const control = createHttpServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/reset') {
      events.length = 0;
      res.end('{}');
    } else if (req.method === 'GET' && req.url === '/events') res.end(JSON.stringify(events));
    else res.writeHead(404).end('{}');
  });
  const close = async () => {
    await Promise.all(
      [...servers, control].map(async (server) => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
  };
  try {
    for (const [index, server] of servers.entries()) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(basePort + index, host, resolve);
      });
    }
    await new Promise<void>((resolve, reject) => {
      control.once('error', reject);
      control.listen(basePort + 5, '127.0.0.1', resolve);
    });
  } catch (error) {
    await close();
    throw error;
  }
  return { close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error('Certificate directory required');
  const fixture = await startFixture(directory, 9443, process.env.FIXTURE_HOST ?? '127.0.0.1');
  process.stdout.write(
    'Fixture A:9443 B:9444 HTTP:9445 unknown:9446 wrong:9447 control:127.0.0.1:9448\n',
  );
  process.once('SIGINT', () => {
    void fixture.close();
  });
  process.once('SIGTERM', () => {
    void fixture.close();
  });
}
