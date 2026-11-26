import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { get as httpGet } from 'node:http';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { fixtureJson, startFixture } from '../qualification/server.js';
import { describeNativeResult } from '../qualification/standard-json-diagnostics';
import {
  firstBearer,
  marker,
  postBody,
  prefix as standardPrefix,
  probes,
  requestTimeoutMs,
} from '../qualification/standard-json-scenarios';
import { verifyStandardJson } from '../qualification/verify-standard-json';

const directory = join(tmpdir(), `bunny-https-test-${crypto.randomUUID()}`);
const port = 19443;
let fixture: Awaited<ReturnType<typeof startFixture>>;
let ca: Buffer;
const get = (path: string, offset = 0, abort = false, acceptEncoding?: string) =>
  new Promise<{
    status: number;
    bytes: Buffer;
    location: string | undefined;
    contentType: string | undefined;
    headers: IncomingHttpHeaders;
  }>((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: port + offset,
        path,
        ca,
        headers: acceptEncoding
          ? { 'accept-encoding': acceptEncoding, 'cache-control': 'no-store' }
          : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          if (abort) req.destroy(new Error('fixture abort'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            bytes: Buffer.concat(chunks),
            location: response.headers.location,
            contentType: response.headers['content-type'],
            headers: response.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
beforeAll(async () => {
  execFileSync('bash', ['qualification/certificates.sh', directory], { stdio: 'pipe' });
  ca = readFileSync(join(directory, 'ca.pem'));
  fixture = await startFixture(
    directory,
    port,
    '127.0.0.1',
    true,
    true,
    undefined,
    undefined,
    true,
  );
});
afterAll(async () => {
  await fixture?.close();
  rmSync(directory, { recursive: true, force: true });
});
it('serves exact UTF-8, invalid JSON and decoded gzip larger than one MiB', async () => {
  expect((await get('/json')).bytes.toString()).toBe(fixtureJson);
  const invalid = (await get('/invalid')).bytes.toString();
  expect(() => JSON.parse(invalid)).toThrow();
  expect(gunzipSync((await get('/gzip')).bytes).toString()).toBe(fixtureJson);
  expect(gunzipSync((await get('/gzip-exact')).bytes).length).toBe(1_048_576);
  expect(gunzipSync((await get('/oversize')).bytes).length).toBeGreaterThan(1_048_576);
});
it('separates malformed gzip payloads from incomplete HTTP responses', async () => {
  const gzip = (await get('/gzip-exact')).bytes;
  const invalid = ['truncated', 'bad-crc', 'truncated-stream'];
  const [noSize, badCrc, truncatedStream] = await Promise.all(
    invalid.map((variant) => get('/gzip-' + variant)),
  );
  for (const response of [noSize!, badCrc!, truncatedStream!]) {
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers['content-length']).toBe(String(response.bytes.length));
    expect(() => gunzipSync(response.bytes)).toThrow();
  }
  expect(badCrc!.bytes.subarray(0, -8)).toEqual(noSize!.bytes.subarray(0, -4));
  expect(badCrc!.bytes.length - noSize!.bytes.length).toBe(4);
  expect(truncatedStream!.bytes).toEqual(gzip.subarray(0, Math.floor(gzip.length / 2)));
});
it('varies only the framing of the HTTP 503 controls', async () => {
  const chunked = await get('/retry-status');
  const length = await get('/retry-status-length');
  expect(chunked.status).toBe(503);
  expect(length.status).toBe(503);
  expect(length.bytes).toEqual(chunked.bytes);
  expect(chunked.headers['retry-after']).toBe(length.headers['retry-after']);
  expect(chunked.headers['transfer-encoding']).toBe('chunked');
  expect(chunked.headers['content-length']).toBeUndefined();
  expect(length.headers['content-length']).toBe('2');
  expect(length.headers['transfer-encoding']).toBeUndefined();
});
it('records redirect sources independently of destinations', async () => {
  await fetch(`http://127.0.0.1:${port + 5}/reset`, { method: 'POST' });
  expect((await get('/destination', 0)).status).toBe(200);
  expect((await get('/destination', 1)).status).toBe(200);
  await new Promise<void>((resolve, reject) => {
    httpGet(`http://127.0.0.1:${port + 2}/destination`, (res) => {
      expect(res.statusCode).toBe(200);
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });
  const positive = (await (await fetch(`http://127.0.0.1:${port + 5}/events`)).json()) as {
    destination: string;
    path: string;
  }[];
  expect(positive.map((event) => event.destination)).toEqual(['A', 'B', 'C']);
  await fetch(`http://127.0.0.1:${port + 5}/reset`, { method: 'POST' });
  for (const status of [301, 302, 303, 307, 308])
    for (const target of ['same', 'host', 'http']) {
      const response = await get(`/redirect/${status}/${target}`);
      expect(response.status).toBe(status);
      expect(response.location).toBe(
        `${target === 'http' ? 'http' : 'https'}://10.0.2.2:${port + (target === 'same' ? 0 : target === 'host' ? 1 : 2)}/destination`,
      );
    }
  const events = (await (await fetch(`http://127.0.0.1:${port + 5}/events`)).json()) as {
    path: string;
  }[];
  expect(events).toHaveLength(15);
  expect(events.some((event) => event.path === '/destination')).toBe(false);
});
it('supplies untrusted CA and wrong SAN independently', async () => {
  await expect(get('/json', 3)).rejects.toThrow();
  await expect(get('/json', 4)).rejects.toThrow();
});
it('serves two distinct JSON parts as a mixed-replace response for iOS qualification', async () => {
  const response = await get('/v1/https-qualification/multipart');
  expect(response.status).toBe(200);
  const boundary = /^multipart\/x-mixed-replace; boundary=([\w-]+)$/.exec(
    response.contentType ?? '',
  )?.[1];
  expect(boundary).toBeDefined();
  expect(response.bytes.toString('utf8').split(`--${boundary}`)).toEqual([
    '',
    '\r\nContent-Type: application/json\r\n\r\n{"part":1}\r\n',
    '\r\nContent-Type: application/json\r\n\r\n{"part":2}\r\n',
    '--\r\n',
  ]);
});
it('truncates bodies detectably and records cancellation of slow connection', async () => {
  for (const path of ['/truncated', '/length']) {
    let headers: IncomingHttpHeaders | undefined;
    await expect(
      new Promise<void>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, path, ca }, (response) => {
          headers = response.headers;
          response.resume();
          response.on('error', reject);
          response.on('end', resolve);
        });
        req.on('error', reject);
        req.end();
      }),
    ).rejects.toThrow();
    expect(headers).toBeDefined();
    if (path === '/length') expect(headers?.['content-length']).toBe('1000');
    else {
      expect(headers?.['content-length']).toBeUndefined();
      expect(headers?.['transfer-encoding']).toBe('chunked');
    }
  }
  await expect(get('/slow', 0, true)).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const events = (await (await fetch(`http://127.0.0.1:${port + 5}/events`)).json()) as {
    path: string;
    closed: boolean;
    finished: boolean;
  }[];
  expect(events.findLast((event) => event.path === '/slow')).toMatchObject({
    closed: true,
    finished: false,
  });
});

it.each(['/slow/cancel', '/slow/cancel-length'])(
  'records a flushed body before the client closes %s',
  async (path) => {
    const control = async () =>
      (await (await fetch(`http://127.0.0.1:${port + 5}/events`)).json()) as {
        path: string;
        responseStarted: boolean;
        closed: boolean;
        finished: boolean;
      }[];
    const slow = request({ hostname: '127.0.0.1', port, path, ca });
    let headers: IncomingHttpHeaders | undefined;
    slow.on('error', () => {});
    slow.on('response', (response) => {
      headers = response.headers;
      response.on('error', () => {});
      response.resume();
    });
    slow.end();
    const event = async () => (await control()).findLast((entry) => entry.path === path);
    try {
      await expect
        .poll(event)
        .toMatchObject({ responseStarted: true, closed: false, finished: false });
      await expect.poll(() => headers).toBeDefined();
      if (path.endsWith('-length')) {
        expect(headers?.['content-length']).toBe('1000');
        expect(headers?.['transfer-encoding']).toBeUndefined();
      } else {
        expect(headers?.['transfer-encoding']).toBe('chunked');
        expect(headers?.['content-length']).toBeUndefined();
      }
    } finally {
      slow.destroy();
    }
    await expect
      .poll(event)
      .toMatchObject({ responseStarted: true, closed: true, finished: false });
  },
);

it('scopes both artificial cookies to the current run and records only their presence', async () => {
  const prefix = `/cookies/${crypto.randomUUID()}/`;
  const cookieRequest = (step: string, cookie?: string) =>
    new Promise<string[]>((resolve, reject) => {
      const req = request(
        { hostname: '127.0.0.1', port, path: prefix + step, ca, headers: cookie ? { cookie } : {} },
        (response) => {
          response.on('error', reject);
          response.on('end', () => resolve(response.headers['set-cookie'] ?? []));
          response.resume();
        },
      );
      req.on('error', reject);
      req.end();
    });
  expect(await cookieRequest('baseline')).toEqual([]);
  expect(await cookieRequest('seed')).toEqual([
    `bunny_fixture_expo=synthetic; Secure; HttpOnly; Max-Age=120; Path=${prefix}`,
  ]);
  expect(await cookieRequest('native-set')).toEqual([
    `bunny_fixture_native=synthetic; Secure; HttpOnly; Max-Age=120; Path=${prefix}`,
  ]);
  await cookieRequest('expo-probe', 'bunny_fixture_expo=example-value');
  await cookieRequest(
    'expo-after',
    'bunny_fixture_expo=example-value; bunny_fixture_native=example-value',
  );
  const events = (await (await fetch(`http://127.0.0.1:${port + 5}/events`)).json()) as {
    path: string;
  }[];
  const scoped = events.filter((event) => event.path.startsWith('/cookies/fixture/'));
  expect(scoped[0]).toMatchObject({ expoFixtureCookie: false, nativeFixtureCookie: false });
  expect(scoped[3]).toMatchObject({ expoFixtureCookie: true, nativeFixtureCookie: false });
  expect(scoped[4]).toMatchObject({ expoFixtureCookie: true, nativeFixtureCookie: true });
  expect(JSON.stringify(scoped)).not.toContain('example-value');
});

it('records unknown routes without storing their path or query', async () => {
  const marker = 'synthetic-secret-placeholder';
  expect((await get(`/${marker}?auth=${marker}`)).status).toBe(404);
  const evidence = await (await fetch(`http://127.0.0.1:${port + 5}/events`)).text();
  expect(evidence).toContain('"/unexpected"');
  expect(evidence).not.toContain(marker);
});

it('sends identity controls and deliberately sends coding despite an identity request', async () => {
  const [plain, absent, forcedGzip, exact, oversized, br, stacked, gzip503] = await Promise.all(
    [
      '/json',
      '/coding-absent',
      '/coding-gzip',
      '/identity-exact',
      '/identity-oversize',
      '/coding-other',
      '/coding-stacked',
      '/retry-status-gzip',
    ].map((path) => get(path, 0, false, 'identity')),
  );
  expect(plain?.headers['content-encoding']).toBe('identity');
  expect(absent?.headers['content-encoding']).toBeUndefined();
  expect(absent?.headers['content-length']).toBe(plain?.headers['content-length']);
  expect(absent?.bytes).toEqual(plain?.bytes);
  expect(forcedGzip?.headers['content-encoding']).toBe('gzip');
  expect(gunzipSync(forcedGzip!.bytes)).toEqual(absent?.bytes);
  expect(exact?.headers['content-length']).toBe('1048576');
  expect(exact?.bytes.length).toBe(1_048_576);
  expect(oversized?.headers['transfer-encoding']).toBe('chunked');
  expect(oversized?.bytes.length).toBe(1_048_577);
  expect(br?.headers['content-encoding']).toBe('br');
  expect(brotliDecompressSync(br!.bytes).toString()).toBe('{}');
  expect(stacked?.headers['content-encoding']).toBe('gzip, gzip');
  expect(gunzipSync(gunzipSync(stacked!.bytes)).toString()).toBe('{}');
  expect(gzip503?.status).toBe(503);
  expect(gunzipSync(gzip503!.bytes).toString()).toBe('{}');
  const rows = (await (await fetch(`http://127.0.0.1:${port + 5}/events`)).json()) as {
    path: string;
    requestedCoding: string;
    responseCoding: string;
    headersSent: boolean;
  }[];
  expect(rows.findLast((row) => row.path === '/retry-status-gzip')).toMatchObject({
    requestedCoding: 'identity',
    responseCoding: 'gzip',
    headersSent: true,
  });
});

it('checks both size boundaries and complete and interrupted chunk framing over HTTPS', async () => {
  const prefix = '/v1/https-qualification';
  for (const [path, status] of [
    ['/identity-oversize', 200],
    ['/identity-oversize-error', 503],
  ] as const) {
    const response = await get(prefix + path);
    expect(response.status).toBe(status);
    expect(response.bytes.length).toBe(1_048_577);
    expect(response.headers['content-length']).toBeUndefined();
    expect(response.headers['transfer-encoding']).toBe('chunked');
  }
  const complete = await get(prefix + '/chunked-complete');
  expect(complete.headers['transfer-encoding']).toBe('chunked');
  expect(complete.bytes.toString()).toBe(fixtureJson);
  const interrupted = await new Promise<boolean>((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, ca, path: prefix + '/chunked-incomplete-end' },
      (response) => {
        response.on('error', () =>
          resolve(response.headers['transfer-encoding'] === 'chunked' && !response.complete),
        );
        response.on('end', () => resolve(false));
        response.resume();
      },
    );
    req.on('error', reject);
    req.end();
  });
  expect(interrupted).toBe(true);
  const rows = (await (await fetch(`http://127.0.0.1:${port + 5}/events`)).json()) as {
    path: string;
    controlFraming?: string;
    fixtureCut?: boolean;
  }[];
  expect(rows.findLast((row) => row.path === prefix + '/chunked-incomplete-end')).toMatchObject({
    controlFraming: 'chunked',
    fixtureCut: true,
  });
});

