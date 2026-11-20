import { registerRootComponent, requireNativeModule } from 'expo';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, Text } from 'react-native';
import {
  ApplicationHttpError,
  createApplicationHttpClient,
} from '../src/infrastructure/http/application-http';
import type { ApplicationHttpsModule } from '../src/infrastructure/http/native-https-transport';
import { createNativeHttpsTransport } from '../src/infrastructure/http/native-https-transport';

const host = Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
const fixturePort = 29_443;
const origin = (port = fixturePort) => `https://${host}:${port}`;
const prefix = '/v1/https-qualification';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// Both isolated qualification profiles can embed this entry without Metro.
const embeddedQualification = process.env.EXPO_PUBLIC_BUNNY_HTTPS_QUALIFICATION === '1';
const enabled = embeddedQualification && (Platform.OS === 'android' || Platform.OS === 'ios');
const qualificationTracePattern =
  /^(?:[a-z][a-z0-9-]{0,27}:[0-9]{1,6},){0,23}[a-z][a-z0-9-]{0,27}:[0-9]{1,6}$/;

class ScenarioFailure extends Error {
  constructor(
    readonly expected: string,
    readonly observed: string,
  ) {
    super('qualification assertion');
  }
}

function assert(
  condition: unknown,
  expected = 'fixture-value',
  observed = 'mismatch',
): asserts condition {
  if (!condition) throw new ScenarioFailure(expected, observed);
}

const responseKind = (kind: unknown) => {
  switch (kind) {
    case 'network':
    case 'cancelled':
    case 'timeout':
    case 'redirect':
    case 'response':
    case 'size':
    case 'request':
    case 'configuration':
    case 'status':
      return kind;
    default:
      return 'unknown-kind';
  }
};

function outcome(error: unknown): string {
  if (!(error instanceof ApplicationHttpError)) return 'unexpected-exception';
  if (error.kind !== 'status') return responseKind(error.kind);
  const status = error.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? `status-${status}`
    : 'invalid-status';
}

function expectNativeFailure(value: unknown, ...kinds: string[]) {
  const expected = kinds.join('-or-');
  assert(value !== null && typeof value === 'object', expected, 'invalid-native-result');
  assert(!('bytes' in value), 'no-body', 'body-present');
  const observed = 'kind' in value ? responseKind(value.kind) : 'invalid-native-result';
  assert('ok' in value && value.ok === false && kinds.includes(observed), expected, observed);
}

async function expectFailure(pending: Promise<unknown>, kind: string, status?: number) {
  const expected = status === undefined ? kind : `${kind}-${status}`;
  const observed = await pending.then(() => 'success', outcome);
  assert(observed === expected, expected, observed);
}

