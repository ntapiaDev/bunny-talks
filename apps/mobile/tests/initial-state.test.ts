import { describe, expect, it, vi } from 'vitest';
import { assertFreshDiagnosticStores } from '../src/initial-state';

function emptyStore() {
  return {
    hasIdentityKey: vi.fn(async () => false),
    getLocalRegistrationId: vi.fn(async () => 0),
    getEcSignedPreKey: vi.fn(async () => null),
    getKyberPreKey: vi.fn(async () => null),
    getSessionRecord: vi.fn(async () => null),
  };
}

describe('diagnostic initialization', () => {
  it('accepts only empty diagnostic state', async () => {
    const a = emptyStore();
    const b = emptyStore();
    const c = emptyStore();
    await expect(assertFreshDiagnosticStores(a, b, c)).resolves.toBeUndefined();
    expect(c.getSessionRecord).toHaveBeenCalledTimes(2);
  });
  it('refuses a partial registration or orphaned session before generating identities', async () => {
    const a = emptyStore();
    const b = emptyStore();
    const c = emptyStore();
    b.getLocalRegistrationId.mockResolvedValueOnce(7);
    await expect(assertFreshDiagnosticStores(a, b, c)).rejects.toThrow('partially initialized');
    c.getSessionRecord.mockResolvedValueOnce({} as never);
    await expect(assertFreshDiagnosticStores(a, b, c)).rejects.toThrow('contains a session');
  });
});
