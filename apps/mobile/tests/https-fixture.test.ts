import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { get as httpGet } from 'node:http';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bytesMatchFixture, nativeErrorCategory } from '../qualification/fixture-data.js';
import { fixtureJson, startFixture } from '../qualification/server.js';

const directory = join(tmpdir(), `bunny-https-test-${crypto.randomUUID()}`);
const port = 19443;
let fixture: Awaited<ReturnType<typeof startFixture>>;
let ca: Buffer;
const get = (path: string, offset = 0, abort = false) =>
  new Promise<{ status: number; bytes: Buffer; location: string | undefined }>(
    (resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: port + offset, path, ca }, (response) => {
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
          }),
        );
      });
      req.on('error', reject);
      req.end();
    },
  );
beforeAll(async () => {
  execFileSync('bash', ['qualification/certificates.sh', directory], { stdio: 'pipe' });
  ca = readFileSync(join(directory, 'ca.pem'));
  fixture = await startFixture(directory, port);
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
  expect(gunzipSync((await get('/oversize')).bytes).length).toBeGreaterThan(1_048_576);
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

it('compares exact bytes and only exposes allowlisted native error categories', () => {
  const bytes = new TextEncoder().encode(fixtureJson);
  expect(bytesMatchFixture(bytes)).toBe(true);
  bytes[0] = 0;
  expect(bytesMatchFixture(bytes)).toBe(false);
  expect(nativeErrorCategory({ code: 'ERR_REDIRECT', message: 'secret' })).toBe(
    'redirection refusée',
  );
  expect(nativeErrorCategory({ code: 'ERR_SIZE' })).toBe('taille dépassée');
  expect(nativeErrorCategory({ code: 'ERR_NETWORK' })).toBe('erreur réseau');
  expect(nativeErrorCategory({ code: 'secret', message: 'secret' })).toBe('erreur non classée');
});

it('records a flushed body before the client closes the slow connection', async () => {
  const control = async () =>
    (await (await fetch(`http://127.0.0.1:${port + 5}/events`)).json()) as {
      path: string;
      responseStarted: boolean;
      closed: boolean;
      finished: boolean;
    }[];
  const slow = request({ hostname: '127.0.0.1', port, path: '/slow/cancel', ca });
  slow.on('error', () => {});
  slow.on('response', (response) => {
    response.on('error', () => {});
    response.resume();
  });
  slow.end();
  const event = async () => (await control()).find((entry) => entry.path === '/slow/cancel');
  try {
    await expect
      .poll(event)
      .toMatchObject({ responseStarted: true, closed: false, finished: false });
  } finally {
    slow.destroy();
  }
  await expect.poll(event).toMatchObject({ responseStarted: true, closed: true, finished: false });
});

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
  const scoped = events.filter((event) => event.path.startsWith(prefix));
  expect(scoped[0]).toMatchObject({ expoFixtureCookie: false, nativeFixtureCookie: false });
  expect(scoped[3]).toMatchObject({ expoFixtureCookie: true, nativeFixtureCookie: false });
  expect(scoped[4]).toMatchObject({ expoFixtureCookie: true, nativeFixtureCookie: true });
  expect(JSON.stringify(scoped)).not.toContain('example-value');
});

it('serves the large successful gzip response used for memory cycles', async () => {
  const response = await get('/memory/gzip');
  expect(response.status).toBe(200);
  expect(gunzipSync(response.bytes).length).toBe(768 * 1024 + 11);
});
