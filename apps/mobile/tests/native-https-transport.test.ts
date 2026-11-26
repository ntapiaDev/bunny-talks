import { requireNativeModule } from 'expo';
import { describe, expect, it, vi } from 'vitest';
import { qualify } from '../qualification/standard-json-entry';
import {
  fixtureByteValues,
  fixturePost,
  fixtureText,
  invalidUtf8ByteValues,
  limit,
  prefix,
} from '../qualification/standard-json-scenarios';
import type { HttpTransport } from '../src/infrastructure/http/application-http';
import * as applicationHttp from '../src/infrastructure/http/application-http';
import { createApplicationHttpClient } from '../src/infrastructure/http/application-http';
import { createNativeHttpsTransport } from '../src/infrastructure/http/native-https-transport';

vi.mock('expo', () => ({ registerRootComponent: vi.fn(), requireNativeModule: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, Text: vi.fn() }));

const request = {
  url: 'https://fixture.invalid/v1/json',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-only' },
  body: '{"fixture":true}',
  maxResponseBytes: 50,
  timeoutMs: 5000,
  redirect: 'error',
  credentials: 'omit',
  retry: 'never',
} satisfies Omit<Parameters<HttpTransport>[0], 'signal'>;

function setup() {
  let complete!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => {
    complete = resolve;
  });
  const native = {
    reserve: vi.fn<(timeoutMs: number) => string | null>(() => 'fixture-id'),
    execute: vi.fn(() => pending),
    cancel: vi.fn(),
  };
  const loadNative = vi.fn(() => native);
  const controller = new AbortController();
  const transport = createNativeHttpsTransport(loadNative);
  return {
    controller,
    native,
    loadNative,
    complete,
    transport,
    send: () => transport({ ...request, signal: controller.signal }),
  };
}

describe('native HTTPS transport adapter', () => {
  it.each([new Uint8Array([42]), new Uint8Array([42]).buffer])(
    'passes request policy and returns the complete byte array without a copy',
    async (bytes) => {
      const { native, complete, send } = setup();
      const result = send();
      expect(native.reserve).toHaveBeenCalledWith(expect.any(Number));
      expect(native.execute).toHaveBeenCalledWith(
        'fixture-id',
        request.url,
        request.method,
        request.headers,
        request.body,
        50,
      );
      complete({ ok: true, status: 200, contentType: 'application/json', bytes });
      const response = await result;
      expect(response).toMatchObject({ ok: true, status: 200, body: new Uint8Array([42]) });
      if (response.ok)
        expect(response.body.buffer).toBe(bytes instanceof Uint8Array ? bytes.buffer : bytes);
    },
  );

  it('does not load or reserve the native module for an already aborted signal', async () => {
    const { controller, loadNative, send } = setup();
    controller.abort();
    await expect(send()).resolves.toEqual({ ok: false, kind: 'network' });
    expect(loadNative).not.toHaveBeenCalled();
  });

  it('cancels a reservation if a signal aborts during synchronous native start', async () => {
    const { controller, native, send } = setup();
    native.reserve.mockImplementationOnce(() => {
      controller.abort();
      return 'fixture-id';
    });
    await expect(send()).resolves.toEqual({ ok: false, kind: 'network' });
    expect(native.cancel).toHaveBeenCalledExactlyOnceWith('fixture-id');
    expect(native.execute).not.toHaveBeenCalled();
  });

  it('cancels native work and discards a response when abort wins delivery', async () => {
    const { controller, native, complete, send } = setup();
    const result = send();
    complete({ ok: true, status: 204, contentType: null, bytes: new ArrayBuffer(0) });
    controller.abort();
    await expect(result).resolves.toEqual({ ok: false, kind: 'network' });
    expect(native.cancel).toHaveBeenCalledExactlyOnceWith('fixture-id');
  });

  it('cancels when the bridge has not delivered by the deadline', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    try {
      const { native, send } = setup();
      const result = send();
      await vi.advanceTimersByTimeAsync(request.timeoutMs);
      await expect(result).resolves.toEqual({ ok: false, kind: 'timeout' });
      expect(native.cancel).toHaveBeenCalledExactlyOnceWith('fixture-id');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses busy calls before allocating a native execution', async () => {
    const { native, send } = setup();
    native.reserve.mockReturnValueOnce(null);
    await expect(send()).resolves.toEqual({ ok: false, kind: 'network' });
    expect(native.execute).not.toHaveBeenCalled();
    expect(native.cancel).not.toHaveBeenCalled();
  });

  it.each(['network', 'timeout', 'redirect', 'response', 'size'])(
    'returns only the public category %s',
    async (kind) => {
      const { complete, send } = setup();
      const result = send();
      complete({ ok: false, kind, details: 'native fixture information' });
      await expect(result).resolves.toEqual({ ok: false, kind });
    },
  );

  it.each([
    null,
    { ok: true, status: 200, contentType: null, bytes: [42] },
    { ok: true, status: 200, contentType: null, bytes: new DataView(new ArrayBuffer(1)) },
    { ok: true, status: 200, contentType: 42, bytes: new Uint8Array([42]) },
    { ok: true, status: 200, contentType: null },
    { ok: false, kind: 'response', bytes: new Uint8Array([42]) },
  ])('returns only the public response failure for a malformed result', async (nativeResult) => {
    const { complete, send } = setup();
    const result = send();
    complete(nativeResult);
    await expect(result).resolves.toEqual({ ok: false, kind: 'response' });
  });
});

