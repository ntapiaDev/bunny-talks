import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpTransport } from '../src/infrastructure/http/application-http';
import {
  ApplicationHttpError,
  createApplicationHttpClient,
} from '../src/infrastructure/http/application-http';

const encoder = new TextEncoder();
function response(
  body: string | Uint8Array = '{"status":"ok"}',
  status = 200,
  contentType: string | null = 'application/json',
) {
  return {
    ok: true as const,
    status,
    contentType,
    body: typeof body === 'string' ? encoder.encode(body) : body,
  };
}
function client(
  transport: HttpTransport,
  extra: Partial<{ origin: string; timeoutMs: number; maxResponseBytes: number }> = {},
) {
  return createApplicationHttpClient({
    origin: 'https://api.example.org',
    timeoutMs: 100,
    maxResponseBytes: 128,
    transport,
    ...extra,
  });
}
const request = { path: '/v1/session', method: 'GET' as const, expectedStatuses: [200] };
type RequestOptions = Parameters<ReturnType<typeof client>['request']>[0];
type TransportResult = Awaited<ReturnType<HttpTransport>>;

afterEach(() => vi.useRealTimers());

describe('application HTTP foundation', () => {
  it('passes only controlled headers, policies, and limits to the adapter', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const transport = vi.fn<HttpTransport>(async () => response());
    const api = client(transport);
    await expect(api.request({ ...request, bearerToken: 's1.example-token' })).resolves.toEqual({
      status: 'ok',
    });
    expect(transport).toHaveBeenCalledExactlyOnceWith({
      url: 'https://api.example.org/v1/session',
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'Bearer s1.example-token' },
      maxResponseBytes: 128,
      timeoutMs: 100,
      signal: expect.any(AbortSignal),
      redirect: 'error',
      credentials: 'omit',
      retry: 'never',
    });
    await api.request({
      ...request,
      headers: { Cookie: 'fixture-cookie', Authorization: 'fixture-authorization' },
    } as RequestOptions);
    expect(transport.mock.calls[1]![0].headers).toEqual({ Accept: 'application/json' });
  });

  it('omits an inherited bearer credential', async () => {
    const transport = vi.fn<HttpTransport>(async () => response());
    const options = Object.assign(Object.create({ bearerToken: 'fixture-inherited' }), request);
    await client(transport).request(options);
    expect(transport.mock.calls[0]![0].headers).toEqual({ Accept: 'application/json' });
  });

  it.each([
    'http://api.example.org',
    'http://localhost',
    'https://user:pass@example.org',
    'https://@example.org',
    'https://example.org/path',
    'https://example.org/%2e',
    'https://%65xample.org',
    'https://example.org:',
    'https://example.org/?',
    'https://example.org/#',
    'https:example.org',
    ' https://example.org',
    'https://exam\nple.org',
    'https://example.org\\',
  ])('rejects malformed origin %j', (origin) => {
    expect(() => client(async () => response(), { origin })).toThrowError(
      expect.objectContaining({ kind: 'configuration' }),
    );
  });

  it('accepts an HTTPS origin with an explicit port and a root slash', async () => {
    const transport = vi.fn<HttpTransport>(async () => response());
    await client(transport, { origin: 'https://[::1]:8443/' }).request(request);
    expect(transport.mock.calls[0]![0].url).toBe('https://[::1]:8443/v1/session');
  });

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 120_001 },
    { timeoutMs: 1.5 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: 1_048_577 },
    { maxResponseBytes: NaN },
    { maxResponseBytes: Infinity },
  ])('rejects malformed configuration %j', (config) => {
    expect(() => client(async () => response(), config)).toThrowError(
      expect.objectContaining({ kind: 'configuration' }),
    );
  });

  it.each([
    { path: '/v1/../other' },
    { path: '//example.org/v1/a' },
    { path: '/v1/session?x=1' },
    { path: '/v1/s%65ssion' },
    { path: '/v1/session\n' },
    { path: '/v1/Session' },
    { path: '/v1/session/' },
    { path: ['/v1/session'] },
    { bearerToken: 'token\r\nX: fixture' },
    { bearerToken: ['fixture'] },
    { bearerToken: '' },
    { bearerToken: 'a'.repeat(513) },
    { body: {} },
    { method: 'DELETE', body: null },
    { method: 'PATCH' },
    { expectedStatuses: [] },
    { expectedStatuses: [200, 302] },
    { expectedStatuses: new Array<number>(2).fill(200, 0, 1) },
    { expectedStatuses: ['200'] },
    { expectedStatuses: [200.5] },
    { signal: {} },
    { method: 'POST', body: 1n },
    { method: 'POST', body: () => ({}) },
  ])('rejects malformed request options %# before transport', async (options) => {
    const transport = vi.fn<HttpTransport>(async () => response());
    await expect(
      client(transport).request({ ...request, ...options } as RequestOptions),
    ).rejects.toEqual(new ApplicationHttpError('request'));
    expect(transport).not.toHaveBeenCalled();
  });

  it('sends JSON for POST and accepts the configured 201 result as unvalidated JSON', async () => {
    const transport = vi.fn<HttpTransport>(async () => response('{"fixture":1}', 201));
    await expect(
      client(transport).request({
        path: '/v1/auth/login',
        method: 'POST',
        body: { value: 1 },
        expectedStatuses: [201],
      }),
    ).resolves.toEqual({ fixture: 1 });
    expect(transport.mock.calls[0]![0]).toMatchObject({
      body: '{"value":1}',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    });
  });

  it('accepts either configured success status for a receipt', async () => {
    const transport = vi.fn<HttpTransport>(async () => response('{"status":"unknown"}', 202));
    transport.mockResolvedValueOnce(response('{"status":"committed"}', 200));
    const api = client(transport);
    const options = {
      path: '/v1/vault/bootstrap/receipt',
      method: 'POST' as const,
      expectedStatuses: [200, 202],
      bearerToken: 'fixture-token',
      body: { fixture: true },
    };
    await expect(api.request(options)).resolves.toEqual({ status: 'committed' });
    await expect(api.request(options)).resolves.toEqual({ status: 'unknown' });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('exposes the validated HTTP status to receipt composition', async () => {
    const transport = vi.fn<HttpTransport>();
    transport.mockResolvedValueOnce(response('{"status":"committed"}', 200));
    transport.mockResolvedValueOnce(response('{"status":"unknown"}', 202));
    const api = client(transport);
    const options = {
      path: '/v1/vault/bootstrap/receipt',
      method: 'POST' as const,
      expectedStatuses: [200, 202],
      bearerToken: 'fixture-token',
      body: { fixture: true },
    };
    await expect(api.requestWithStatus(options)).resolves.toEqual({
      status: 200,
      body: { status: 'committed' },
    });
    await expect(api.requestWithStatus(options)).resolves.toEqual({
      status: 202,
      body: { status: 'unknown' },
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('requires a zero-byte body for an expected 204', async () => {
    const transport = vi.fn<HttpTransport>();
    transport.mockResolvedValueOnce(response('', 204, null));
    transport.mockResolvedValueOnce(response(' ', 204, null));
    const api = client(transport);
    const options = { ...request, method: 'DELETE' as const, expectedStatuses: [204] };
    await expect(api.request(options)).resolves.toBeUndefined();
    await expect(api.request(options)).rejects.toEqual(new ApplicationHttpError('response'));
  });

  it('counts UTF-8 bytes at the exact configured boundary and rejects one byte more', async () => {
    const body = '"é"';
    const transport = vi.fn<HttpTransport>();
    transport.mockResolvedValueOnce(response(body, 200, 'application/json; charset=UTF-8'));
    transport.mockResolvedValueOnce(response(body + ' '));
    const api = client(transport, { maxResponseBytes: 4 });
    await expect(api.request(request)).resolves.toBe('é');
    await expect(api.request(request)).rejects.toEqual(new ApplicationHttpError('size'));
  });

  it('accepts the maximum configured limit and refuses an oversized unexpected status', async () => {
    const maxResponseBytes = 1_048_576;
    const body = '"' + 'a'.repeat(maxResponseBytes - 2) + '"';
    const transport = vi.fn<HttpTransport>();
    transport.mockResolvedValueOnce(response(body));
    transport.mockResolvedValueOnce(response(body + ' ', 503));
    const api = client(transport, { maxResponseBytes });
    await expect(api.request(request)).resolves.toHaveLength(maxResponseBytes - 2);
    await expect(api.request(request)).rejects.toEqual(new ApplicationHttpError('size'));
  });

  it.each([
    response(''),
    response('{'),
    response('{}', 200, 'text/plain'),
    response('{}', 200, 'application/json; charset=iso-8859-1'),
    response('{}', 200, null),
    response('{}', 999),
    response(new Uint8Array([0x22, 0xff, 0x22])), // A replacement character would still form JSON.
    response(new Uint8Array([0x22, 0xc3])),
    { ...response(), body: '{}' },
    { ...response(), contentType: ['application/json'] },
    null,
  ])('fails closed on malformed response %#', async (result) => {
    await expect(client(async () => result as TransportResult).request(request)).rejects.toEqual(
      new ApplicationHttpError('response'),
    );
  });

  it.each([201, 204, 401, 503])('reports only the unexpected status %i', async (status) => {
    await expect(
      client(async () => response('{"error":{"code":"OUTCOME_UNKNOWN"}}', status)).request(request),
    ).rejects.toEqual(new ApplicationHttpError('status', status));
  });

  it.each([301, 302, 303, 307, 308])('rejects a visible %i without replay', async (status) => {
    const transport = vi.fn<HttpTransport>(async () => response('', status, null));
    await expect(client(transport).request(request)).rejects.toEqual(
      new ApplicationHttpError('redirect'),
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(['redirect', 'size', 'network', 'timeout', 'response'] as const)(
    'maps adapter failure %s to a fresh sanitized error',
    async (kind) => {
      const result = { ok: false as const, kind, detail: 'private fixture detail', status: 401 };
      const error = await client(async () => result)
        .request(request)
        .catch((error: unknown) => error);
      expect(error).toEqual(new ApplicationHttpError(kind));
      expect(error).not.toHaveProperty('detail');
      expect(error).not.toHaveProperty('cause');
      expect(error).toHaveProperty('status', undefined);
    },
  );

  it('sanitizes even a typed exception and an unknown failure code from the adapter', async () => {
    const error = Object.assign(new ApplicationHttpError('status', 401), {
      cause: new Error('private fixture detail'),
    });
    const transport = vi.fn<HttpTransport>(async () => {
      throw error;
    });
    transport.mockResolvedValueOnce({ ok: false, kind: 'unknown detail' } as never);
    const api = client(transport);
    for (let attempt = 0; attempt < 2; attempt++) {
      const failure = await api.request(request).catch((error: unknown) => error);
      expect(failure).toEqual(new ApplicationHttpError('network'));
      expect(failure).not.toHaveProperty('cause');
      expect(failure).toHaveProperty('status', undefined);
    }
  });

  it('does not dispatch a request already cancelled by its caller', async () => {
    const transport = vi.fn<HttpTransport>(async () => response());
    const signal = AbortSignal.abort('private fixture reason');
    const failure = await client(transport)
      .request({ ...request, signal })
      .catch((error: unknown) => error);
    expect(failure).toEqual(new ApplicationHttpError('cancelled'));
    expect(failure).not.toHaveProperty('cause');
    expect(transport).not.toHaveBeenCalled();
  });

  it('forwards caller cancellation during a mutation and ignores a late response', async () => {
    const caller = new AbortController();
    let finishRead: (value: TransportResult) => void = () => {};
    const onAbort = vi.fn();
    const transport = vi.fn<HttpTransport>(
      ({ signal }) =>
        new Promise((resolve) => {
          finishRead = resolve;
          signal.addEventListener('abort', onAbort, { once: true });
        }),
    );
    const pending = client(transport).request({
      ...request,
      method: 'DELETE',
      expectedStatuses: [204],
      signal: caller.signal,
    });
    caller.abort('private fixture reason');
    await expect(pending).rejects.toEqual(new ApplicationHttpError('cancelled'));
    finishRead(response('', 204, null));
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('passes the remaining deadline and times out while the complete body is pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let finishRead: (value: TransportResult) => void = () => {};
    const onAbort = vi.fn();
    const transport = vi.fn<HttpTransport>(
      ({ signal }) =>
        new Promise((resolve) => {
          finishRead = resolve;
          signal.addEventListener('abort', onAbort, { once: true });
        }),
    );
    const pending = client(transport, { timeoutMs: 50 }).request({
      path: '/v1/auth/login',
      method: 'POST',
      expectedStatuses: [201],
      body: {
        toJSON() {
          vi.advanceTimersByTime(10);
          return { fixture: true };
        },
      },
    });
    const timeout = expect(pending).rejects.toEqual(new ApplicationHttpError('timeout'));
    expect(transport.mock.calls[0]![0]).toMatchObject({ timeoutMs: 40 });
    await vi.advanceTimersByTimeAsync(39);
    expect(onAbort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await timeout;
    finishRead(response('{}', 201));
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does not accept delivery after the deadline even when the timer has not fired', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const transport = vi.fn<HttpTransport>(async () => {
      vi.spyOn(performance, 'now').mockReturnValueOnce(101);
      return response();
    });
    try {
      await expect(client(transport).request(request)).rejects.toEqual(
        new ApplicationHttpError('timeout'),
      );
      expect(transport.mock.calls[0]![0].signal.aborted).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not accept a result when validation finishes at the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const transport = vi.fn<HttpTransport>(async () => {
      vi.spyOn(performance, 'now').mockReturnValueOnce(99).mockReturnValueOnce(100);
      return response();
    });
    try {
      await expect(client(transport).request(request)).rejects.toEqual(
        new ApplicationHttpError('timeout'),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not dispatch a request when serialization consumes its entire deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const transport = vi.fn<HttpTransport>(async () => response());
    const result = client(transport, { timeoutMs: 1 }).request({
      ...request,
      method: 'POST',
      body: {
        toJSON() {
          vi.advanceTimersByTime(1);
          return { fixture: true };
        },
      },
    });
    await expect(result).rejects.toEqual(new ApplicationHttpError('timeout'));
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, kind: 'network' },
    response('{"error":{"code":"OUTCOME_UNKNOWN"}}', 503),
    response('{"invalid":', 201),
  ] satisfies TransportResult[])(
    'never replays a login with an uncertain outcome %#',
    async (result) => {
      const transport = vi.fn<HttpTransport>(async () => result);
      await expect(
        client(transport).request({
          path: '/v1/auth/login',
          method: 'POST',
          expectedStatuses: [201],
          body: { fixture: true },
        }),
      ).rejects.toBeInstanceOf(ApplicationHttpError);
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
});
