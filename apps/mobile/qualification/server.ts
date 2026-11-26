import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import process from 'node:process';
import type { TLSSocket } from 'node:tls';
import { createSecureContext } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import {
  cancelNeighbour,
  firstBearer,
  invalidUtf8ByteValues,
  limit,
  message,
  postBody,
  prefix as standardJsonScope,
  probes,
  retryFramingFaults,
  secondBearer,
} from './standard-json-scenarios.ts';

export const fixtureJson = JSON.stringify({ message });
const exactJson = JSON.stringify({ data: 'x'.repeat(limit - 11) });
const smallGzip = gzipSync('{}');
const fixtureBytes = Buffer.from(fixtureJson);
const fixturePostBytes = Buffer.from(JSON.stringify(postBody));
const fixtureGzip = gzipSync(fixtureBytes);
const chunkedBodies = new Map([
  ['/chunked-coding-absent', fixtureBytes],
  ['/chunked-coding-gzip', fixtureGzip],
]);
const allowedRoutes = new Set([
  ...probes.map(({ path }) => path),
  '/reuse/one',
  '/reuse/two',
  '/identity',
  '/slow/concurrency-one',
  '/slow/neighbour',
  '/third-reservation',
  '/session-delete',
  '/session-delete-loss',
  '/recover-bad-length',
  '/recover-json',
  '/loss-get-cancel',
  '/invalid-utf8',
]);

function coding(value: unknown) {
  if (value === undefined) return 'absent';
  if (typeof value !== 'string') return 'other';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'identity' || normalized === 'gzip') return normalized;
  return normalized.includes(',') ? 'stacked' : 'other';
}