describe('standard fixture through the application client', () => {
  it('dispatches all 42 requests from the qualification runner on their expected routes', async () => {
    const scope = '/v1/https-qualification/standard-json';
    const delivered: string[] = [];
    const expected = [
      'GET /coding-absent',
      'GET /coding-gzip',
      'GET /gzip-truncated',
      'GET /chunked-coding-gzip',
      'GET /coding-other',
      'GET /coding-stacked',
      'GET /length',
      'GET /chunked-coding-absent',
      'GET /truncated',
      'GET /chunked-incomplete-end',
      'GET /unframed',
      'GET /length-conflict',
      'GET /length-and-chunked',
      'GET /identity-exact',
      'GET /identity-oversize-length',
      'GET /loss-get',
      'GET /loss-get-always',
      'POST /request-body',
      'POST /loss-post',
      'POST /loss-post-prefix',
      'POST /retry-status-length',
      'GET /json',
      'GET /json',
      'GET /json',
      'GET /redirect/307/host',
      'GET /challenge',
      'GET /no-content',
      'GET /slow/timeout',
      'GET /reuse/one',
      'GET /reuse/two',
      'GET /identity',
      'GET /identity',
      'GET /identity',
      'GET /slow/concurrency-one',
      'GET /slow/neighbour',
      'GET /third-reservation',
      'DELETE /session-delete',
      'DELETE /session-delete-loss',
      'GET /session-delete-loss',
      'GET /recover-bad-length',
      'GET /recover-json',
      'GET /loss-get-cancel',
    ];
    const failures = new Map([
      ['/coding-gzip', 'response'],
      ['/gzip-truncated', 'response'],
      ['/chunked-coding-gzip', 'response'],
      ['/coding-other', 'response'],
      ['/coding-stacked', 'response'],
      ['/length', 'response'],
      ['/chunked-coding-absent', 'response'],
      ['/truncated', 'response'],
      ['/chunked-incomplete-end', 'response'],
      ['/unframed', 'response'],
      ['/length-conflict', 'response'],
      ['/length-and-chunked', 'response'],
      ['/identity-oversize-length', 'size'],
      ['/loss-get-always', 'network'],
      ['/loss-post', 'network'],
      ['/loss-post-prefix', 'network'],
      ['/redirect/307/host', 'redirect'],
      ['/slow/timeout', 'timeout'],
      ['/recover-bad-length', 'response'],
    ]);
    const success = (status = 200, body = fixtureText) => ({
      ok: true,
      status,
      contentType: status === 204 ? null : 'application/json',
      bytes: new TextEncoder().encode(body),
    });
    const pending = new Map<string, (value: unknown) => void>();
    let nextId = 0;
    vi.mocked(requireNativeModule).mockReturnValue({
      qualificationProfile: () => 'standard-json-known-length-urlsession',
      reserve: () => (delivered.at(-1)?.endsWith('/third-reservation') ? null : String(++nextId)),
      cancel: (id: string) => pending.get(id)?.({ ok: false, kind: 'network' }),
      async execute(id: string, url: string, method: string, headers: Record<string, string>) {
        const target = new URL(url);
        const path = target.pathname.slice(scope.length);
        const failure = failures.get(path);
        if (failure) return { ok: false, kind: failure };
        if (['29446', '29447'].includes(target.port)) return { ok: false, kind: 'network' };
        if (path === '/identity-exact')
          return success(200, JSON.stringify({ data: 'x'.repeat(limit - 11) }));
        if (path === '/retry-status-length') return success(503, '{}');
        if (path === '/challenge') return success(401, '{}');
        if (path === '/no-content' || path === '/session-delete') return success(204, '');
        if (path === '/session-delete-loss')
          return method === 'DELETE' ? { ok: false, kind: 'network' } : success(401, '{}');
        if (path === '/identity') {
          const identity = { 'Bearer fixture-only': 'first', 'Bearer fixture-second': 'second' };
          return success(
            200,
            JSON.stringify({
              identity: identity[headers.Authorization as keyof typeof identity] ?? 'anonymous',
            }),
          );
        }
        if (path === '/slow/concurrency-one' || path === '/loss-get-cancel')
          return new Promise((resolve) => pending.set(id, resolve));
        return success();
      },
    });
    const createClient = applicationHttp.createApplicationHttpClient;
    const factory = vi
      .spyOn(applicationHttp, 'createApplicationHttpClient')
      .mockImplementation((options) =>
        createClient({
          ...options,
          transport(request) {
            delivered.push(request.method + ' ' + new URL(request.url).pathname);
            return options.transport(request);
          },
        }),
      );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('HermesInternal', {});
    vi.useFakeTimers();
    try {
      const running = qualify();
      await vi.runAllTimersAsync();
      await running;
      expect(delivered).toEqual(expected.map((entry) => entry.replace(' /', ' ' + scope + '/')));
      expect(log.mock.calls.filter(([line]) => line.includes(' PASS '))).toHaveLength(34);
      expect(log).toHaveBeenLastCalledWith('[BunnyHttpsStandardJson] DONE');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      log.mockRestore();
      factory.mockRestore();
      vi.mocked(requireNativeModule).mockReset();
    }
  });

  it('sends the nominal POST with its exact multibyte JSON and explicit authorization', async () => {
    const { native, complete, transport } = setup();
    const client = createApplicationHttpClient({
      origin: 'https://fixture.invalid',
      timeoutMs: 6000,
      maxResponseBytes: 1024,
      transport,
    });
    const path = prefix + '/request-body';
    const result = client.request({
      method: 'POST',
      path,
      expectedStatuses: [200],
      bearerToken: 'fixture-only',
      body: JSON.parse(fixturePost) as unknown,
    });
    complete({
      ok: true,
      status: 200,
      contentType: 'application/json',
      bytes: Uint8Array.from(fixtureByteValues),
    });
    await expect(result).resolves.toEqual(JSON.parse(fixtureText));
    expect(native.execute).toHaveBeenCalledExactlyOnceWith(
      'fixture-id',
      'https://fixture.invalid' + path,
      'POST',
      {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer fixture-only',
      },
      fixturePost,
      1024,
    );
  });

  it('passes intact invalid UTF-8 through the adapter and refuses it in the client decoder', async () => {
    const { complete, transport } = setup();
    const bytes = Uint8Array.from(invalidUtf8ByteValues);
    let delivered: Awaited<ReturnType<HttpTransport>> | undefined;
    const client = createApplicationHttpClient({
      origin: 'https://fixture.invalid',
      timeoutMs: 6000,
      maxResponseBytes: 1024,
      transport: async (request) => (delivered = await transport(request)),
    });
    const result = client.request({
      method: 'GET',
      path: prefix + '/invalid-utf8',
      expectedStatuses: [200],
    });
    complete({ ok: true, status: 200, contentType: 'application/json', bytes });
    await expect(result).rejects.toMatchObject({ kind: 'response' });
    expect(delivered).toEqual({
      ok: true,
      status: 200,
      contentType: 'application/json',
      body: bytes,
    });
  });
});