it('holds the oversized length body after a one-byte prefix and observes the peer close', async () => {
  const path = '/v1/https-qualification/identity-oversize-length';
  const observed = await new Promise<{
    headers: IncomingHttpHeaders;
    prefix: Buffer;
    complete: boolean;
  }>((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, ca, path, agent: false, signal: AbortSignal.timeout(1000) },
      (response) => {
        response.on('error', reject);
        response.once('data', (prefix: Buffer) => {
          resolve({ headers: response.headers, prefix, complete: response.complete });
          response.destroy();
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
  expect(observed.headers['content-length']).toBe('1048577');
  expect(observed.headers['transfer-encoding']).toBeUndefined();
  expect(observed.prefix.toString()).toBe('{');
  expect(observed.complete).toBe(false);
  await vi.waitFor(async () => {
    const rows = (await (await fetch(`http://127.0.0.1:${port + 5}/events`)).json()) as {
      path: string;
    }[];
    expect(rows.filter((row) => row.path === path)).toMatchObject([
      {
        headersSent: true,
        responseStarted: true,
        closed: true,
        finished: false,
        heldLengthEnd: 'peer-close',
        controlFraming: 'length',
        controlOversizeLength: true,
        configuredOversizeLength: true,
      },
    ]);
  });
});

it('observes all six framing and content coding combinations over independent HTTPS', async () => {
  const rows = [
    ['/chunked-coding-absent', 'chunked', 'absent'],
    ['/chunked-complete', 'chunked', 'identity'],
    ['/chunked-coding-gzip', 'chunked', 'gzip'],
    ['/coding-absent', 'length', 'absent'],
    ['/json', 'length', 'identity'],
    ['/coding-gzip', 'length', 'gzip'],
  ] as const;
  for (const [route, framing, coding] of rows) {
    const path = '/v1/https-qualification' + route;
    const { status, headers, bytes } = await get(path, 0, false, 'identity');
    expect(status).toBe(200);
    expect(headers['content-encoding']).toBe(coding === 'absent' ? undefined : coding);
    expect(headers['transfer-encoding']).toBe(framing === 'chunked' ? 'chunked' : undefined);
    expect(headers['content-length']).toBe(framing === 'length' ? String(bytes.length) : undefined);
    expect((coding === 'gzip' ? gunzipSync(bytes) : bytes).toString()).toBe(fixtureJson);
  }
  const events = (await (await fetch(`http://127.0.0.1:${port + 5}/events`)).json()) as {
    path: string;
  }[];
  for (const [route, framing, coding] of rows) {
    expect(
      events.findLast((event) => event.path === '/v1/https-qualification' + route),
    ).toMatchObject({
      controlFraming: framing,
      controlCoding: coding,
      controlBody: 'complete-match',
      configuredFraming: framing,
      responseCoding: coding,
      finished: true,
    });
  }
});

it('serves the standard JSON profile and stops the report at its first discriminating failure', async () => {
  const nominal = await get(standardPrefix + '/coding-absent', 0, false, 'identity');
  expect(nominal.bytes.toString()).toBe(fixtureJson);
  expect(nominal.headers['content-encoding']).toBeUndefined();
  const gzip = await get(standardPrefix + '/coding-gzip', 0, false, 'identity');
  expect(gzip.headers['content-encoding']).toBe('gzip');
  expect(gunzipSync(gzip.bytes)).toEqual(nominal.bytes);
  await expect(get(standardPrefix + '/json', 3, false, 'identity')).rejects.toThrow();
  await expect(get(standardPrefix + '/json', 4, false, 'identity')).rejects.toThrow();
  const snapshot = await (await fetch(`http://127.0.0.1:${port + 5}/runtime`)).json();
  expect(snapshot.connections).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ destination: 'unknown', receivedBytes: true }),
      expect.objectContaining({ destination: 'wrong', receivedBytes: true }),
    ]),
  );
  expect(snapshot.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: standardPrefix + '/coding-absent',
        connectionId: expect.any(Number),
        httpVersion: '1.1',
      }),
    ]),
  );
  const report = verifyStandardJson(
    'ios',
    [
      'READY standard-json-urlsession',
      'START standard-json',
      'PASS standard-json success',
      'START gzip',
      'FAIL gzip',
    ]
      .map((line) => marker + line)
      .join('\n'),
    snapshot,
  );
  expect(report.verdict).toBe('FAIL');
  expect(report.scenarios.slice(0, 3)).toEqual([
    { id: 'standard-json', verdict: 'PASS', observed: 'success' },
    expect.objectContaining({
      id: 'gzip',
      verdict: 'FAIL',
      observed: 'fail',
      reason: 'unexpected-app-outcome',
    }),
    { id: 'gzip-missing-isize', verdict: 'NOT_RUN' },
  ]);
});