export async function startFixture(
  directory: string,
  basePort = 29443,
  host = '127.0.0.1',
  standardLab?: {
    routes: ReadonlyMap<string, string>;
    primaryCertificate: 'server' | 'wrong';
  },
) {
  let nextConnectionId = 1;
  const runtimeSockets = new Set<Socket>();
  const connections: Array<{
    id: number;
    destination: string;
    acceptedAtMs: number;
    tlsEstablishedAtMs?: number;
    closedAtMs: number | null;
    receivedBytes: boolean;
    fixtureName: boolean;
    tls: string | null;
  }> = [];
  const socketsByEndpoint = new Map<string, (typeof connections)[number]>();
  const endpoint = (destination: string, socket: Socket) => destination + ':' + socket.remotePort;
  let overflow = false;
  function trackConnection(destination: string, socket: Socket) {
    const address = endpoint(destination, socket);
    const entry: (typeof connections)[number] = {
      id: nextConnectionId++,
      destination,
      acceptedAtMs: Date.now(),
      closedAtMs: null as number | null,
      receivedBytes: false,
      fixtureName: false,
      tls: null as string | null,
    };
    if (connections.length < 4096) connections.push(entry);
    else overflow = true;
    socketsByEndpoint.set(address, entry);
    runtimeSockets.add(socket);
    socket.once('close', () => {
      entry.receivedBytes ||= socket.bytesRead > 0;
      entry.closedAtMs = Date.now();
      socketsByEndpoint.delete(address);
      runtimeSockets.delete(socket);
    });
  }
  const events: Array<{
    destination: string;
    path: string;
    method: string;
    connectionId?: number;
    httpVersion?: string;
    authorization: boolean;
    authorizationMatchesFixture: boolean;
    authorizationMatchesSecond?: boolean;
    requestNoStore?: boolean;
    cookie: boolean;
    contentTypeIsJson: boolean;
    postBodyMatchesFixture: boolean;
    requestedCoding: ReturnType<typeof coding>;
    responseCoding: ReturnType<typeof coding>;
    configuredFraming: 'length' | 'chunked' | 'other' | 'unobserved';
    configuredOversizeLength?: boolean;
    heldLengthEnd?: 'peer-close' | 'fixture-watchdog' | 'finished' | 'socket-error';
    fixtureCut?: boolean;
    fixtureCutAtMs?: number;
    framingFault?: string;
    framingFaultOfferedAtMs?: number;
    framingFaultConfirmedAtMs?: number;
    iosPrimaryTarget?: boolean;
    retryAfterZero?: boolean;
    requestComplete?: boolean;
    processed?: boolean;
    headersSent: boolean;
    responseStatus?: number;
    responseStarted: boolean;
    responseStartedAtMs: number | null;
    startedAtMs: number;
    closed: boolean;
    finished: boolean;
    finishedAtMs?: number;
    closedAfterMs: number | null;
  }> = [];
  const revoked = new Set<string>();
  const handler = (destination: string) => (req: IncomingMessage, res: ServerResponse) => {
    const requestPath = new URL(req.url ?? '/', 'https://fixture.invalid').pathname;
    const labRoute = standardLab?.routes.get(req.method + ' ' + requestPath);
    const standardRoute = requestPath.slice(standardJsonScope.length);
    const knownRoute =
      requestPath.startsWith(standardJsonScope + '/') && allowedRoutes.has(standardRoute);
    const path = standardLab
      ? labRoute
      : knownRoute
        ? standardRoute
        : requestPath === '/destination'
          ? '/destination'
          : undefined;
    if (events.length >= 4096) {
      overflow = true;
      res.writeHead(503).end();
      return;
    }
    const started = Date.now();
    const event: (typeof events)[number] = {
      destination,
      path: path ? requestPath : '/unexpected',
      method: req.method ?? '',
      authorization: !!req.headers.authorization,
      authorizationMatchesFixture: false,
      cookie: !!req.headers.cookie,
      contentTypeIsJson: req.headers['content-type'] === 'application/json',
      postBodyMatchesFixture: false,
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
    const authorization = req.headersDistinct.authorization ?? [];
    event.authorization = authorization.length > 0;
    event.authorizationMatchesFixture =
      authorization.length === 1 && authorization[0] === 'Bearer ' + firstBearer;
    event.authorizationMatchesSecond =
      authorization.length === 1 && authorization[0] === 'Bearer ' + secondBearer;
    event.requestNoStore = req.headers['cache-control'] === 'no-store';
    if (labRoute || knownRoute)
      event.iosPrimaryTarget =
        req.url === requestPath &&
        req.headersDistinct.host?.length === 1 &&
        req.headers.host === 'localhost:' + basePort;
    if (path && retryFramingFaults.has(path))
      req.once('end', () => {
        event.requestComplete = req.complete;
      });
    const connection = socketsByEndpoint.get(endpoint(destination, req.socket));
    if (connection) event.connectionId = connection.id;
    event.httpVersion = req.httpVersion;
    events.push(event);
    const recordHeaders = () => {
      event.headersSent = res.headersSent;
      if (!event.headersSent) return;
      event.responseStatus = res.statusCode;
      if (path === '/retry-status-length')
        event.retryAfterZero = res.statusCode === 503 && res.getHeader('Retry-After') === '0';
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
      event.finishedAtMs = Date.now();
    });
    res.on('close', () => {
      recordHeaders();
      event.closed = true;
      event.closedAfterMs = Date.now() - started;
    });
    const offerFramingFault = (fault: string) => {
      event.framingFault = fault;
      event.framingFaultOfferedAtMs = Date.now();
      return () => {
        event.framingFaultConfirmedAtMs = Date.now();
      };
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!path) {
      req.resume();
      res.writeHead(404).end('{}');
      return;
    }
    if (['/session-delete', '/session-delete-loss'].includes(path)) {
      let bodyBytes = 0;
      req.on('data', (chunk: Buffer) => {
        bodyBytes += chunk.length;
      });
      req.on('end', () => {
        event.requestComplete = req.complete && bodyBytes === 0;
        if (!event.requestComplete || !event.authorizationMatchesFixture) {
          res.writeHead(400, { 'Content-Length': 2 }).end('{}');
          return;
        }
        if (req.method === 'DELETE' && !revoked.has(path)) {
          revoked.add(path);
          event.processed = true;
          if (path === '/session-delete-loss') {
            event.fixtureCut = true;
            res.destroy();
          } else {
            res.removeHeader('Content-Type');
            res.writeHead(204).end();
          }
        } else {
          res.writeHead(revoked.has(path) ? 401 : 405, { 'Content-Length': 2 }).end('{}');
        }
      });
      return;
    }
    if (path === '/loss-get-cancel') {
      req.resume();
      req.on('end', () => {
        event.requestComplete = req.complete;
        const first = events.filter((row) => row.path === event.path).length === 1;
        if (first) {
          event.processed = req.complete;
          event.fixtureCut = true;
          event.fixtureCutAtMs = Date.now();
          res.destroy();
          return;
        }
        res.setHeader('Content-Length', fixtureBytes.length);
        res.write(fixtureBytes.subarray(0, 2), (error) => {
          if (error) return;
          event.responseStarted = true;
          event.responseStartedAtMs = Date.now();
        });
        const timer = setTimeout(() => res.end(fixtureBytes.subarray(2)), 3500);
        res.once('close', () => clearTimeout(timer));
      });
      return;
    }
    if (
      [
        '/request-body',
        '/loss-get',
        '/loss-get-always',
        '/loss-post',
        '/loss-post-prefix',
        '/retry-status-length',
      ].includes(path)
    ) {
      let received = 0;
      let matches = true;
      req
        .on('data', (chunk: Buffer) => {
          matches &&= chunk.equals(fixturePostBytes.subarray(received, received + chunk.length));
          received += chunk.length;
        })
        .on('end', () => {
          event.requestComplete = req.complete;
          event.postBodyMatchesFixture =
            req.complete && matches && received === fixturePostBytes.length;
          if (path === '/retry-status-length') {
            res.writeHead(503, { 'Retry-After': '0', 'Content-Length': 2 }).end('{}');
            return;
          }
          if (path !== '/request-body') {
            const first = events.filter((row) => row.path === event.path).length === 1;
            if (path === '/loss-get' && !first) {
              res.setHeader('Content-Length', fixtureBytes.length);
              res.end(fixtureBytes);
              return;
            }
            event.processed =
              req.complete &&
              (req.method === 'GET' || (req.method === 'POST' && event.postBodyMatchesFixture));
            if (path === '/loss-post-prefix' && first && event.processed) {
              res.setHeader('Content-Length', '1000');
              res.flushHeaders();
              res.write('{}', (error) => {
                if (error) return;
                event.responseStarted = true;
                event.responseStartedAtMs = Date.now();
                const timer = setTimeout(() => {
                  event.fixtureCut = true;
                  res.destroy();
                }, 100);
                res.once('close', () => clearTimeout(timer));
              });
            } else {
              event.fixtureCut = true;
              if (req.method === 'GET') event.fixtureCutAtMs = Date.now();
              res.destroy();
            }
            return;
          }
          res.setHeader('Content-Length', fixtureBytes.length);
          res.end(fixtureBytes);
        });
      return;
      return;
    }
    req.resume();
    const match = /^\/redirect\/(302|303|307)\/(same|host|http)$/.exec(path);

    if (match) {
      const hostname = req.headers.host?.startsWith('localhost:') ? 'localhost' : '10.0.2.2';
      const target =
        match[2] === 'http'
          ? `http://${hostname}:${basePort + 2}`
          : `https://${hostname}:${basePort + (match[2] === 'host' ? 1 : 0)}`;
      res
        .writeHead(Number(match[1]), {
          Location: target + (standardLab ? '/v1/session' : '/destination'),
        })
        .end();
    } else if (['/slow/neighbour', '/slow/timeout', '/slow/concurrency-one'].includes(path)) {
      res.setHeader('Content-Length', fixtureBytes.length);
      res.flushHeaders();
      res.write(fixtureBytes.subarray(0, 2), (error) => {
        if (!error) {
          event.responseStarted = true;
          event.responseStartedAtMs = Date.now();
        }
      });
      const timer = setTimeout(
        () => res.end(fixtureBytes.subarray(2)),
        path === '/slow/neighbour'
          ? cancelNeighbour.neighbourHoldMs
          : path === '/slow/concurrency-one'
            ? cancelNeighbour.firstHoldMs
            : 3000,
      );
      res.once('close', () => clearTimeout(timer));
    } else if (path === '/length' || path === '/recover-bad-length') {
      event.fixtureCut = false;
      res.setHeader('Content-Length', '1000');
      res.writeHead(200);
      res.flushHeaders();
      res.write('{}');
      const timer = setTimeout(() => {
        if (res.destroyed) return;
        event.fixtureCut = true;
        res.once('close', offerFramingFault('incomplete-length'));
        res.destroy();
      }, 100);
      res.on('close', () => clearTimeout(timer));
    } else if (path === '/unframed') {
      res.useChunkedEncodingByDefault = false;
      res.setHeader('Connection', 'close');
      res.once('finish', offerFramingFault('close-delimited'));
      res.flushHeaders();
      res.end('{}');
    } else if (path === '/gzip-truncated') {
      const sample = smallGzip.subarray(0, -4);
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', sample.length);
      res.end(sample);
    } else if (['/length-conflict', '/length-and-chunked'].includes(path)) {
      const conflictingLengths = path.endsWith('length-conflict');
      const framing = conflictingLengths
        ? 'Content-Length: 3\r\n\r\n{}'
        : 'Transfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n';
      const socket = res.socket!;
      const confirm = offerFramingFault(
        conflictingLengths ? 'conflicting-lengths' : 'length-and-transfer',
      );
      socket.once('finish', () => {
        event.fixtureCut = true;
        confirm();
      });
      socket.end('HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n' + framing);
    } else if (path === '/identity-exact') {
      res.setHeader('Content-Length', exactJson.length);
      res.end(exactJson);
    } else if (chunkedBodies.has(path)) {
      res.setHeader('Transfer-Encoding', 'chunked');
      if (path === '/chunked-coding-gzip') res.setHeader('Content-Encoding', 'gzip');
      if (path === '/chunked-coding-absent')
        res.once('finish', offerFramingFault('unsupported-chunked'));
      res.end(chunkedBodies.get(path));
    } else if (path === '/chunked-incomplete-end' || path === '/truncated') {
      // Offer the entire malformed frame and EOF together.
      event.fixtureCut = false;
      const socket = res.socket!;
      const prefix =
        'HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n' +
        'Content-Type: application/json\r\n\r\n2\r\n{}\r\n';
      const confirm = offerFramingFault(
        path === '/truncated' ? 'missing-final-chunk' : 'incomplete-chunk-terminator',
      );
      socket.once('finish', () => {
        event.fixtureCut = true;
        event.configuredFraming = 'chunked';
        confirm();
      });
      socket.end(prefix + (path === '/truncated' ? '' : '0\r\n'));
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
    } else if (path === '/coding-gzip') {
      const bytes = fixtureGzip;
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', bytes.length);
      res.end(bytes);
    } else if (path === '/json' || path === '/coding-absent' || path === '/recover-json') {
      res.setHeader('Content-Length', Buffer.byteLength(fixtureJson));
      res.end(fixtureJson);
    } else if (path === '/coding-other' || path === '/coding-stacked') {
      res.setHeader('Content-Encoding', path === '/coding-other' ? 'br' : 'gzip, gzip');
      const bytes = path === '/coding-other' ? brotliCompressSync('{}') : gzipSync(smallGzip);
      res.end(bytes);
    } else if (path === '/no-content') {
      res.removeHeader('Content-Type');
      res.writeHead(204).end();
    } else if (path === '/invalid-utf8') {
      const bytes = Buffer.from(invalidUtf8ByteValues);
      res.setHeader('Content-Length', bytes.length);
      res.end(bytes);
    } else if (path === '/identity') {
      if (event.authorizationMatchesFixture)
        res.setHeader('Set-Cookie', 'fixture=only; Secure; HttpOnly; Path=/');
      const identity = event.authorizationMatchesFixture
        ? 'first'
        : event.authorizationMatchesSecond
          ? 'second'
          : event.authorization
            ? 'unexpected'
            : 'anonymous';
      const content = JSON.stringify({ message, identity });
      res.setHeader('Content-Length', Buffer.byteLength(content));
      res.end(content);
    } else if (path === '/challenge') {
      res.setHeader('Content-Length', 2);
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' }).end('{}');
    } else if (['/destination', '/reuse/one', '/reuse/two'].includes(path)) {
      res.setHeader('Content-Length', fixtureBytes.length);
      res.end(fixtureJson);
    } else res.writeHead(404).end('{}');
  };
  const destinations = ['A', 'B', 'C', 'unknown', 'wrong'] as const;
  const credentials = async (name: string) => ({
    key: await readFile(`${directory}/${name}.key`),
    cert: await readFile(`${directory}/${name}.pem`),
  });
  const httpsServer = async (name: string, destination: string) => {
    const keys = await credentials(name);
    const context = createSecureContext(keys);
    return createHttpsServer(
      {
        ...keys,
        SNICallback(this: TLSSocket, servername, callback) {
          const connection = socketsByEndpoint.get(endpoint(destination, this));
          if (connection) {
            // Node parsed a ClientHello even if the wrapped raw socket's counter is empty.
            connection.receivedBytes = true;
            connection.fixtureName = servername === 'localhost';
          }
          callback(null, context);
        },
      },
      handler(destination),
    );
  };
  const servers = [
    await httpsServer(standardLab?.primaryCertificate ?? 'server', 'A'),
    await httpsServer('server', 'B'),
    createHttpServer(handler('C')),
    await httpsServer('unknown', 'unknown'),
    await httpsServer('wrong', 'wrong'),
  ];
  for (const [index, server] of servers.entries()) {
    const destination = destinations[index]!;
    server.on('connection', (socket: Socket) => trackConnection(destination, socket));
    server.on('secureConnection', (socket: TLSSocket) => {
      const connection = socketsByEndpoint.get(endpoint(destination, socket));
      if (connection) {
        connection.receivedBytes = true;
        connection.tls = socket.getProtocol();
        connection.tlsEstablishedAtMs = Date.now();
      }
    });
  }
  const control = createHttpServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/events') res.end(JSON.stringify(events));
    else if (req.method === 'GET' && req.url === '/runtime')
      res.end(JSON.stringify({ overflow, events, connections }));
    else res.writeHead(404).end('{}');
  });
  const close = async () => {
    runtimeSockets.forEach((socket) => socket.destroy());
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
  return {
    close,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error('Certificate directory required');
  const port = Number(process.env.FIXTURE_PORT ?? '29443');
  if (process.env.BUNNY_HTTPS_STANDARD_JSON !== '1')
    throw new Error('Enable the standard JSON fixture explicitly');
  if (!Number.isInteger(port) || port < 1024 || port > 65530)
    throw new Error('Invalid fixture port');
  const fixture = await startFixture(directory, port, process.env.FIXTURE_HOST ?? '127.0.0.1');
  process.stdout.write(
    `Fixture ports ${port} to ${port + 5}. Control on loopback port ${port + 5}.\n`,
  );
  process.once('SIGINT', () => {
    void fixture.close();
  });
  process.once('SIGTERM', () => {
    void fixture.close();
  });
}
