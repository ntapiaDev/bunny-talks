import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer, get as httpsGet } from 'node:https';
import type { Socket } from 'node:net';
import { createServer as createTcpServer } from 'node:net';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

export const fixtureJson = JSON.stringify({ message: 'Bonjour 🐰 — 日本語 — العربية' });
const exactJson = JSON.stringify({ data: 'x'.repeat(1_048_565) });
const exactGzip = gzipSync(exactJson);
const smallGzip = gzipSync('{}');
const fixtureBytes = Buffer.from(fixtureJson);
const fixtureGzip = gzipSync(fixtureBytes);
const matrixBodies = new Map([
  ['/chunked-coding-absent', fixtureBytes],
  ['/chunked-complete', fixtureBytes],
  ['/chunked-coding-gzip', fixtureGzip],
  ['/coding-absent', fixtureBytes],
  ['/json', fixtureBytes],
  ['/coding-gzip', fixtureGzip],
]);
const badCrcGzip = Buffer.from(smallGzip);
badCrcGzip.writeUInt8(smallGzip.readUInt8(smallGzip.length - 8) ^ 1, smallGzip.length - 8);
const gzipSamples = new Map([
  ['/gzip-exact', exactGzip],
  ['/gzip-truncated', smallGzip.subarray(0, -4)],
  ['/gzip-bad-crc', badCrcGzip],
  ['/gzip-truncated-stream', exactGzip.subarray(0, Math.floor(exactGzip.length / 2))],
]);

function coding(value: unknown) {
  if (value === undefined) return 'absent';
  if (typeof value !== 'string') return 'other';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'identity' || normalized === 'gzip') return normalized;
  return normalized.includes(',') ? 'stacked' : 'other';
}

// Independent HTTP/1.1 client observations, made before simulator traffic.
const framingPaths = [
  '/retry-status',
  '/retry-status-length',
  '/slow/cancel',
  '/slow/cancel-length',
  '/slow/timeout',
  '/slow/concurrency-one',
  '/slow/concurrency-two',
  '/identity-oversize',
  '/identity-oversize-length',
  '/identity-oversize-error',
  '/chunked-complete',
  '/chunked-coding-absent',
  '/chunked-coding-gzip',
  '/coding-absent',
  '/json',
  '/coding-gzip',
  '/truncated',
  '/chunked-incomplete-end',
];
type Framing = 'chunked' | 'length' | 'other';
type Control = {
  controlFraming: Framing;
  controlCoding: ReturnType<typeof coding>;
  controlOversizeLength: boolean;
  controlBody?: 'complete-match' | 'mismatch';
};
function probeResponse(port: number, ca: Buffer, path: string, method: string) {
  const expectedBody = matrixBodies.get(path);
  return new Promise<Control>((resolve, reject) => {
    const req = httpsGet(
      {
        hostname: '127.0.0.1',
        port,
        ca,
        path: '/v1/https-qualification' + path,
        method,
        agent: false,
        headers: { 'Accept-Encoding': 'identity' },
        signal: AbortSignal.timeout(3000),
      },
      (res) => {
        // Distinct parsed fields preserve duplicates without persisting header values.
        const length = res.headersDistinct['content-length'] ?? [];
        const transfer = res.headersDistinct['transfer-encoding'] ?? [];
        const encoding = res.headersDistinct['content-encoding'] ?? [];
        const result: Control = {
          controlFraming:
            transfer.length === 1 && transfer[0] === 'chunked' && length.length === 0
              ? 'chunked'
              : transfer.length === 0 && length.length === 1 && /^\d+$/.test(length[0]!)
                ? 'length'
                : 'other',
          controlCoding: encoding.length > 1 ? 'stacked' : coding(encoding[0]),
          controlOversizeLength: length.length === 1 && length[0] === String(exactJson.length + 1),
        };
        if (!expectedBody) {
          resolve(result);
          res.destroy();
          return;
        }
        let received = 0;
        let matches = true;
        // The Node HTTP client removes transfer framing and preserves content coding.
        res.on('data', (bytes: Buffer) => {
          matches &&= bytes.equals(expectedBody.subarray(received, received + bytes.length));
          received += bytes.length;
          if (received > expectedBody.length) res.destroy();
        });
        res.on('error', reject);
        res.on('close', () => {
          resolve({
            ...result,
            controlBody:
              res.statusCode === 200 && res.complete && matches && received === expectedBody.length
                ? 'complete-match'
                : 'mismatch',
          });
        });
      },
    );
    req.on('error', reject);
  });
}

