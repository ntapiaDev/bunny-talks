import { getEventListeners } from 'node:events';
import { expect, it, vi } from 'vitest';
import { fixtureJson } from '../qualification/fixture-data.js';
import {
  runCookieQualification,
  runEstablishedCancellation,
  runMemoryCycles,
} from '../qualification/qualification-scenarios.js';

const ok = {
  status: 200,
  contentType: 'application/json',
  bytes: new TextEncoder().encode(fixtureJson),
};

it('waits for explicit cancel and for the slow read to reject before probing both slots', async () => {
  let rejectSlow!: (reason: unknown) => void;
  const slow = new Promise<never>((_, reject) => {
    rejectSlow = reject;
  });
  const native = {
    start: vi.fn(),
    read: vi.fn((id: string) => (id === 'confirmed-abort' ? slow : Promise.resolve(ok))),
    cancel: vi.fn(),
  };
  const report = vi.fn();
  const controller = new AbortController();
  const run = runEstablishedCancellation(native, controller.signal, report, () => true);
  expect(native.read).toHaveBeenCalledExactlyOnceWith('confirmed-abort');
  expect(native.cancel).not.toHaveBeenCalled();
  controller.abort();
  expect(native.cancel).toHaveBeenCalledExactlyOnceWith('confirmed-abort');
  expect(native.start).toHaveBeenCalledTimes(1);
  rejectSlow({ code: 'ERR_NETWORK' });
  await run;
  expect(native.read.mock.calls.map(([id]) => id)).toEqual([
    'confirmed-abort',
    'reuse-one',
    'reuse-two',
  ]);
  expect(native.start.mock.invocationCallOrder[2]!).toBeLessThan(
    native.read.mock.invocationCallOrder[1]!,
  );
  expect(report).toHaveBeenCalledWith(expect.stringContaining('deux requêtes abouties'));
});

it('runs five complete memory cycles and releases cancellation hooks between series', async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    let rejectSlow: (() => void) | undefined;
    const networkError = { code: 'ERR_NETWORK' };
    const native = {
      start: vi.fn(),
      read: vi.fn(async (id: string) => {
        if (id === 'gzip') return ok;
        if (id === 'oversize') throw { code: 'ERR_SIZE' };
        if (id === 'memory-cancel') {
          await new Promise<never>((_, reject) => {
            rejectSlow = () => reject(networkError);
          });
        }
        if (id === 'memory-timeout') await new Promise((resolve) => setTimeout(resolve, 1500));
        throw networkError;
      }),
      cancel: vi.fn((id: string) => {
        if (id === 'memory-cancel') {
          rejectSlow?.();
          rejectSlow = undefined;
        }
      }),
    };
    const report = vi.fn();
    const run = runMemoryCycles(native, controller.signal, report);
    await vi.runAllTimersAsync();
    await run;
    const cycle = ['gzip', 'oversize', 'truncated', 'memory-timeout', 'memory-cancel'];
    expect(native.read.mock.calls.map(([id]) => id)).toEqual(Array(5).fill(cycle).flat());
    expect(report).toHaveBeenCalledTimes(25);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

it('treats a network rejection before cancel as inconclusive and does not probe slots', async () => {
  const native = {
    start: vi.fn(),
    read: vi.fn(async () => {
      throw { code: 'ERR_NETWORK', message: 'private details' };
    }),
    cancel: vi.fn(),
  };
  const report = vi.fn();
  await runEstablishedCancellation(native, new AbortController().signal, report, () => true);
  expect(native.read).toHaveBeenCalledExactlyOnceWith('confirmed-abort');
  expect(report).toHaveBeenCalledWith(expect.stringContaining('non concluante'));
  expect(JSON.stringify(report.mock.calls)).not.toContain('private details');
});

it('uses the shared Expo client on the same run-specific path before and after both native controls', async () => {
  const calls: string[] = [];
  const runId = '12345678-1234-1234-1234-123456789abc';
  const native = {
    start: (_id: string, url: string) => {
      calls.push('native ' + new URL(url).pathname);
    },
    read: async () => ok,
    cancel: vi.fn(),
  };
  const report = vi.fn();
  await runCookieQualification(
    native,
    runId,
    async (url) => {
      calls.push('expo ' + new URL(url).pathname);
      return true;
    },
    report,
    new AbortController().signal,
  );
  expect(calls).toEqual([
    `expo /cookies/${runId}/baseline`,
    `expo /cookies/${runId}/seed`,
    `expo /cookies/${runId}/expo-probe`,
    `native /cookies/${runId}/native-probe`,
    `native /cookies/${runId}/native-set`,
    `expo /cookies/${runId}/expo-after`,
  ]);
  expect(report).toHaveBeenCalledWith(expect.stringContaining('à vérifier dans les compteurs'));
});

it('releases the first recovery reservation if the second is rejected', async () => {
  const controller = new AbortController();
  const native = {
    start: vi.fn((id: string) => {
      if (id === 'reuse-two') throw new Error('no available slot');
    }),
    read: vi.fn(async () => {
      controller.abort();
      throw { code: 'ERR_NETWORK' };
    }),
    cancel: vi.fn(),
  };
  const report = vi.fn();
  await runEstablishedCancellation(native, controller.signal, report, () => true);
  expect(native.read).toHaveBeenCalledExactlyOnceWith('confirmed-abort');
  expect(native.cancel).toHaveBeenCalledWith('reuse-one');
  expect(native.cancel).not.toHaveBeenCalledWith('reuse-two');
  expect(report).toHaveBeenCalledWith(
    expect.stringContaining('Réutilisation : contrôle non concluant'),
  );
});
