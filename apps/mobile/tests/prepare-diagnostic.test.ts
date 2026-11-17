import { describe, expect, it, vi } from 'vitest';
import { prepareDiagnostic } from '../qualification/prepare-diagnostic.js';

describe('qualification preparation', () => {
  it('continues with the native module when cookie seeding fails without exposing details', async () => {
    const native = { marker: true };
    const result = await prepareDiagnostic({
      loadModule: () => native,
      seedCookie: async () => {
        throw new Error('private details');
      },
      timeoutMs: 100,
    });
    expect(result.native).toBe(native);
    expect(result.messages).toContain('Module BoundedHttps : chargé.');
    expect(result.messages.join(' ')).toContain('qualification cookie non concluante');
    expect(result.messages.join(' ')).not.toContain('private details');
  });
  it('reports module loading separately and still attempts cookie seeding', async () => {
    const seedCookie = vi.fn(async () => true);
    const result = await prepareDiagnostic({
      loadModule: () => {
        throw new Error('private details');
      },
      seedCookie,
      timeoutMs: 100,
    });
    expect(result.native).toBeNull();
    expect(seedCookie).toHaveBeenCalledOnce();
    expect(result.messages).toContain('Module BoundedHttps : chargement impossible.');
    expect(result.messages.join(' ')).not.toContain('private details');
  });
  it('marks a non-200 response inconclusive', async () => {
    const result = await prepareDiagnostic({
      loadModule: () => 1,
      seedCookie: async () => false,
      timeoutMs: 100,
    });
    expect(result.native).toBe(1);
    expect(result.messages.join(' ')).toContain('qualification cookie non concluante');
  });
  it('continues when the cookie request never settles and aborts it', async () => {
    let signal: AbortSignal | undefined;
    const result = await prepareDiagnostic({
      loadModule: () => 1,
      seedCookie: (value) => {
        signal = value;
        return new Promise(() => {});
      },
      timeoutMs: 10,
    });
    expect(result.native).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(result.messages.join(' ')).toContain('délai dépassé');
  });
});