async function qualify(report: (line: string) => void) {
  const raw = requireNativeModule<
    ApplicationHttpsModule & { qualificationProfile?: () => unknown }
  >('ApplicationHttps');
  const ios = Platform.OS === 'ios';
  let currentScenario = 'setup';
  let invocation = 0;
  let native: ApplicationHttpsModule = raw;
  if (ios) {
    assert(raw.qualificationProfile?.() === 'identity', 'identity-profile', 'profile-unavailable');
    report(
      `READY ApplicationHttps ${'HermesInternal' in globalThis ? 'Hermes' : 'unknown engine'}`,
    );
    report('PROFILE identity');
    native = {
      reserve: (timeoutMs) => raw.reserve(timeoutMs),
      cancel: (id) => raw.cancel(id),
      execute: (...args) => {
        const scenario = currentScenario;
        const number = ++invocation;
        report(`INVOKE ${scenario} ${number}`);
        return raw.execute(...args).then((result: unknown) => {
          const trace =
            result && typeof result === 'object' && 'qualificationTrace' in result
              ? result.qualificationTrace
              : undefined;
          if (
            typeof trace === 'string' &&
            trace.length <= 863 &&
            qualificationTracePattern.test(trace)
          ) {
            report(`NATIVE ${scenario} ${number} ${trace}`);
          }
          return result;
        });
      },
    };
  }
  const transport = createNativeHttpsTransport(() => native);
  const client = (port = fixturePort, timeoutMs = 4000) =>
    createApplicationHttpClient({
      origin: origin(port),
      timeoutMs,
      maxResponseBytes: 1_048_576,
      transport,
    });
  const request = (
    path: string,
    options: Partial<Parameters<ReturnType<typeof client>['request']>[0]> = {},
    port = fixturePort,
  ) =>
    client(port).request({
      path: prefix + path,
      method: 'GET',
      expectedStatuses: [200],
      ...options,
    });

  const cases: Array<{ id: string; test: () => Promise<void> }> = [];
  const scenario = (id: string, test: () => Promise<void>) => cases.push({ id, test });
  const reserve = (timeoutMs: number) => {
    const id = native.reserve(timeoutMs);
    assert(typeof id === 'string' && id.length > 0, 'slot', 'no-slot');
    return id;
  };
  const withSlot = async (timeoutMs: number, test: (id: string) => Promise<void>) => {
    const id = reserve(timeoutMs);
    try {
      await test(id);
    } finally {
      native.cancel(id);
    }
  };
  const execute = (id: string, path: string, limit = 100) =>
    native.execute(id, origin() + prefix + path, 'GET', {}, null, limit);
  const timing = (id: string, earliest: number, latest = earliest) => {
    if (ios) report(`TIMING ${id} ${earliest} ${latest}`);
  };

  scenario(ios ? 'identity-json' : 'json', async () => {
    const started = Date.now();
    const json = await request('/json');
    assert(JSON.stringify(json) === '{"message":"Bonjour 🐰 — 日本語 — العربية"}');
    timing('clock', started, Date.now());
  });
  scenario('post-body', async () => {
    await request('/request-body', {
      method: 'POST',
      body: { message: 'fixture 🐰' },
      bearerToken: 'fixture-only',
    });
  });
  scenario('delete-204', async () => {
    assert(
      (await request('/no-content', { method: 'DELETE', expectedStatuses: [204] })) === undefined,
    );
  });
  scenario('invalid-utf8', () => expectFailure(request('/invalid-utf8'), 'response'));
  const limit = 1_048_576;
  const rejectedNativeResponse = (path: string, expected = 'response') =>
    withSlot(4000, async (id) => {
      expectNativeFailure(await execute(id, path, limit), expected);
    });

  const verifySize = async (path: string) => {
    await rejectedNativeResponse(path, 'size');
    // Both slots must be available after this particular size rejection.
    await withSlot(4000, () => withSlot(4000, async () => {}));
  };

  if (ios) {
    // Safety of the experiment is checked separately from standard HTTP compatibility.
    scenario('standard-json', () => rejectedNativeResponse('/coding-absent'));
    scenario('forced-gzip-json', () => rejectedNativeResponse('/coding-gzip'));
    scenario('gzip-exact', () => rejectedNativeResponse('/gzip-exact'));
    scenario('identity-exact', async () => {
      assert(JSON.stringify(await request('/identity-exact')).length === limit);
    });
    scenario('identity-oversize', () => expectFailure(request('/identity-oversize'), 'size'));
    scenario('identity-oversize-native', () => verifySize('/identity-oversize'));
    scenario('identity-oversize-length', () =>
      rejectedNativeResponse('/identity-oversize-length', 'size'),
    );
    scenario('identity-oversize-length-recovery', () =>
      withSlot(4000, () => withSlot(4000, async () => {})),
    );
    scenario('identity-oversize-error', () => verifySize('/identity-oversize-error'));
    for (const path of ['chunked-coding-absent', 'chunked-coding-gzip']) {
      scenario(path, () => rejectedNativeResponse('/' + path));
    }
    scenario('chunked-complete', async () => {
      assert(
        JSON.stringify(await request('/chunked-complete')) ===
          '{"message":"Bonjour 🐰 — 日本語 — العربية"}',
      );
    });
    scenario('chunked-incomplete-end', () => rejectedNativeResponse('/chunked-incomplete-end'));
  } else {
    scenario('gzip-exact', async () => {
      assert(JSON.stringify(await request('/gzip-exact')).length === limit);
    });
  }
  scenario('oversize-app', () => expectFailure(request('/oversize'), ios ? 'response' : 'size'));
  scenario('oversize-native', () => rejectedNativeResponse('/oversize', ios ? 'response' : 'size'));
  for (const path of ['truncated', 'length', 'gzip-truncated', 'unframed']) {
    scenario(`framing-${path}`, () =>
      ios ? rejectedNativeResponse('/' + path) : expectFailure(request('/' + path), 'response'),
    );
  }
  if (ios) {
    for (const path of [
      'gzip-bad-crc',
      'gzip-truncated-stream',
      'coding-other',
      'coding-stacked',
    ]) {
      scenario(`framing-${path}`, () => rejectedNativeResponse('/' + path));
    }
    scenario('multipart', () =>
      withSlot(4000, async (id) => {
        expectNativeFailure(await execute(id, '/multipart', 1024), 'response');
      }),
    );
    scenario('expired-before-execute', () =>
      withSlot(250, async (id) => {
        await delay(350);
        expectNativeFailure(await execute(id, '/expired-before-execute'), 'network', 'timeout');
      }),
    );
  }
  scenario('tls-origin-a', async () => {
    await request('/destination');
  });
  scenario('tls-origin-b', async () => {
    await request('/destination', {}, fixturePort + 1);
  });
  if (Platform.OS === 'android') {
    scenario('tls-http-control', async () => {
      assert((await fetch(`http://${host}:${fixturePort + 2}/destination`)).ok);
    });
  }
  scenario('tls-unknown-ca', () => expectFailure(request('/json', {}, fixturePort + 3), 'network'));
  scenario('tls-wrong-host', () => expectFailure(request('/json', {}, fixturePort + 4), 'network'));
  for (const method of ['GET', 'POST', 'DELETE'] as const)
    for (const status of [301, 302, 303, 307, 308])
      for (const target of ['same', 'host', 'http'])
        scenario(`redirect-${method.toLowerCase()}-${status}-${target}`, () =>
          expectFailure(
            request(`/redirect/${status}/${target}`, {
              method,
              bearerToken: 'fixture-only',
              ...(method === 'POST' ? { body: {} } : {}),
            }),
            'redirect',
          ),
        );

  const runId = '00000000-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0');
  const cookiePath = `/cookies/${runId}/`;
  const ambient = (step: string) =>
    fetch(origin() + prefix + cookiePath + step, { credentials: 'include' });
  for (const step of [
    'seed',
    'expo-probe',
    'native-probe',
    'native-set',
    'native-probe-again',
    'expo-after',
  ]) {
    scenario(`cookies-${step}`, async () => {
      if (step.startsWith('native-'))
        await request(cookiePath + (step === 'native-probe-again' ? 'native-probe' : step));
      else assert((await ambient(step)).ok, 'success', 'http-error');
    });
  }
  scenario('auth-challenge', () =>
    expectFailure(
      request('/challenge'),
      Platform.OS === 'ios' ? 'network' : 'status',
      Platform.OS === 'ios' ? undefined : 401,
    ),
  );
  for (const method of ['GET', 'POST', 'DELETE'] as const) {
    scenario(`retry-status-${method.toLowerCase()}`, () =>
      expectFailure(request('/retry-status', { method }), 'status', 503),
    );
    scenario(`retry-drop-${method.toLowerCase()}`, () =>
      expectFailure(request('/drop-before-headers', { method }), 'network'),
    );
  }
  if (ios) {
    scenario('retry-status-gzip', () => rejectedNativeResponse('/retry-status-gzip'));
    scenario('retry-status-length-get', () =>
      expectFailure(request('/retry-status-length'), 'status', 503),
    );
  }

  const cancel = async (id: string, path: string, port: number, waitMs: number) => {
    const controller = new AbortController();
    if (waitMs === 0) controller.abort();
    const observed = request(path, { signal: controller.signal }, port).then(
      () => 'success',
      outcome,
    );
    if (waitMs > 0) {
      await delay(waitMs);
      const abortAt = Date.now();
      controller.abort();
      timing(id, abortAt);
    }
    const result = await observed;
    assert(result === 'cancelled', 'cancelled', result);
  };
  scenario('cancel-before-start', () =>
    cancel('cancel-before-start', '/cancel-before-start', fixturePort, 0),
  );
  scenario('cancel-before-execute', () =>
    withSlot(4000, async (id) => {
      native.cancel(id);
      expectNativeFailure(await execute(id, '/cancel-before-execute'), 'network');
    }),
  );
  scenario('cancel-during-tls', () =>
    cancel('cancel-during-tls', '/cancel-during-tls', fixturePort + 6, 400),
  );
  scenario('cancel-during-body', () =>
    cancel('cancel-during-body', '/slow/cancel', fixturePort, 400),
  );
  if (ios) {
    scenario('cancel-during-length-body', () =>
      cancel('cancel-during-length-body', '/slow/cancel-length', fixturePort, 400),
    );
  }
  scenario('native-deadline', async () => {
    const budget = 800;
    const beforeReserve = Date.now();
    await withSlot(budget, async (id) => {
      timing('native-deadline', beforeReserve + budget, Date.now() + budget);
      expectNativeFailure(await execute(id, '/slow/timeout'), 'timeout');
    });
  });
  scenario('expired-slots-recover', () =>
    withSlot(250, () =>
      withSlot(250, async () => {
        const extra = native.reserve(250);
        if (typeof extra === 'string') native.cancel(extra);
        assert(extra == null, 'no-slot', 'slot');
        await delay(350);
        await withSlot(4000, async () => {});
      }),
    ),
  );
  scenario('invalid-native-request', () =>
    withSlot(4000, () =>
      withSlot(4000, async (id) => {
        expectNativeFailure(
          await native.execute(
            id,
            origin() + prefix + '/invalid-native-request',
            'POST',
            { Cookie: 'fixture-rejected' },
            '{}',
            100,
          ),
          'network',
        );
        await withSlot(4000, async () => {});
      }),
    ),
  );
  let concurrentOutcomes: string[] = [];
  scenario('capacity-overflow', async () => {
    const controller = new AbortController();
    const pending = ['/slow/concurrency-one', '/slow/concurrency-two'].map((path) =>
      request(path, { signal: controller.signal }).then(() => 'success', outcome),
    );
    try {
      const started = performance.now();
      await expectFailure(request('/refused-over-capacity'), 'network');
      if (ios) assert(performance.now() - started <= 250, 'immediate-refusal', 'late-refusal');
    } finally {
      await delay(1600);
      const abortAt = Date.now();
      controller.abort();
      timing('capacity-cancel-one', abortAt);
      timing('capacity-cancel-two', abortAt);
      concurrentOutcomes = await Promise.all(pending);
    }
  });
  for (const [index, name] of ['one', 'two'].entries()) {
    scenario(`capacity-cancel-${name}`, async () => {
      const observed = concurrentOutcomes[index] ?? 'not-observed';
      assert(observed === 'cancelled', 'cancelled', observed);
    });
  }
  if (ios) {
    scenario('capacity-slots-recovered', async () => {
      await delay(200);
      await withSlot(4000, () => withSlot(4000, async () => {}));
    });
  }
  scenario('capacity-recovery', async () => {
    if (!ios) await delay(200);
    // Settle both requests to keep the last scenario's evidence complete.
    const recovered = await Promise.all(
      ['/reuse/one', '/reuse/two'].map((path) => request(path).then(() => 'success', outcome)),
    );
    assert(
      recovered.every((result) => result === 'success'),
      'success-both',
      recovered.join('-and-'),
    );
  });

  report(`PLAN ${cases.length}`);
  let passed = 0;
  let failed = 0;
  for (const { id, test } of cases) {
    currentScenario = id;
    invocation = 0;
    report(`START ${id}`);
    try {
      await test();
      passed++;
      report(`PASS ${id}`);
    } catch (error) {
      failed++;
      const details =
        error instanceof ScenarioFailure
          ? `expected-${error.expected} observed-${error.observed}`
          : `expected-scenario-success observed-${outcome(error)}`;
      report(`FAIL ${id} ${details}`);
    }
  }
  report(`DONE ${passed} passed, ${failed} failed`);
}

function Qualification() {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    const report = (line: string) => {
      console.log(`[BunnyHttpsQualification] ${line}`);
      setLines((previous) => [...previous, line]);
    };
    void qualify(report).catch(() => report('FAIL qualification unavailable'));
  }, []);
  return (
    <ScrollView contentContainerStyle={{ padding: 24 }}>
      <Text>HTTPS · {enabled ? 'Qualification locale' : 'Indisponible'}</Text>
      {lines.map((line) => (
        <Text key={line}>{line}</Text>
      ))}
    </ScrollView>
  );
}

registerRootComponent(Qualification);
