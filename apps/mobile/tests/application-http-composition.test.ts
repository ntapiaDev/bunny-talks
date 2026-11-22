import { expect, it, vi } from 'vitest';
import { createMobileApplicationHttpClient } from '../src/composition/http-composition';

const { platform, requireNativeModule } = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  requireNativeModule: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('expo', () => ({ requireNativeModule }));

const config = { origin: 'https://fixture.invalid', timeoutMs: 5000, maxResponseBytes: 50 };

it.each(['ios', 'web'])('refuses %s before loading the native module', (os) => {
  platform.OS = os;
  expect(() => createMobileApplicationHttpClient(config)).toThrow(
    expect.objectContaining({ kind: 'configuration', message: 'HTTP configuration' }),
  );
  expect(requireNativeModule).not.toHaveBeenCalled();
});

it('routes Android application requests through ApplicationHttps', async () => {
  platform.OS = 'android';
  const execute = vi.fn(async () => ({
    ok: true,
    status: 204,
    contentType: null,
    bytes: new ArrayBuffer(0),
  }));
  requireNativeModule.mockReturnValue({ reserve: () => 'fixture-id', execute, cancel: vi.fn() });

  const client = createMobileApplicationHttpClient(config);
  await client.request({ method: 'GET', path: '/v1/fixture', expectedStatuses: [204] });
  expect(requireNativeModule).toHaveBeenCalledExactlyOnceWith('ApplicationHttps');
  expect(execute).toHaveBeenCalledExactlyOnceWith(
    'fixture-id',
    'https://fixture.invalid/v1/fixture',
    'GET',
    { Accept: 'application/json' },
    null,
    50,
  );
});
