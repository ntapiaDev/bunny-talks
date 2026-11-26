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
  androidPlan,
  firstBearer,
  marker,
  plan,
  postBody,
  prefix as standardPrefix,
  probes,
  requestTimeoutMs,
  retryFramingFaults,
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
  fixture = await startFixture(directory, port);
});
afterAll(async () => {
  await fixture?.close();
  rmSync(directory, { recursive: true, force: true });
});
it('offers complete gzip framing for the missing-trailer probe and exact invalid UTF-8 bytes', async () => {
  const gzip = await get(standardPrefix + '/gzip-truncated');
  expect(gzip.headers['content-encoding']).toBe('gzip');
  expect(gzip.headers['content-length']).toBe(String(gzip.bytes.length));
  expect(gzip.headers['transfer-encoding']).toBeUndefined();
  expect(() => gunzipSync(gzip.bytes)).toThrow();

  const invalidUtf8 = await get(standardPrefix + '/invalid-utf8');
  expect(invalidUtf8.bytes).toEqual(Buffer.from([0x22, 0xc0, 0x22]));
  expect(invalidUtf8.headers['content-length']).toBe('3');
});

it('records redirect sources independently of destinations', async () => {
  expect((await get('/destination', 0)).status).toBe(200);
  expect((await get('/destination', 1)).status).toBe(200);
  await new Promise<void>((resolve, reject) => {
    httpGet(`http://127.0.0.1:${port + 2}/destination`, (res) => {
      expect(res.statusCode).toBe(200);
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });
  const events = async () =>
    (await (await fetch(`http://127.0.0.1:${port + 5}/events`)).json()) as {
      destination: string;
      path: string;
    }[];
  const positive = await events();
  expect(
    positive.filter(({ path }) => path === '/destination').map(({ destination }) => destination),
  ).toEqual(['A', 'B', 'C']);
  const path = standardPrefix + '/redirect/307/host';
  const response = await get(path);
  expect(response.status).toBe(307);
  expect(response.location).toBe(`https://10.0.2.2:${port + 1}/destination`);
  expect((await events()).slice(positive.length)).toMatchObject([{ path, destination: 'A' }]);
});

it('records unknown routes without storing paths, queries or credential values', async () => {
  const marker = 'synthetic-secret-placeholder';
  expect((await get(`${standardPrefix}/${marker}?auth=${marker}`)).status).toBe(404);
  expect((await get(`${standardPrefix}/json?auth=${marker}`)).status).toBe(200);
  const evidence = await (await fetch(`http://127.0.0.1:${port + 5}/events`)).text();
  expect(evidence).toContain('"/unexpected"');
  expect(evidence).not.toContain(marker);
});

it('holds the oversized length body after a one-byte prefix and observes the peer close', async () => {
  const path = standardPrefix + '/identity-oversize-length';
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
        configuredFraming: 'length',
        configuredOversizeLength: true,
      },
    ]);
  });
});

it('observes current framing and coding combinations over independent HTTPS', async () => {
  const rows = [
    ['/chunked-coding-absent', 'chunked', 'absent'],
    ['/chunked-coding-gzip', 'chunked', 'gzip'],
    ['/coding-absent', 'length', 'absent'],
    ['/coding-gzip', 'length', 'gzip'],
    ['/identity-exact', 'length', 'absent'],
    ['/coding-other', 'length', 'br'],
    ['/coding-stacked', 'length', 'gzip, gzip'],
  ] as const;
  for (const [route, framing, coding] of rows) {
    const { status, headers, bytes } = await get(standardPrefix + route, 0, false, 'identity');
    expect(status).toBe(200);
    expect(headers['content-encoding']).toBe(coding === 'absent' ? undefined : coding);
    expect(headers['transfer-encoding']).toBe(framing === 'length' ? undefined : 'chunked');
    expect(headers['content-length']).toBe(framing === 'length' ? String(bytes.length) : undefined);
    const decoded =
      coding === 'gzip'
        ? gunzipSync(bytes)
        : coding === 'br'
          ? brotliDecompressSync(bytes)
          : coding === 'gzip, gzip'
            ? gunzipSync(gunzipSync(bytes))
            : bytes;
    if (route === '/identity-exact') expect(decoded.length).toBe(1_048_576);
    else
      expect(decoded.toString()).toBe(
        route.startsWith('/coding-') && (coding === 'br' || coding === 'gzip, gzip')
          ? '{}'
          : fixtureJson,
      );
  }
});