it('preserves client failure stages and explains missing server proof without retaining values', () => {
  function run(call: Record<string, unknown>, snapshot: Parameters<typeof verifyStandardJson>[2]) {
    const log = [
      'READY standard-json-okhttp',
      'START standard-json',
      'FAIL standard-json ' + JSON.stringify({ failure: 'assertion', calls: [call] }),
    ]
      .map((line) => marker + line)
      .join('\n');
    return verifyStandardJson('android', log, snapshot).scenarios[0];
  }
  const empty = { events: [], connections: [], overflow: false };
  expect(
    run({ reservation: 'refused', native: 'not-called', adapter: 'network' }, empty),
  ).toMatchObject({
    observed: 'fail',
    verdict: 'NOT_RUN',
    reason: 'no-http-reception',
    client: { calls: [{ reservation: 'refused', native: 'not-called' }] },
    server: { fixtureConnectionsToDestination: 0, receptions: 0 },
  });
  const handshake = { ...empty, connections: [{ destination: 'A', receivedBytes: true }] };
  expect(
    run(
      {
        reservation: 'accepted',
        native: 'rejected',
        nativeKind: 'network',
        nativeReason: 'tls',
      },
      handshake,
    ),
  ).toMatchObject({
    verdict: 'NOT_RUN',
    reason: 'no-http-reception',
    client: { calls: [{ native: 'rejected', nativeKind: 'network', nativeReason: 'tls' }] },
    server: {
      fixtureConnectionsToDestination: 1,
      fixtureConnectionsWithBytes: 1,
      fixtureConnectionsWithTls: 0,
      receptions: 0,
    },
  });
  const event = {
    path: standardPrefix + '/coding-absent',
    destination: 'A',
    method: 'GET',
    connectionId: 1,
    requestedCoding: 'identity',
    responseCoding: 'absent',
    configuredFraming: 'length',
    requestNoStore: true,
    authorization: false,
    authorizationMatchesFixture: false,
    cookie: false,
    contentTypeIsJson: false,
    postBodyMatchesFixture: false,
    headersSent: true,
    responseStatus: 200,
    responseStarted: false,
    responseStartedAtMs: null,
    startedAtMs: 42,
    closed: true,
    closedAfterMs: 1,
    finished: true,
  };
  const call = {
    reservation: 'accepted',
    native: 'success',
    adapter: 'success',
    application: 'response',
    status: 200,
    bytes: 8,
    body: 'fixture-only',
    nativeReason: 'fixture-only',
  };
  const invalidResponse = run(call, { ...handshake, events: [event] });
  expect(invalidResponse).toMatchObject({
    observed: 'fail',
    verdict: 'FAIL',
    reason: 'unexpected-app-outcome',
    client: { calls: [{ native: 'success', application: 'response', status: 200, bytes: 8 }] },
    server: {
      receptions: 1,
      receptionConnections: 1,
      samples: [{ framing: 'length', responseCoding: 'absent', finished: true }],
    },
  });
  expect(JSON.stringify(invalidResponse)).not.toContain('fixture-only');
  for (const [evidence, reason] of [
    [{ headersSent: false }, 'headers-not-observed'],
    [{ configuredFraming: 'unobserved' }, 'unexpected-configured-framing'],
    [{ responseCoding: 'gzip' }, 'unexpected-response-coding'],
  ] as const) {
    expect(run(call, { ...handshake, events: [{ ...event, ...evidence }] })).toMatchObject({
      observed: 'fail',
      verdict: 'NOT_RUN',
      reason,
    });
  }
  expect(run(call, { ...handshake, events: [{ ...event, finished: false }] })).toMatchObject({
    observed: 'fail',
    verdict: 'NOT_RUN',
    reason: 'response-finish-unconfirmed',
    server: { receptions: 1, samples: [{ closed: true, finished: false }] },
  });
});

