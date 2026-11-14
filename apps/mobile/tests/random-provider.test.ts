import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  getRandomValues: vi.fn((input: Uint8Array) => input.fill(42)),
}));
vi.mock('expo-crypto', () => ({ getRandomValues: native.getRandomValues }));

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalRandom =
  originalCrypto?.value && Object.getOwnPropertyDescriptor(originalCrypto.value, 'getRandomValues');

afterEach(() => {
  if (originalCrypto) {
    Object.defineProperty(globalThis, 'crypto', originalCrypto);
    if (originalRandom)
      Object.defineProperty(originalCrypto.value, 'getRandomValues', originalRandom);
  } else Reflect.deleteProperty(globalThis, 'crypto');
  vi.resetModules();
  vi.clearAllMocks();
});

describe('native randomness installation', () => {
  it('delegates to the native provider even when a global source already exists', async () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        getRandomValues: () => {
          throw new Error('unexpected existing source');
        },
      },
      configurable: true,
    });
    await import('../src/random-provider');
    const bytes = new Uint8Array(4);
    expect(globalThis.crypto.getRandomValues(bytes)).toBe(bytes);
    expect(bytes).toEqual(new Uint8Array([42, 42, 42, 42]));
  });

  it('propagates native failures rather than using predictable output', async () => {
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    native.getRandomValues.mockImplementationOnce(() => {
      throw new Error('native unavailable');
    });
    await import('../src/random-provider');
    expect(() => globalThis.crypto.getRandomValues(new Uint8Array(8))).toThrow(
      'native unavailable',
    );
  });
});