it('records an active cancellation after the response starts and before it finishes', async () => {
  const path = standardPrefix + '/slow/concurrency-one';
  await expect(get(path, 0, true, 'identity')).rejects.toThrow('fixture abort');
  await vi.waitFor(async () => {
    const { events } = await (await fetch(`http://127.0.0.1:${port + 5}/runtime`)).json();
    expect(events.findLast((event: { path: string }) => event.path === path)).toMatchObject({
      responseStarted: true,
      closed: true,
      finished: false,
      configuredFraming: 'length',
    });
  });
});

it('serves the standard JSON profile and stops the report at its first discriminating failure', async () => {
  const readSnapshot = async () =>
    await (await fetch(`http://127.0.0.1:${port + 5}/runtime`)).json();
  const before = await readSnapshot();
  const nominal = await get(standardPrefix + '/coding-absent', 0, false, 'identity');
  expect(nominal.bytes.toString()).toBe(fixtureJson);
  expect(nominal.headers['content-encoding']).toBeUndefined();
  const gzip = await get(standardPrefix + '/coding-gzip', 0, false, 'identity');
  expect(gzip.headers['content-encoding']).toBe('gzip');
  expect(gunzipSync(gzip.bytes)).toEqual(nominal.bytes);
  await expect(get(standardPrefix + '/json', 3, false, 'identity')).rejects.toThrow();
  await expect(get(standardPrefix + '/json', 4, false, 'identity')).rejects.toThrow();
  await vi.waitFor(async () => {
    const { connections } = await readSnapshot();
    expect(connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ destination: 'unknown', receivedBytes: true }),
        expect.objectContaining({ destination: 'wrong', receivedBytes: true }),
      ]),
    );
  });
  const snapshot = await readSnapshot();
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
      'READY standard-json-known-length-urlsession',
      'START standard-json',
      'PASS standard-json success',
      'START gzip',
      'FAIL gzip',
    ]
      .map((line) => marker + line)
      .join('\n'),
    { ...snapshot, events: snapshot.events.slice(before.events.length) },
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

it('offers complete, length-framed JSON on the slow routes when the client keeps reading', async () => {
  const paths = ['/slow/timeout', '/slow/concurrency-one', '/slow/neighbour'];
  const replies = await Promise.all(
    paths.map((path) => get(standardPrefix + path, 0, false, 'identity')),
  );
  for (const { status, bytes, headers } of replies) {
    expect(status).toBe(200);
    expect(bytes.toString()).toBe(fixtureJson);
    expect(headers['content-length']).toBe(String(bytes.length));
    expect(headers['transfer-encoding']).toBeUndefined();
    expect(headers['content-encoding']).toBeUndefined();
  }
});

it('offers both incomplete chunked frames in the known-length profile', async () => {
  const paths = ['/truncated', '/chunked-incomplete-end'].map((path) => standardPrefix + path);
  for (const path of paths) await expect(get(path, 0, false, 'identity')).rejects.toThrow();
  const { events } = await (await fetch(`http://127.0.0.1:${port + 5}/runtime`)).json();
  for (const path of paths) {
    expect(events).toContainEqual(
      expect.objectContaining({
        path,
        configuredFraming: 'chunked',
        fixtureCut: true,
        closed: true,
        finished: false,
      }),
    );
  }
});