it('describes native envelopes without retaining response content or native error details', () => {
  const envelope = { ok: true, status: 200, contentType: 'application/json' };
  expect(describeNativeResult({ ...envelope, bytes: new Uint8Array(8) })).toEqual({
    native: 'success',
    status: 200,
    bytes: 8,
  });
  expect(describeNativeResult({ ...envelope, bytes: [] })).toEqual({
    native: 'invalid',
    status: 200,
    bytes: undefined,
  });
  expect(
    describeNativeResult({
      ok: false,
      kind: 'response',
      qualificationReason: 'body',
      qualificationBytes: 8,
      qualificationStatus: 200,
      detail: 'fixture-only',
    }),
  ).toEqual({
    native: 'rejected',
    nativeKind: 'response',
    nativeReason: 'body',
    nativeBytes: 8,
    status: 200,
  });
});

it('distinguishes lost GET responses and complete POST bodies before a deliberate cut', async () => {
  function send(path: string, body?: string) {
    return new Promise<string>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          ca,
          path: standardPrefix + path,
          method: body ? 'POST' : 'GET',
          headers: body
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
                'cache-control': 'no-store',
                'accept-encoding': 'identity',
              }
            : {
                authorization: 'Bearer ' + firstBearer,
                'cache-control': 'no-store',
                'accept-encoding': 'identity',
              },
          signal: AbortSignal.timeout(2000),
          agent: false,
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            text += chunk;
          });
          response.on('end', () => resolve(text));
          response.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }
  await expect(send('/loss-get')).rejects.toThrow();
  await expect(send('/loss-get')).resolves.toBe(fixtureJson);
  for (let attempt = 0; attempt < 3; attempt++)
    await expect(send('/loss-get-always')).rejects.toThrow();
  const body = JSON.stringify(postBody);
  await expect(send('/request-body', body)).resolves.toBe(fixtureJson);
  await expect(send('/loss-post', body)).rejects.toThrow();
  await expect(send('/loss-post-prefix', body)).rejects.toThrow();
  await expect(send('/retry-status-length', body)).resolves.toBe('{}');
  await expect(get(standardPrefix + '/length-conflict')).rejects.toThrow();
  await expect(get(standardPrefix + '/length-and-chunked')).rejects.toThrow();
  await vi.waitFor(async () => {
    const events = (await (await fetch(`http://127.0.0.1:${port + 5}/events`)).json()) as {
      path: string;
    }[];
    const rows = (route: string) => events.filter((event) => event.path === standardPrefix + route);
    expect(rows('/loss-get')).toMatchObject([
      { requestComplete: true, processed: true, fixtureCut: true, headersSent: false },
      { requestComplete: true, finished: true, authorizationMatchesFixture: true },
    ]);
    expect(rows('/loss-post')).toMatchObject([
      {
        requestComplete: true,
        processed: true,
        fixtureCut: true,
        postBodyMatchesFixture: true,
        headersSent: false,
        closed: true,
      },
    ]);
    expect(rows('/loss-post-prefix')).toMatchObject([
      {
        requestComplete: true,
        processed: true,
        fixtureCut: true,
        postBodyMatchesFixture: true,
        responseStarted: true,
        closed: true,
      },
    ]);
    expect(rows('/length-conflict')).toMatchObject([{ fixtureCut: true, closed: true }]);
    expect(rows('/length-and-chunked')).toMatchObject([{ fixtureCut: true, closed: true }]);
  });

  type Snapshot = Parameters<typeof verifyStandardJson>[2];
  const snapshot: Snapshot = await (await fetch(`http://127.0.0.1:${port + 5}/runtime`)).json();
  const status = snapshot.events.find(
    (event) => event.path === standardPrefix + '/retry-status-length',
  )!;
  expect(status).toMatchObject({
    requestComplete: true,
    postBodyMatchesFixture: true,
    finished: true,
    retryAfterZero: true,
  });

  // Use fixture receipts for the scenarios under review and fixed evidence for the prefix.
  const log = [marker + 'READY standard-json-urlsession'];
  const prelude: Snapshot['events'] = [];
  const firstGet = probes.findIndex(({ id }) => id === 'get-loss');
  const cases = probes.slice(0, probes.findIndex(({ id }) => id === 'post-retry-status') + 1);
  for (const [index, { id, path, result }] of cases.entries()) {
    const target = standardPrefix + path;
    const observed =
      id === 'get-loss'
        ? 'success'
        : id === 'get-loss-repeated'
          ? 'timeout'
          : result === 'reject'
            ? 'response'
            : result === 'size' || result === 'status-503'
              ? result
              : 'success';
    log.push(marker + 'START ' + id, marker + `PASS ${id} ${observed}`);
    if (index >= firstGet) continue;
    const coding = id.startsWith('gzip')
      ? 'gzip'
      : id === 'other-coding'
        ? 'other'
        : id === 'stacked-coding'
          ? 'stacked'
          : 'absent';
    prelude.push({
      ...status,
      path: target,
      method: 'GET',
      responseCoding: coding,
      configuredFraming:
        id === 'chunked-valid' || id === 'limit-progressive'
          ? 'chunked'
          : id === 'close-delimited'
            ? 'unobserved'
            : 'length',
      finished: result !== 'size' && (result !== 'reject' || id === 'close-delimited'),
      fixtureCut: true,
      offeredLimitPlusOne: true,
    });
  }
  const actualPaths = new Set(cases.slice(firstGet).map(({ path }) => standardPrefix + path));
  const evidence = [...prelude, ...snapshot.events.filter(({ path }) => actualPaths.has(path))];
  function check(events: Snapshot['events'], id: string) {
    return verifyStandardJson('ios', log.join('\n'), { ...snapshot, events }).scenarios.find(
      (scenario) => scenario.id === id,
    );
  }
  expect(check(evidence, 'get-loss-repeated')).toMatchObject({ verdict: 'PASS', receptions: 3 });
  expect(check(evidence, 'post-retry-status')).toMatchObject({ verdict: 'PASS' });
  expect(check([...evidence, status], 'post-retry-status')).toMatchObject({ verdict: 'FAIL' });
  const cut = evidence.findLast(({ path }) => path === standardPrefix + '/loss-get-always')!;
  const wrongBearer = evidence.map((row) =>
    row === cut ? { ...row, authorizationMatchesFixture: false } : row,
  );
  expect(check(wrongBearer, 'get-loss-repeated')).toMatchObject({ verdict: 'FAIL', receptions: 3 });
  const late = { ...cut, startedAtMs: cut.startedAtMs + requestTimeoutMs };
  expect(check([...evidence, late], 'get-loss-repeated')).toMatchObject({
    verdict: 'FAIL',
    receptions: 4,
  });
});
