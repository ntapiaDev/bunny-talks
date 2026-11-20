import { describe, expect, it, vi } from 'vitest';
import type { HttpTransport } from '../src/infrastructure/http/application-http';
import { createNativeHttpsTransport } from '../src/infrastructure/http/native-https-transport';

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
});