function evidencePath(path: string) {
  const prefix = '/v1/https-qualification';
  const route = path.replace(/^\/v1\/https-qualification(?=\/)/, '');
  const scope = route === path ? '' : prefix;
  const cookie =
    /^\/cookies\/[a-f0-9-]{36}\/(baseline|seed|expo-probe|native-probe|native-set|expo-after)$/.exec(
      route,
    );
  if (cookie) return scope + '/cookies/fixture/' + cookie[1];
  if (
    framingPaths.includes(route) ||
    gzipSamples.has(route) ||
    /^\/(?:redirect\/(?:301|302|303|307|308)\/(?:same|host|http)|slow(?:\/(?:cancel(?:-length)?|timeout|concurrency-one|concurrency-two))?|reuse\/(?:one|two)|json|request-body|destination|no-content|invalid(?:-utf8|-native-request)?|truncated|length|unframed|multipart|gzip|oversize|identity-(?:exact|oversize)|coding-(?:absent|gzip|other|stacked)|cookie|challenge|retry-status(?:-length|-gzip)?|drop-before-headers|expired-before-execute|cancel-before-start|cancel-before-execute|cancel-during-tls|refused-over-capacity)$/.test(
      route,
    )
  ) {
    return scope + route;
  }
  return '/unexpected';
}

