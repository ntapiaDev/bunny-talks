import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiDiagnostic } from '../qualification/crypto/diagnostics/api-diagnostics';
import { createLocalApiHealthCheck } from '../qualification/crypto/diagnostics/local-api-health';

const createCheck = (
  transport: (url: string, init: RequestInit) => Promise<Response>,
  development = true,
  platform = 'android',
  fingerprint = 'google/sdk_gphone64_x86_64/emulator:17/test',
) => createLocalApiHealthCheck({ transport, development, platform, fingerprint });

afterEach(() => vi.useRealTimers());

describe('local API health diagnostic', () => {
  it('accepts only the expected HTTP response and sends no credentials', async () => {
    const transport = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response('{"status":"ok"}'));
    expect(await createCheck(transport)()).toBe('success');
    expect(transport).toHaveBeenCalledWith('http://10.0.2.2:3000/health/live', {
      method: 'GET',
      credentials: 'omit',
      signal: expect.any(AbortSignal),
    });
  });
  it('classifies HTTP failures', async () => {
    expect(
      await createCheck(
        vi
          .fn<(url: string, init: RequestInit) => Promise<Response>>()
          .mockResolvedValue(new Response('', { status: 503 })),
      )(),
    ).toBe('http');
  });
  it('rejects a response from a different final URL', async () => {
    const response = new Response('{"status":"ok"}');
    Object.defineProperty(response, 'url', { value: 'http://other.example/health/live' });
    expect(
      await createCheck(
        vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(response),
      )(),
    ).toBe('http');
  });
  it.each(['{', '{}', '{"status":"bad"}', '{"status":"ok","extra":true}', 'null', '[]'])(
    'rejects invalid content %s',
    async (body) => {
      expect(
        await createCheck(
          vi
            .fn<(url: string, init: RequestInit) => Promise<Response>>()
            .mockResolvedValue(new Response(body)),
        )(),
      ).toBe('invalid');
    },
  );
  it('classifies network failures', async () => {
    expect(
      await createCheck(
        vi
          .fn<(url: string, init: RequestInit) => Promise<Response>>()
          .mockRejectedValue(new Error('private detail')),
      )(),
    ).toBe('network');
  });
  it('times out and aborts even if the transport never settles', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const transport = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockImplementation((_url, init) => {
        signal = init?.signal as AbortSignal;
        return new Promise(() => {});
      });
    const result = createCheck(transport)();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBe('timeout');
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('also limits the time spent reading the response body', async () => {
    vi.useFakeTimers();
    const response = { status: 200, json: () => new Promise(() => {}) } as Response;
    const result = createCheck(
      vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(response),
    )();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBe('timeout');
  });
  it.each([
    [false, 'android'],
    [true, 'ios'],
    [true, 'web'],
    [false, 'ios'],
  ])('refuses development=%s platform=%s', async (development, platform) => {
    const transport = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
    expect(await createCheck(transport, development, platform)()).toBe('unavailable');
    expect(transport).not.toHaveBeenCalled();
  });
  it('refuses Android devices without a recognized emulator fingerprint', async () => {
    const transport = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
    expect(await createCheck(transport, true, 'android', 'vendor/device/physical:17')()).toBe(
      'unavailable',
    );
    expect(transport).not.toHaveBeenCalled();
  });
  it('reports a safe message even when the action throws', async () => {
    const report = vi.fn();
    await createApiDiagnostic(async () => {
      throw new Error('secret');
    })(report);
    expect(report).toHaveBeenCalledWith({
      status: 'fail',
      label: 'Connexion à l’API locale impossible',
    });
  });
});