it('preserves client failure stages and explains missing server proof without retaining values', () => {
  function run(call: Record<string, unknown>, snapshot: Parameters<typeof verifyStandardJson>[2]) {
    const log = [
      'READY standard-json-known-length-okhttp',
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
  const before = await (await fetch(`http://127.0.0.1:${port + 5}/runtime`)).json();
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
                host: 'localhost:' + port,
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
                'cache-control': 'no-store',
                'accept-encoding': 'identity',
              }
            : {
                host: 'localhost:' + port,
                ...(path.startsWith('/loss-get') ? { authorization: 'Bearer ' + firstBearer } : {}),
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
  for (let attempt = 0; attempt < 3; attempt++)
    await expect(send('/length-conflict')).rejects.toThrow();
  await expect(send('/length-and-chunked')).rejects.toThrow();
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
    expect(rows('/length-conflict')).toHaveLength(3);
    for (const row of rows('/length-conflict'))
      expect(row).toMatchObject({
        framingFault: 'conflicting-lengths',
        fixtureCut: true,
        closed: true,
        iosPrimaryTarget: true,
        requestComplete: true,
      });
    expect(rows('/length-and-chunked')).toMatchObject([
      {
        framingFault: 'length-and-transfer',
        fixtureCut: true,
        closed: true,
        iosPrimaryTarget: true,
        requestComplete: true,
      },
    ]);
  });

  type Snapshot = Parameters<typeof verifyStandardJson>[2];
  const snapshot: Snapshot = await (await fetch(`http://127.0.0.1:${port + 5}/runtime`)).json();
  const receipts = snapshot.events.slice(before.events.length);
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
  const log = [marker + 'READY standard-json-known-length-urlsession'];
  const evidence: Snapshot['events'] = [];
  const observedCalls = new Map<
    string,
    { retryWindow: { openedAtMs: number; settledAtMs: number } }
  >();
  // Reproduce the fifth run's receipts, callbacks and client terminal times; offers are simulated.
  const timingCases = new Map([
    ['chunked-valid-rejected', { settled: 27, receipts: [25], offers: [25], confirmations: [30] }],
    [
      'conflicting-lengths',
      {
        settled: 114,
        receipts: [33, 60, 111],
        offers: [33, 60, 111],
        confirmations: [46, 93, 128],
      },
    ],
    ['length-and-transfer', { settled: 43, receipts: [40], offers: [40], confirmations: [53] }],
    ['get-loss', { settled: 91, receipts: [33, 88], offers: [34], confirmations: [] }],
  ]);
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
    const startedAtMs = (index + 1) * 10_000;
    const timing = timingCases.get(id);
    const coding = id.startsWith('gzip')
      ? 'gzip'
      : id === 'other-coding'
        ? 'other'
        : id === 'stacked-coding'
          ? 'stacked'
          : 'absent';
    const framingFault = retryFramingFaults.get(path);
    const matching =
      index >= probes.findIndex(({ id }) => id === 'conflicting-lengths')
        ? receipts.filter((event) => event.path === target)
        : [];
    const entries = matching.length
      ? matching
      : [
          {
            ...status,
            path: target,
            method: 'GET',
            iosPrimaryTarget: true,
            responseCoding: coding,
            configuredFraming:
              id === 'chunked-valid-rejected'
                ? 'chunked'
                : id === 'close-delimited'
                  ? 'unobserved'
                  : 'length',
            finished:
              result !== 'size' &&
              (result !== 'reject' || id === 'close-delimited' || id === 'chunked-valid-rejected'),
            fixtureCut: true,
            ...(framingFault
              ? {
                  framingFault,
                  framingFaultOfferedAtMs: startedAtMs,
                  framingFaultConfirmedAtMs: startedAtMs,
                }
              : {}),
            configuredOversizeLength: id === 'limit-declared',
            heldLengthEnd: 'peer-close',
            closedAfterMs: 10,
          },
        ];
    // Separate operation windows deterministically while keeping the fixture's actual fault evidence.
    evidence.push(
      ...entries.map((entry, reception) => ({
        ...entry,
        startedAtMs: startedAtMs + (timing?.receipts[reception] ?? reception * 100),
        ...(entry.framingFaultOfferedAtMs === undefined
          ? {}
          : {
              framingFaultOfferedAtMs:
                startedAtMs + (timing?.offers[reception] ?? reception * 100 + 1),
            }),
        ...(entry.framingFaultConfirmedAtMs === undefined
          ? {}
          : {
              framingFaultConfirmedAtMs:
                startedAtMs + (timing?.confirmations[reception] ?? reception * 100 + 2),
            }),
        ...(entry.fixtureCutAtMs === undefined
          ? {}
          : { fixtureCutAtMs: startedAtMs + (timing?.offers[reception] ?? reception * 100 + 1) }),
      })),
    );
    const diagnostic = {
      retryWindow: {
        openedAtMs: timing ? startedAtMs : startedAtMs - 10,
        settledAtMs: startedAtMs + (timing?.settled ?? entries.length * 100 + 10),
      },
      calls: [
        observed === 'success'
          ? {
              reservation: 'accepted',
              native: 'success',
              adapter: 'success',
              status: 200,
              bytes: 59,
            }
          : {
              reservation: 'accepted',
              native: 'rejected',
              nativeKind: observed,
              application: observed,
            },
      ],
    };
    observedCalls.set(id, diagnostic);
    log.push(
      marker + 'START ' + id,
      marker + `PASS ${id} ${observed} ${JSON.stringify(diagnostic)}`,
    );
  }
  expect(check(evidence, 'chunked-valid-rejected')).toMatchObject({
    verdict: 'PASS',
    server: {
      retryWindowMs: 27,
      samples: [
        {
          receivedAfterStartMs: 25,
          faultOfferedAfterReceiptMs: 0,
          faultConfirmedAfterReceiptMs: 5,
        },
      ],
    },
  });
  const chunked = evidence.find((row) => row.path === standardPrefix + '/chunked-coding-absent')!;
  const unconfirmed = { ...chunked };
  delete unconfirmed.framingFaultConfirmedAtMs;
  expect(
    check(
      evidence.map((row) => (row === chunked ? unconfirmed : row)),
      'chunked-valid-rejected',
    ),
  ).toMatchObject({ verdict: 'NOT_RUN', reason: 'framing-fault-unconfirmed' });
  function check(events: Snapshot['events'], id: string, markers = log) {
    return verifyStandardJson('ios', markers.join('\n'), { ...snapshot, events }).scenarios.find(
      (scenario) => scenario.id === id,
    );
  }
  expect(check(evidence, 'conflicting-lengths')).toMatchObject({
    verdict: 'PASS',
    server: { receptions: 3 },
  });
  expect(check(evidence, 'length-and-transfer')).toMatchObject({ verdict: 'PASS' });
  const recovery = check(evidence, 'get-loss');
  expect(recovery, JSON.stringify(recovery)).toMatchObject({ verdict: 'PASS', receptions: 2 });
  expect(check(evidence, 'get-loss-repeated')).toMatchObject({ verdict: 'PASS', receptions: 3 });
  expect(check(evidence, 'post-retry-status')).toMatchObject({ verdict: 'PASS' });
  expect(check([...evidence, status], 'post-retry-status')).toMatchObject({ verdict: 'FAIL' });
  expect(check([...evidence, { ...status, destination: 'B' }], 'post-retry-status')).toMatchObject({
    verdict: 'FAIL',
  });
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
  const conflict = evidence.find((event) => event.path === standardPrefix + '/length-conflict')!;
  const divergent = [...evidence, { ...conflict, destination: 'B' }];
  expect(check(divergent, 'conflicting-lengths')).toMatchObject({ verdict: 'FAIL' });
  expect(check(divergent, 'post-retry-status')).toMatchObject({
    verdict: 'NOT_RUN',
    observed: 'status-503',
    reason: 'previous-scenario-unqualified',
    diagnostic: { verdict: 'PASS' },
    server: { receptions: 1, samples: [{ postBodyMatchesFixture: true, retryAfterZero: true }] },
  });
  expect(check([...divergent, status], 'post-retry-status')).toMatchObject({
    verdict: 'NOT_RUN',
    diagnostic: { verdict: 'FAIL', reason: 'wire-criteria-failed' },
  });
  const conflictRows = (change: Partial<Snapshot['events'][number]>) =>
    evidence.map((row) => (row === conflict ? { ...row, ...change } : row));
  // The second receipt is at 60 ms. Only the first offer must precede it.
  expect(
    check(
      conflictRows({ framingFaultConfirmedAtMs: conflict.startedAtMs + 28 }),
      'conflicting-lengths',
    ),
  ).toMatchObject({ verdict: 'PASS' });
  expect(
    check(conflictRows({ framingFault: 'length-and-transfer' }), 'conflicting-lengths'),
  ).toMatchObject({ verdict: 'NOT_RUN', reason: 'framing-fault-unconfirmed' });
  expect(check(conflictRows({ iosPrimaryTarget: false }), 'conflicting-lengths')).toMatchObject({
    verdict: 'FAIL',
  });
  expect(check(conflictRows({ authorization: true }), 'conflicting-lengths')).toMatchObject({
    verdict: 'FAIL',
  });
  const terminal = observedCalls.get('conflicting-lengths')!;
  const justAfterTerminal = terminal.retryWindow.settledAtMs + 1;
  expect(
    check(
      [
        ...evidence,
        {
          ...conflict,
          startedAtMs: justAfterTerminal,
          framingFaultOfferedAtMs: justAfterTerminal + 1,
        },
      ],
      'conflicting-lengths',
    ),
  ).toMatchObject({ verdict: 'FAIL' });
  const secondConflict = evidence.find((row) => row.path === conflict.path && row !== conflict)!;
  expect(
    check(
      evidence.map((row) =>
        row === secondConflict
          ? {
              ...row,
              startedAtMs: conflict.startedAtMs - 1,
              framingFaultOfferedAtMs: conflict.startedAtMs,
            }
          : row,
      ),
      'conflicting-lengths',
    ),
  ).toMatchObject({ verdict: 'FAIL' });
  expect(
    check(
      [
        ...evidence,
        {
          ...conflict,
          path: '/unexpected',
          startedAtMs: conflict.startedAtMs + 10,
        },
      ],
      'conflicting-lengths',
    ),
  ).toMatchObject({ verdict: 'FAIL' });
  const nativeSuccess = {
    ...terminal,
    calls: [{ reservation: 'accepted', native: 'success', status: 200, bytes: 2 }],
  };
  const accepted = log.map((line) =>
    line.startsWith(marker + 'PASS conflicting-lengths ')
      ? marker + 'FAIL conflicting-lengths ' + JSON.stringify(nativeSuccess)
      : line,
  );
  expect(check(evidence, 'conflicting-lengths', accepted)).toMatchObject({ verdict: 'FAIL' });
  const exposedBytes = log.map((line) =>
    line.startsWith(marker + 'PASS conflicting-lengths ')
      ? marker +
        'PASS conflicting-lengths response ' +
        JSON.stringify({
          ...terminal,
          calls: [
            {
              reservation: 'accepted',
              native: 'rejected',
              nativeKind: 'response',
              application: 'response',
              bytes: 2,
            },
          ],
        })
      : line,
  );
  expect(check(evidence, 'conflicting-lengths', exposedBytes)).toMatchObject({ verdict: 'FAIL' });
  const pending = log.map((line) =>
    line.startsWith(marker + 'PASS conflicting-lengths ')
      ? marker +
        'PASS conflicting-lengths response ' +
        JSON.stringify({
          ...terminal,
          calls: [{ reservation: 'accepted', native: 'pending' }],
        })
      : line,
  );
  expect(check(evidence, 'conflicting-lengths', pending)).toMatchObject({
    verdict: 'NOT_RUN',
    reason: 'terminal-native-result-unconfirmed',
  });
  const androidLog = log.map((line) =>
    line.replace('known-length-urlsession', 'known-length-okhttp'),
  );
  const singleConflict = evidence.filter((row) => row.path !== conflict.path || row === conflict);
  const checkAndroid = (events: Snapshot['events']) =>
    verifyStandardJson('android', androidLog.join('\n'), { ...snapshot, events }).scenarios.find(
      ({ id }) => id === 'conflicting-lengths',
    );
  expect(checkAndroid(singleConflict)).toMatchObject({ verdict: 'PASS' });
  expect(checkAndroid(evidence)).toMatchObject({ verdict: 'FAIL' });
});

