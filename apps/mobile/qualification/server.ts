import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer, get as httpsGet } from 'node:https';
import type { Socket } from 'node:net';
import { createServer as createTcpServer } from 'node:net';
import process from 'node:process';
import type { TLSSocket } from 'node:tls';
import { createSecureContext } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import {
  firstBearer,
  limit,
  message,
  postBody,
  prefix as standardJsonScope,
  secondBearer,
} from './standard-json-scenarios.ts';

export const fixtureJson = JSON.stringify({ message });
const exactJson = JSON.stringify({ data: 'x'.repeat(limit - 11) });
const exactGzip = gzipSync(exactJson);
const smallGzip = gzipSync('{}');
const fixtureBytes = Buffer.from(fixtureJson);
const fixturePostBytes = Buffer.from(JSON.stringify(postBody));
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

function sendRetryStatus(response: ServerResponse, length: boolean) {
  response.setHeader(length ? 'Content-Length' : 'Transfer-Encoding', length ? '2' : 'chunked');
  response.writeHead(503, { 'Retry-After': '0' }).end('{}');
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
  runtimeRoutes?: ReadonlyMap<string, string>,
  fixtureId?: string,
  standardJsonProfile = false,
) {
  const trackWire = runtimeRoutes !== undefined || standardJsonProfile;
  const controls = new Map<string, Control>();
  const connectionIds = new WeakMap<Socket, number>();
  let nextConnectionId = 1;
  const runtimeSockets = new Set<Socket>();
  const connections: Array<{
    id: number;
    destination: string;
    acceptedAtMs: number;
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
    const entry = {
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
    fixtureCutAtMs?: number;
    retryAfterZero?: boolean;
    requestComplete?: boolean;
    processed?: boolean;
    offeredLimitPlusOne?: boolean;
    encodedBelowLimit?: boolean;
    requestedRuntimeCoding?: boolean;
    ambientFixtureCookieMatches?: boolean;
    responseFixtureCookie?: 'none' | 'ambient' | 'native' | 'unexpected';
    headersSent: boolean;
    responseStatus?: number;
    responseStarted: boolean;
    responseStartedAtMs: number | null;
    startedAtMs: number;
    closed: boolean;
    finished: boolean;
    closedAfterMs: number | null;
  }> = [];
  const handler = (destination: string) => (req: IncomingMessage, res: ServerResponse) => {
    const requestPath = new URL(req.url ?? '/', 'https://fixture.invalid').pathname;
    const runtimeRoute = runtimeRoutes?.get(requestPath);
    const standardJson = standardJsonProfile && requestPath.startsWith(standardJsonScope + '/');
    const path = standardJson
      ? requestPath.slice(standardJsonScope.length)
      : (runtimeRoute ?? requestPath.replace(/^\/v1\/https-qualification(?=\/)/, ''));
    const safePath = evidencePath(path);
    const standardJsonRoute =
      /^\/(?:loss-(?:get(?:-always)?|post(?:-prefix)?)|length-conflict|length-and-chunked|identity|slow\/neighbour)$/.test(
        path,
      )
        ? path
        : safePath;
    const runtimeCookieStep =
      runtimeRoute &&
      /^\/curl-cookies\/(baseline|seed|expo-probe|native-probe|native-set|expo-after)$/.exec(
        path,
      )?.[1];
    const cookieScope = requestPath.slice(0, requestPath.lastIndexOf('/') + 1);
    const fixtureCookie = (name: 'expo' | 'native') =>
      `bunny_fixture_${name}=synthetic; Secure; HttpOnly; Max-Age=120; Path=${cookieScope}`;
    if (events.length >= 4096) {
      overflow = true;
      res.writeHead(503).end();
      return;
    }
    const started = Date.now();
    const cookieNames = (req.headers.cookie ?? '')
      .split(';')
      .map((cookie) => cookie.split('=', 1)[0]?.trim());
    const event: (typeof events)[number] = {
      destination,
      path: runtimeRoute
        ? requestPath
        : standardJson && standardJsonRoute !== '/unexpected'
          ? standardJsonScope + standardJsonRoute
          : evidencePath(requestPath),
      method:
        runtimeRoutes && !['GET', 'POST', 'DELETE'].includes(req.method ?? '')
          ? 'unexpected'
          : (req.method ?? ''),
      authorization: !!req.headers.authorization,
      authorizationMatchesFixture: req.headers.authorization === 'Bearer ' + firstBearer,
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
    if (standardJson) {
      event.authorizationMatchesSecond = req.headers.authorization === 'Bearer ' + secondBearer;
      event.requestNoStore = req.headers['cache-control'] === 'no-store';
    }
    if (trackWire) {
      const connection = socketsByEndpoint.get(endpoint(destination, req.socket));
      if (connection) event.connectionId = connection.id;
      event.httpVersion = req.httpVersion;
    } else if (recordConnectionIds) {
      let connectionId = connectionIds.get(req.socket);
      if (connectionId === undefined) {
        connectionId = nextConnectionId++;
        connectionIds.set(req.socket, connectionId);
      }
      event.connectionId = connectionId;
      event.httpVersion = req.httpVersion;
    }
    if (runtimeRoutes) {
      event.requestedRuntimeCoding = req.headers['accept-encoding'] === 'gzip, identity';
      if (runtimeCookieStep)
        event.ambientFixtureCookieMatches =
          req.headers.cookie?.trim() === 'bunny_fixture_expo=synthetic';
    }
    events.push(event);
    const recordHeaders = () => {
      event.headersSent = res.headersSent;
      if (!event.headersSent) return;
      if (standardJson) event.responseStatus = res.statusCode;
      if (standardJson && path === '/retry-status-length')
        event.retryAfterZero = res.statusCode === 503 && res.getHeader('Retry-After') === '0';
      event.responseCoding = coding(res.getHeader('Content-Encoding'));
      if (runtimeCookieStep) {
        const field = res.getHeader('Set-Cookie');
        event.responseFixtureCookie =
          field === undefined
            ? 'none'
            : field === fixtureCookie('expo')
              ? 'ambient'
              : field === fixtureCookie('native')
                ? 'native'
                : 'unexpected';
      }
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
      !standardJson &&
      (identityProfile || runtimeRoute) &&
      path !== '/coding-absent' &&
      path !== '/chunked-coding-absent' &&
      path !== '/no-content'
    )
      res.setHeader('Content-Encoding', 'identity');
    if (runtimeRoute && (path === '/curl-cut-before' || path === '/curl-cut-after')) {
      event.fixtureCut = false;
      event.requestComplete = false;
      event.processed = false;
      if (path === '/curl-cut-before' && req.method === 'POST') {
        req.once('data', (chunk: Buffer) => {
          event.requestComplete = req.complete;
          event.fixtureCut = chunk.length > 0 && !req.complete;
          res.destroy();
        });
        return;
      }
      let body = '';
      req
        .setEncoding('utf8')
        .on('data', (chunk: string) => {
          body += chunk.slice(0, Math.max(0, 101 - body.length));
        })
        .on('end', () => {
          event.requestComplete = req.complete;
          event.postBodyMatchesFixture = body === '{"message":"fixture 🐰"}';
          // Only the after case commits the synthetic effect. Both lose the full response.
          event.processed =
            path === '/curl-cut-after' &&
            req.complete &&
            (req.method !== 'POST' || event.postBodyMatchesFixture);
          if (event.processed) {
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
            res.destroy();
          }
        });
      return;
    }
    if (
      path === '/request-body' ||
      (standardJson &&
        [
          '/loss-get',
          '/loss-get-always',
          '/loss-post',
          '/loss-post-prefix',
          '/retry-status-length',
        ].includes(path))
    ) {
      if (runtimeRoute || standardJson) {
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
            if (standardJson && path === '/retry-status-length') {
              sendRetryStatus(res, true);
              return;
            }
            if (standardJson && path !== '/request-body') {
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
      }
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
    } else if (standardJson && path === '/slow/neighbour') {
      res.setHeader('Content-Length', fixtureBytes.length);
      res.flushHeaders();
      res.write(fixtureBytes.subarray(0, 2), (error) => {
        if (!error) {
          event.responseStarted = true;
          event.responseStartedAtMs = Date.now();
        }
      });
      const timer = setTimeout(() => res.end(fixtureBytes.subarray(2)), 1200);
      res.once('close', () => clearTimeout(timer));
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
    } else if (runtimeRoute && path === '/curl-gzip-concatenated') {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', smallGzip.length * 2);
      res.end(Buffer.concat([smallGzip, smallGzip]));
    } else if (runtimeRoute && path === '/curl-chunked-trailer') {
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Trailer', 'X-Fixture');
      res.addTrailers({ 'X-Fixture': 'only' });
      res.end('{}');
    } else if (runtimeRoute && (path === '/curl-chunked-exact' || path === '/curl-memory')) {
      if (path === '/curl-chunked-exact') {
        res.setHeader('Transfer-Encoding', 'chunked');
        res.end(exactJson);
      } else {
        res.setHeader('Content-Length', exactJson.length);
        res.flushHeaders();
        const timer = setTimeout(() => res.end(exactJson), 700);
        res.on('close', () => clearTimeout(timer));
      }
    } else if (
      (runtimeRoute && ['/curl-length-conflict', '/curl-length-and-chunked'].includes(path)) ||
      (standardJson && ['/length-conflict', '/length-and-chunked'].includes(path))
    ) {
      event.fixtureCut = true;
      const framing = path.endsWith('length-conflict')
        ? 'Content-Length: 3\r\n\r\n{}'
        : 'Transfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n';
      res.socket!.end('HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n' + framing);
    } else if (runtimeRoute && path === '/standard-gzip-limit-plus-one') {
      const decoded = exactJson + ' ';
      const encoded = gzipSync(decoded);
      event.offeredLimitPlusOne = Buffer.byteLength(decoded) === 1_048_577;
      event.encodedBelowLimit = encoded.length < 1_048_576;
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', encoded.length);
      res.end(encoded);
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
        'HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n' +
          (standardJson ? '' : 'Content-Encoding: identity\r\n') +
          'Content-Type: application/json\r\n\r\n2\r\n{}\r\n',
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
      const extra = setTimeout(() => {
        if (runtimeRoute || standardJson) event.offeredLimitPlusOne = true;
        res.write(' ');
      }, 100);
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
      const bytes = path === '/coding-other' ? brotliCompressSync('{}') : gzipSync(smallGzip);
      if (runtimeRoute) res.setHeader('Content-Length', bytes.length);
      res.end(bytes);
    } else if (path === '/retry-status-gzip') {
      res.setHeader('Content-Encoding', 'gzip');
      res.writeHead(503, { 'Retry-After': '0', 'Content-Length': smallGzip.length }).end(smallGzip);
    } else if (path === '/no-content') {
      res.removeHeader('Content-Type');
      res.writeHead(204).end();
    } else if (path === '/invalid-utf8') {
      const bytes = Buffer.from([0x22, 0xc0, 0x22]);
      if (runtimeRoute) res.setHeader('Content-Length', bytes.length);
      res.end(bytes);
    } else if (path === '/retry-status' || path === '/retry-status-length') {
      sendRetryStatus(res, path === '/retry-status-length');
    } else if (path === '/drop-before-headers') {
      res.destroy();
    } else if (path === '/cookie') {
      res.setHeader('Set-Cookie', 'fixture=only; Secure; HttpOnly; Path=/');
      res.end(fixtureJson);
    } else if (standardJson && path === '/identity') {
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
    } else if (runtimeCookieStep) {
      if (runtimeCookieStep === 'seed') res.setHeader('Set-Cookie', fixtureCookie('expo'));
      if (runtimeCookieStep === 'native-set') res.setHeader('Set-Cookie', fixtureCookie('native'));
      res.setHeader('Content-Length', fixtureBytes.length);
      res.end(fixtureBytes);
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
  const destinations = ['A', 'B', 'C', 'unknown', 'wrong'] as const;
  const credentials = async (name: string) => ({
    key: await readFile(`${directory}/${name}.key`),
    cert: await readFile(`${directory}/${name}.pem`),
  });
  const httpsServer = async (name: string, destination: string) => {
    const keys = await credentials(name);
    if (!trackWire) return createHttpsServer(keys, handler(destination));
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
    await httpsServer('server', 'A'),
    await httpsServer('server', 'B'),
    createHttpServer(handler('C')),
    await httpsServer('unknown', 'unknown'),
    await httpsServer('wrong', 'wrong'),
  ];
  if (trackWire) {
    for (const [index, server] of servers.entries()) {
      const destination = destinations[index]!;
      server.on('connection', (socket: Socket) => trackConnection(destination, socket));
      server.on('secureConnection', (socket: TLSSocket) => {
        const connection = socketsByEndpoint.get(endpoint(destination, socket));
        if (connection) {
          connection.receivedBytes = true;
          connection.tls = socket.getProtocol();
        }
      });
    }
  }
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
    if (trackWire) {
      trackConnection('stalled-tls', socket);
      const connection = socketsByEndpoint.get(endpoint('stalled-tls', socket));
      if (connection) event.connectionId = connection.id;
    }
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
    if (!fixtureId && req.method === 'POST' && req.url === '/reset') {
      events.length = 0;
      res.end('{}');
    } else if (req.method === 'GET' && req.url === '/events') res.end(JSON.stringify(events));
    else if (trackWire && req.method === 'GET' && req.url === '/runtime')
      res.end(JSON.stringify({ fixtureId, overflow, events, connections }));
    else res.writeHead(404).end('{}');
  });
  const close = async () => {
    stalledConnections.forEach((socket) => socket.destroy());
    runtimeSockets.forEach((socket) => socket.destroy());
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
    if (identityProfile && !runtimeRoutes) {
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
  return {
    close,
    addresses: () => [...servers, control, stalledTls].map((server) => server.address()),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error('Certificate directory required');
  const port = Number(process.env.FIXTURE_PORT ?? '9443');
  const standardJson = process.env.BUNNY_HTTPS_STANDARD_JSON === '1';
  if (standardJson && process.env.FIXTURE_IDENTITY === '1')
    throw new Error('Choose one fixture profile');
  if (!Number.isInteger(port) || port < 1024 || port > 65529)
    throw new Error('Invalid fixture port');
  const fixture = await startFixture(
    directory,
    port,
    process.env.FIXTURE_HOST ?? '127.0.0.1',
    process.env.FIXTURE_IDENTITY === '1',
    false,
    undefined,
    undefined,
    standardJson,
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
