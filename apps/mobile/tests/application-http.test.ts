import { describe, expect, it, vi } from 'vitest';
import type { HttpTransport } from '../src/infrastructure/http/application-http';
import {
  ApplicationHttpError,
  createApplicationHttpClient,
} from '../src/infrastructure/http/application-http';

const encoder = new TextEncoder();
function response(
  text = '{"status":"ok"}',
  status = 200,
  contentType: string | null = 'application/json',
) {
  return {
    status,
    contentType,
    body: (async function* () {
      yield encoder.encode(text);
    })(),
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

describe('application HTTP foundation', () => {
  it('passes only controlled headers and transport policies', async () => {
    const transport = vi.fn<HttpTransport>(async () => response());
    await expect(
      client(transport).request({ ...request, bearerToken: 's1.example-token' }),
    ).resolves.toEqual({ status: 'ok' });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.example.org/v1/session',
        headers: { Accept: 'application/json', Authorization: 'Bearer s1.example-token' },
        redirect: 'error',
        credentials: 'omit',
      }),
    );
    await client(transport).request(request);
    expect(transport.mock.calls[1]![0].headers).toEqual({ Accept: 'application/json' });
  });
  it('rejects all cleartext destinations and malformed configuration', () => {
    for (const origin of [
      'http://10.0.2.2:3000',
      'http://localhost',
      'https://user:pass@example.org',
      'https://example.org/path',
      'https://example.org/?x=1',
    ]) {
      expect(() => client(async () => response(), { origin })).toThrowError(
        expect.objectContaining({ kind: 'configuration' }),
      );
    }
    expect(() => client(async () => response(), { maxResponseBytes: 0 })).toThrow(
      ApplicationHttpError,
    );
  });
  it('rejects unsafe paths, methods, bodies and bearer values before transport', async () => {
    const transport = vi.fn<HttpTransport>(async () => response());
    const api = client(transport);
    for (const input of [
      { ...request, path: '/v1/../other' },
      { ...request, path: '//evil/v1/a' },
      { ...request, path: '/v1/session?x=1' },
      { ...request, bearerToken: 'token\r\nX: secret' },
      { ...request, body: {} },
      { ...request, method: 'PATCH' as 'GET' },
    ]) {
      await expect(api.request(input)).rejects.toMatchObject({ kind: 'request' });
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it('sends JSON for POST and handles empty 204', async () => {
    const transport = vi.fn<HttpTransport>(async () => response('', 204, null));
    await expect(
      client(transport).request({
        path: '/v1/auth/login',
        method: 'POST',
        body: { value: 1 },
        expectedStatuses: [204],
      }),
    ).resolves.toBeUndefined();
    expect(transport.mock.calls[0]![0]).toMatchObject({
      body: '{"value":1}',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    });
  });
  it('sanitizes network errors and rejects unexpected status and redirects', async () => {
    await expect(
      client(async () => {
        throw new Error('sensitive detail');
      }).request(request),
    ).rejects.toEqual(new ApplicationHttpError('network'));
    await expect(client(async () => response('secret', 401)).request(request)).rejects.toEqual(
      new ApplicationHttpError('status', 401),
    );
    await expect(client(async () => response('', 302)).request(request)).rejects.toEqual(
      new ApplicationHttpError('redirect'),
    );
  });
  it('limits the entire request even when transport ignores abort', async () => {
    let signal: AbortSignal | undefined;
    const api = client(
      async (input) => {
        signal = input.signal;
        return new Promise(() => {});
      },
      { timeoutMs: 5 },
    );
    await expect(api.request(request)).rejects.toMatchObject({ kind: 'timeout' });
    expect(signal?.aborted).toBe(true);
  });
  it('limits streaming bytes and rejects malformed responses', async () => {
    await expect(
      client(async () => response('12345'), { maxResponseBytes: 4 }).request(request),
    ).rejects.toMatchObject({ kind: 'size' });
    for (const result of [
      response('{'),
      response('{}', 200, 'text/plain'),
      response('x', 204, null),
      { ...response(), status: 999 },
      {
        ...response(),
        body: (async function* () {
          yield new Uint8Array([0xff]);
        })(),
      },
    ]) {
      await expect(
        client(async () => result).request({ ...request, expectedStatuses: [200, 204] }),
      ).rejects.toMatchObject({ kind: 'response' });
    }
  });
  it('preserves response bytes when the transport reuses its buffer', async () => {
    const transport: HttpTransport = async () => ({
      ...response(),
      body: (async function* () {
        const buffer = new Uint8Array(16);
        for (const part of ['{"value":', '"hello"}']) {
          const bytes = encoder.encode(part);
          buffer.set(bytes);
          yield buffer.subarray(0, bytes.length);
        }
        buffer.fill(0);
      })(),
    });
    await expect(client(transport).request(request)).resolves.toEqual({ value: 'hello' });
  });
  it('times out while reading and aborts after a size failure', async () => {
    let signal: AbortSignal | undefined;
    const transport: HttpTransport = async (input) => {
      signal = input.signal;
      return {
        ...response(),
        body: (async function* () {
          await new Promise(() => {});
          yield new Uint8Array();
        })(),
      };
    };
    await expect(client(transport, { timeoutMs: 5 }).request(request)).rejects.toMatchObject({
      kind: 'timeout',
    });
    expect(signal?.aborted).toBe(true);
    await expect(
      client(
        async (input) => {
          signal = input.signal;
          return response('12345');
        },
        { maxResponseBytes: 4 },
      ).request(request),
    ).rejects.toMatchObject({ kind: 'size' });
    expect(signal?.aborted).toBe(true);
  });
});