it('reports diagnostic evidence by TLS destination and preserves isolation checks after an official stop', () => {
  type Snapshot = Parameters<typeof verifyStandardJson>[2];
  const json: Snapshot['events'][number] = {
    path: standardPrefix + '/json',
    destination: 'B',
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
    startedAtMs: 5_000,
    closed: true,
    closedAfterMs: 1,
    finished: true,
  };
  const identity = {
    ...json,
    path: standardPrefix + '/identity',
    destination: 'A',
    connectionId: 4,
  };
  const snapshot: Snapshot = {
    overflow: false,
    events: [
      json,
      { ...identity, authorization: true, authorizationMatchesFixture: true },
      { ...identity, authorization: true, authorizationMatchesSecond: true },
      identity,
    ],
    connections: [
      { id: 1, destination: 'B', receivedBytes: true, tls: 'TLSv1.3' },
      { id: 2, destination: 'unknown', receivedBytes: true, tls: null },
      { id: 3, destination: 'wrong', receivedBytes: true, tls: null },
      { id: 4, destination: 'A', receivedBytes: true, tls: 'TLSv1.3' },
    ],
  };
  const log = [
    'READY standard-json-known-length-urlsession',
    ...plan.flatMap((id) => [
      `START ${id}`,
      `PASS ${id} ${id === 'tls-untrusted' || id === 'tls-wrong-name' ? 'network' : 'success'}`,
    ]),
    'DONE',
  ]
    .map((line) => marker + line)
    .join('\n');
  const report = verifyStandardJson('ios', log, snapshot);
  expect(report).toMatchObject({ verdict: 'NOT_RUN', appCompleted: true });
  const scenario = (id: string) => report.scenarios.find((result) => result.id === id);
  for (const [id, destination, receptions] of [
    ['tls-other-origin', 'B', 1],
    ['tls-untrusted', 'unknown', 0],
    ['tls-wrong-name', 'wrong', 0],
  ]) {
    expect(scenario(String(id))).toMatchObject({
      verdict: 'NOT_RUN',
      diagnostic: { verdict: 'PASS' },
      server: {
        destination,
        receptions,
        receptionConnections: receptions,
        fixtureConnectionsWithBytes: 1,
        fixtureConnectionsWithTls: receptions,
      },
    });
  }
  expect(scenario('identity-isolation')).toMatchObject({
    verdict: 'NOT_RUN',
    diagnostic: { verdict: 'PASS' },
    server: {
      receptions: 3,
      receptionConnections: 1,
      samples: Array.from({ length: 3 }, () => ({
        expectedBearer: true,
        cookiePresent: false,
        connectionIdentified: true,
      })),
    },
  });
  const unexpected = verifyStandardJson('ios', log, {
    ...snapshot,
    events: [...snapshot.events, { ...json, destination: 'unknown', connectionId: 2 }],
  });
  expect(unexpected.scenarios.find(({ id }) => id === 'tls-untrusted')).toMatchObject({
    verdict: 'NOT_RUN',
    diagnostic: { verdict: 'FAIL' },
    server: { destination: 'unknown', receptions: 1 },
  });
});