export async function startFixture(
  directory: string,
  basePort = 9443,
  host = '127.0.0.1',
  identityProfile = false,
  recordConnectionIds = false,
) {
  const controls = new Map<string, Control>();
  const connectionIds = new WeakMap<Socket, number>();
  let nextConnectionId = 1;
  const events: Array<{
    destination: string;
    path: string;
    method: string;
    connectionId?: number;
    httpVersion?: string;
    authorization: boolean;
    authorizationMatchesFixture: boolean;
    cookie: boolean;
    expoFixtureCookie: boolean;
    nativeFixtureCookie: boolean;
    contentTypeIsJson: boolean;
    postBodyMatchesFixture: boolean;
    requestedCoding: ReturnType<typeof coding>;
    responseCoding: ReturnType<typeof coding>;
    configuredFraming: 'length' | 'chunked' | 'other' | 'unobserved';
    controlFraming?: Control['controlFraming'];
    controlCoding?: Control['controlCoding'];
    controlOversizeLength?: boolean;
    configuredOversizeLength?: boolean;
    controlBody?: Control['controlBody'];
    heldLengthEnd?: 'peer-close' | 'fixture-watchdog' | 'finished' | 'socket-error';
    fixtureCut?: boolean;
    headersSent: boolean;
    responseStarted: boolean;
    responseStartedAtMs: number | null;
    startedAtMs: number;
    closed: boolean;
    finished: boolean;
    closedAfterMs: number | null;
  }> = [];
  const handler = (destination: string) => (req: IncomingMessage, res: ServerResponse) => {
    const requestPath = new URL(req.url ?? '/', 'https://fixture.invalid').pathname;
    const path = requestPath.replace(/^\/v1\/https-qualification(?=\/)/, '');
    if (events.length >= 4096) {
      res.writeHead(503).end();
      return;
    }
    const started = Date.now();
    const cookieNames = (req.headers.cookie ?? '')
      .split(';')
      .map((cookie) => cookie.split('=', 1)[0]?.trim());
    const event: (typeof events)[number] = {
      destination,
      path: evidencePath(requestPath),
      method: req.method ?? '',
      authorization: !!req.headers.authorization,
      authorizationMatchesFixture: req.headers.authorization === 'Bearer fixture-only',
      cookie: !!req.headers.cookie,
      expoFixtureCookie: cookieNames.includes('bunny_fixture_expo'),
      nativeFixtureCookie: cookieNames.includes('bunny_fixture_native'),
      contentTypeIsJson: req.headers['content-type'] === 'application/json',
      postBodyMatchesFixture: false,
      ...controls.get(req.method + ' ' + path),
      requestedCoding: coding(req.headers['accept-encoding']),
      responseCoding: coding(undefined),
      configuredFraming: 'unobserved',
      headersSent: false,
      responseStarted: false,
      responseStartedAtMs: null as number | null,
      startedAtMs: started,
      closed: false,
      finished: false,
      closedAfterMs: null as number | null,
    };
    if (recordConnectionIds) {
      let connectionId = connectionIds.get(req.socket);
      if (connectionId === undefined) {
        connectionId = nextConnectionId++;
        connectionIds.set(req.socket, connectionId);
      }
      event.connectionId = connectionId;
      event.httpVersion = req.httpVersion;
    }
    events.push(event);
    const recordHeaders = () => {
      event.headersSent = res.headersSent;
      if (!event.headersSent) return;
      event.responseCoding = coding(res.getHeader('Content-Encoding'));
      const transfer = res.getHeader('Transfer-Encoding');
      event.configuredFraming =
        transfer !== undefined
          ? transfer === 'chunked' && !res.hasHeader('Content-Length')
            ? 'chunked'
            : 'other'
          : res.hasHeader('Content-Length')
            ? 'length'
            : 'unobserved';
    };
    res.on('finish', () => {
      recordHeaders();
      event.finished = true;
    });
    res.on('close', () => {
      recordHeaders();
      event.closed = true;
      event.closedAfterMs = Date.now() - started;
    });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (
      identityProfile &&
      path !== '/coding-absent' &&
      path !== '/chunked-coding-absent' &&
      path !== '/no-content'
    )
      res.setHeader('Content-Encoding', 'identity');
    if (path === '/request-body') {
      let body = '';
      req
        .setEncoding('utf8')
        .on('data', (chunk: string) => {
          if (body.length <= 100) body += chunk.slice(0, 101 - body.length);
        })
        .on('end', () => {
          event.postBodyMatchesFixture = body === '{"message":"fixture 🐰"}';
          res.end(fixtureJson);
        });
      return;
    }
    req.resume();
    const match = /^\/redirect\/(301|302|303|307|308)\/(same|host|http)$/.exec(path);
    const gzipSample = gzipSamples.get(path);
    if (match) {
      const hostname = req.headers.host?.startsWith('localhost:') ? 'localhost' : '10.0.2.2';
      const target =
        match[2] === 'http'
          ? `http://${hostname}:${basePort + 2}`
          : `https://${hostname}:${basePort + (match[2] === 'host' ? 1 : 0)}`;
      res.writeHead(Number(match[1]), { Location: `${target}/destination` }).end();
    } else if (path === '/slow' || path.startsWith('/slow/')) {
      if (path === '/slow/cancel-length') res.setHeader('Content-Length', '1000');
      else res.setHeader('Transfer-Encoding', 'chunked');
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
      event.fixtureCut = false;
      res.setHeader(
        path === '/length' ? 'Content-Length' : 'Transfer-Encoding',
        path === '/length' ? '1000' : 'chunked',
      );
      res.writeHead(200);
      res.flushHeaders();
      res.write('{}');
      const timer = setTimeout(() => {
        if (res.destroyed) return;
        event.fixtureCut = true;
        res.destroy();
      }, 100);
      res.on('close', () => clearTimeout(timer));
    } else if (path === '/unframed') {
      res.useChunkedEncodingByDefault = false;
      res.setHeader('Connection', 'close');
      res.flushHeaders();
      res.end('{}');
    } else if (path === '/multipart') {
      const boundary = 'bunny-fixture';
      res.setHeader('Content-Type', `multipart/x-mixed-replace; boundary=${boundary}`);
      res.end(
        [
          `--${boundary}`,
          'Content-Type: application/json',
          '',
          '{"part":1}',
          `--${boundary}`,
          'Content-Type: application/json',
          '',
          '{"part":2}',
          `--${boundary}--`,
          '',
        ].join('\r\n'),
      );
    } else if (gzipSample) {
      res.setHeader('Content-Encoding', 'gzip');
      // Complete HTTP framing, even for malformed compressed payloads.
      res.setHeader('Content-Length', gzipSample.length);
      res.end(gzipSample);
    } else if (path === '/gzip' || path === '/oversize') {
      res.setHeader('Content-Encoding', 'gzip');
      res.end(
        gzipSync(
          path === '/oversize' ? JSON.stringify({ data: 'x'.repeat(1_048_577) }) : fixtureJson,
        ),
      );
    } else if (path === '/identity-exact') {
      res.setHeader('Content-Length', exactJson.length);
      res.end(exactJson);
    } else if (path.startsWith('/chunked-') && matrixBodies.has(path)) {
      res.setHeader('Transfer-Encoding', 'chunked');
      if (path === '/chunked-coding-gzip') res.setHeader('Content-Encoding', 'gzip');
      res.end(matrixBodies.get(path));
    } else if (path === '/chunked-incomplete-end') {
      // Fixed fixture only: the last chunk starts, but the trailer section never terminates.
      event.fixtureCut = false;
      const socket = res.socket!;
      socket.write(
        'HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\nContent-Encoding: identity\r\nContent-Type: application/json\r\n\r\n2\r\n{}\r\n',
      );
      const timer = setTimeout(() => {
        if (socket.destroyed) return;
        socket.once('finish', () => {
          event.fixtureCut = true;
        });
        socket.end('0\r\n');
      }, 100);
      socket.once('close', () => clearTimeout(timer));
    } else if (path === '/identity-oversize-length') {
      res.setHeader('Content-Length', exactJson.length + 1);
      res.setHeader('Connection', 'close');
      res.flushHeaders();
      recordHeaders();
      event.configuredOversizeLength = res.getHeader('Content-Length') === exactJson.length + 1;
      // Offer one valid prefix byte, then withhold the remainder for the whole experiment.
      res.write(exactJson[0], (error) => {
        if (error) return;
        event.responseStarted = true;
        event.responseStartedAtMs = Date.now();
      });
      const socket = res.socket!;
      const watchdog = setTimeout(() => {
        event.heldLengthEnd = 'fixture-watchdog';
        res.destroy();
      }, 6000);
      socket.once('close', (hadError) => {
        clearTimeout(watchdog);
        event.heldLengthEnd ??= res.writableFinished
          ? 'finished'
          : hadError
            ? 'socket-error'
            : 'peer-close';
      });
    } else if (path === '/identity-oversize' || path === '/identity-oversize-error') {
      res.statusCode = path.endsWith('-error') ? 503 : 200;
      res.setHeader('Transfer-Encoding', 'chunked');
      res.write(exactJson);
      // Keep the message open after byte limit+1 so a native stop is observable.
      const extra = setTimeout(() => res.write(' '), 100);
      const end = setTimeout(() => res.end(), 1200);
      res.on('close', () => {
        clearTimeout(extra);
        clearTimeout(end);
      });
    } else if (path === '/coding-gzip') {
      const bytes = fixtureGzip;
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', bytes.length);
      res.end(bytes);
    } else if (path === '/json' || path === '/coding-absent') {
      res.setHeader('Content-Length', Buffer.byteLength(fixtureJson));
      res.end(fixtureJson);
    } else if (path === '/coding-other' || path === '/coding-stacked') {
      res.setHeader('Content-Encoding', path === '/coding-other' ? 'br' : 'gzip, gzip');
      res.end(path === '/coding-other' ? brotliCompressSync('{}') : gzipSync(smallGzip));
    } else if (path === '/retry-status-gzip') {
      res.setHeader('Content-Encoding', 'gzip');
      res.writeHead(503, { 'Retry-After': '0', 'Content-Length': smallGzip.length }).end(smallGzip);
    } else if (path === '/no-content') {
      res.removeHeader('Content-Type');
      res.writeHead(204).end();
    } else if (path === '/invalid-utf8') {
      res.end(Buffer.from([0x22, 0xc0, 0x22]));
    } else if (path === '/retry-status' || path === '/retry-status-length') {
      if (path === '/retry-status-length') res.setHeader('Content-Length', '2');
      else res.setHeader('Transfer-Encoding', 'chunked');
      res
        .writeHead(503, {
          'Retry-After': '0',
        })
        .end('{}');
    } else if (path === '/drop-before-headers') {
      res.destroy();
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
        const scope = requestPath.slice(0, requestPath.lastIndexOf('/') + 1);
        res.setHeader(
          'Set-Cookie',
          `${name}=synthetic; Secure; HttpOnly; Max-Age=120; Path=${scope}`,
        );
      }
      res.end(fixtureJson);
    } else if (path === '/challenge') {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' }).end('{}');
    } else if (path === '/invalid') res.end('{invalid');
    else if (['/destination', '/reuse/one', '/reuse/two'].includes(path)) res.end(fixtureJson);
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
  const stalledConnections = new Set<Socket>();
  const stalledTls = createTcpServer((socket) => {
    stalledConnections.add(socket);
    const started = Date.now();
    const event: (typeof events)[number] = {
      destination: 'stalled-tls',
      path: '',
      method: '',
      authorization: false,
      authorizationMatchesFixture: false,
      cookie: false,
      expoFixtureCookie: false,
      nativeFixtureCookie: false,
      contentTypeIsJson: false,
      postBodyMatchesFixture: false,
      requestedCoding: 'absent',
      responseCoding: 'absent',
      configuredFraming: 'unobserved',
      headersSent: false,
      responseStarted: false,
      responseStartedAtMs: null,
      startedAtMs: started,
      closed: false,
      finished: false,
      closedAfterMs: null,
    };
    if (events.length < 4096) events.push(event);
    socket.on('error', () => {});
    socket.on('close', () => {
      stalledConnections.delete(socket);
      event.closed = true;
      event.closedAfterMs = Date.now() - started;
    });
    socket.resume();
  });
  const control = createHttpServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/reset') {
      events.length = 0;
      res.end('{}');
    } else if (req.method === 'GET' && req.url === '/events') res.end(JSON.stringify(events));
    else res.writeHead(404).end('{}');
  });
  const close = async () => {
    stalledConnections.forEach((socket) => socket.destroy());
    await Promise.all(
      [...servers, control].map(async (server) => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
    await new Promise<void>((resolve) => stalledTls.close(() => resolve()));
  };
  try {
    for (const [index, server] of servers.entries()) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(basePort + index, host, resolve);
      });
    }
    if (identityProfile) {
      const ca = await readFile(`${directory}/ca.pem`);
      for (const path of framingPaths) {
        const methods = path === '/retry-status' ? ['GET', 'POST', 'DELETE'] : ['GET'];
        for (const method of methods) {
          try {
            controls.set(method + ' ' + path, await probeResponse(basePort, ca, path, method));
          } catch {
            /* Missing control remains unconfirmed in the verifier. */
          }
        }
      }
      events.length = 0;
    }
    await new Promise<void>((resolve, reject) => {
      control.once('error', reject);
      control.listen(basePort + 5, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve, reject) => {
      stalledTls.once('error', reject);
      stalledTls.listen(basePort + 6, host, resolve);
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
  const port = Number(process.env.FIXTURE_PORT ?? '9443');
  if (!Number.isInteger(port) || port < 1024 || port > 65529)
    throw new Error('Invalid fixture port');
  const fixture = await startFixture(
    directory,
    port,
    process.env.FIXTURE_HOST ?? '127.0.0.1',
    process.env.FIXTURE_IDENTITY === '1',
  );
  process.stdout.write(
    `Fixture ports ${port} to ${port + 6}. Control on loopback port ${port + 5}.\n`,
  );
  process.once('SIGINT', () => {
    void fixture.close();
  });
  process.once('SIGTERM', () => {
    void fixture.close();
  });
}
