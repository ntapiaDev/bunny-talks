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
        headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : undefined,
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
  fixture = await startFixture(directory, port, '127.0.0.1', true);
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