it('correlates revocation after a lost DELETE and cancellation during an observed GET retry', async () => {
  function send(path: string, method = 'GET', stopAfterPrefix = false) {
    return new Promise<number>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          ca,
          path: standardPrefix + path,
          method,
          agent: false,
          signal: AbortSignal.timeout(2000),
          headers: {
            host: 'localhost:' + port,
            ...(path.startsWith('/recover-') ? {} : { authorization: 'Bearer ' + firstBearer }),
            'cache-control': 'no-store',
            'accept-encoding': 'identity',
          },
        },
        (response) => {
          response.on('data', () => {
            if (stopAfterPrefix) setTimeout(() => req.destroy(new Error('fixture abort')), 20);
          });
          response.on('error', reject);
          response.on('end', () => resolve(response.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  await expect(send('/session-delete', 'DELETE')).resolves.toBe(204);
  await expect(send('/session-delete-loss', 'DELETE')).rejects.toThrow();
  await expect(send('/session-delete-loss')).resolves.toBe(401);
  await expect(send('/recover-bad-length')).rejects.toThrow();
  await expect(send('/recover-json')).resolves.toBe(200);
  const openedAtMs = Date.now();
  await expect(send('/loss-get-cancel')).rejects.toThrow();
  await expect(send('/loss-get-cancel', 'GET', true)).rejects.toThrow('fixture abort');
  const settledAtMs = Date.now();
  const log = [
    'READY standard-json-known-length-urlsession',
    ...plan.flatMap((id) => [
      `START ${id}`,
      `PASS ${id} success${
        id === 'cancel-retried-get'
          ? ' ' +
            JSON.stringify({
              calls: [
                {
                  reservation: 'accepted',
                  native: 'rejected',
                  nativeKind: 'network',
                  application: 'cancelled',
                },
              ],
              retryWindow: { openedAtMs, settledAtMs },
            })
          : ''
      }`,
    ]),
    'DONE',
  ]
    .map((line) => marker + line)
    .join('\n');
  type Snapshot = Parameters<typeof verifyStandardJson>[2];
  const assessment = (id: string, snapshot: Snapshot) => {
    const scenario = verifyStandardJson('ios', log, snapshot).scenarios.find(
      (row) => row.id === id,
    );
    return scenario && 'diagnostic' in scenario ? scenario.diagnostic : undefined;
  };

  await vi.waitFor(async () => {
    const snapshot = (await (
      await fetch(`http://127.0.0.1:${port + 5}/runtime`)
    ).json()) as Snapshot;
    for (const id of ['session-delete', 'framing-recovery', 'cancel-retried-get'])
      expect(assessment(id, snapshot)?.verdict, id).toBe('PASS');

    const mutation = snapshot.events.find(
      ({ path, method }) => path === standardPrefix + '/session-delete-loss' && method === 'DELETE',
    )!;
    expect(
      assessment('session-delete', {
        ...snapshot,
        events: [...snapshot.events, mutation],
      })?.verdict,
    ).toBe('FAIL');

    expect(
      assessment('cancel-retried-get', {
        ...snapshot,
        events: snapshot.events.filter(
          ({ path, responseStarted }) =>
            path !== standardPrefix + '/loss-get-cancel' || !responseStarted,
        ),
      }),
    ).toEqual({ verdict: 'NOT_RUN', reason: 'retry-not-observed-before-cancel' });
  });
});

it('retains later scenario diagnostics after an application failure', () => {
  const log = [
    'READY standard-json-known-length-okhttp',
    'START standard-json',
    'FAIL standard-json ' + JSON.stringify({ failure: 'assertion', calls: [] }),
    'START gzip',
    'PASS gzip response ' +
      JSON.stringify({
        calls: [{ reservation: 'accepted', native: 'rejected', nativeKind: 'response' }],
      }),
  ]
    .map((line) => marker + line)
    .join('\n');
  const report = verifyStandardJson('android', log, {
    events: [],
    connections: [],
    overflow: false,
  });
  expect(report.scenarios[0]).toMatchObject({ observed: 'fail', verdict: 'NOT_RUN' });
  expect(report.scenarios[1]).toMatchObject({
    observed: 'response',
    verdict: 'NOT_RUN',
    diagnostic: { verdict: 'NOT_RUN', reason: 'no-http-reception' },
    client: { calls: [{ reservation: 'accepted', native: 'rejected', nativeKind: 'response' }] },
  });
});

it('requires overlapping responses, prompt cancellation and no third emission', () => {
  type Snapshot = Parameters<typeof verifyStandardJson>[2];
  const first: Snapshot['events'][number] = {
    path: standardPrefix + '/slow/concurrency-one',
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
    responseStarted: true,
    responseStartedAtMs: 5_001,
    startedAtMs: 5_000,
    closed: true,
    closedAfterMs: 1_025,
    finished: false,
  };
  const neighbour = {
    ...first,
    path: standardPrefix + '/slow/neighbour',
    connectionId: 2,
    startedAtMs: 5_520,
    responseStartedAtMs: 5_521,
    finished: true,
    finishedAtMs: 7_320,
    closedAfterMs: 1_801,
  };
  const connections = [
    { id: 1, acceptedAtMs: 4_780, tlsEstablishedAtMs: 4_980 },
    { id: 2, acceptedAtMs: 5_005, tlsEstablishedAtMs: 5_518 },
  ].map((row) => ({ ...row, destination: 'A', receivedBytes: true, tls: 'TLSv1.3' }));
  function assess(events: Snapshot['events'], requested = 1_000, rejected = 1_030) {
    const evidence = JSON.stringify({
      cancellationRequestedAfterStartMs: requested,
      calls: [
        {
          reservation: 'accepted',
          native: 'rejected',
          nativeKind: 'network',
          application: 'cancelled',
          nativeSettledAfterStartMs: rejected,
        },
        {
          reservation: 'accepted',
          native: 'success',
          adapter: 'success',
          status: 200,
          bytes: 59,
          nativeSettledAfterStartMs: 2_360,
        },
        { reservation: 'refused', native: 'not-called' },
      ],
    });
    const previousScenarios = androidPlan.slice(0, androidPlan.indexOf('cancel-neighbour'));
    const log = [
      'READY standard-json-known-length-okhttp',
      ...previousScenarios.flatMap((id) => [`START ${id}`, `PASS ${id} success`]),
      'START cancel-neighbour',
      `PASS cancel-neighbour success ${evidence}`,
    ]
      .map((line) => marker + line)
      .join('\n');
    return verifyStandardJson('android', log, {
      events,
      connections,
      overflow: false,
    }).scenarios.find(({ id }) => id === 'cancel-neighbour');
  }

  expect(assess([first, neighbour])).toMatchObject({
    diagnostic: { verdict: 'PASS' },
    client: { cancellationToNativeResultMs: 30 },
    server: {
      neighbourOverlapped: true,
      samples: [
        { closedAfterMs: 1_025 },
        { tlsAfterTcpMs: 513, httpAfterTlsMs: 2, finishedAfterReceiptMs: 1_800 },
      ],
    },
  });
  const invalidCases = [
    ['neighbour starts after closure', [first, { ...neighbour, responseStartedAtMs: 6_026 }]],
    ['neighbour starts at closure', [first, { ...neighbour, responseStartedAtMs: 6_025 }]],
    ['neighbour finishes before closure', [first, { ...neighbour, finishedAtMs: 6_024 }]],
    ['no closure', [{ ...first, closed: false, closedAfterMs: null }, neighbour]],
    ['late closure', [{ ...first, closedAfterMs: 1_701 }, neighbour]],
    ['premature closure', [{ ...first, closedAfterMs: 199 }, neighbour]],
    ['first body finishes naturally', [{ ...first, finished: true }, neighbour]],
    ['first body never begins', [{ ...first, responseStarted: false }, neighbour]],
    [
      'third emission',
      [first, neighbour, { ...first, path: standardPrefix + '/third-reservation' }],
    ],
  ] as const;
  for (const [label, events] of invalidCases) {
    expect(assess([...events]), label).toMatchObject({ diagnostic: { verdict: 'FAIL' } });
  }
  expect(assess([first, neighbour], 450, 490)).toMatchObject({ diagnostic: { verdict: 'FAIL' } });
  expect(assess([first, neighbour], 1_000, 999)).toMatchObject({ diagnostic: { verdict: 'FAIL' } });
  expect(assess([first, neighbour], 1_000, 1_701)).toMatchObject({
    diagnostic: { verdict: 'FAIL' },
  });
});
