import { registerRootComponent, requireNativeModule } from 'expo';
import { useEffect, useRef, useState } from 'react';
import { Platform, Text } from 'react-native';
import {
  ApplicationHttpError,
  createApplicationHttpClient,
} from '../src/infrastructure/http/application-http';
import type { ApplicationHttpsModule } from '../src/infrastructure/http/native-https-transport';
import { createNativeHttpsTransport } from '../src/infrastructure/http/native-https-transport';
import type { Destination, Probe, ProbeDiagnostic } from './ios-libcurl-scenarios';
import {
  diagnosticProbe,
  fixtureByteValues,
  fixturePort,
  fixturePost,
  fixtureText,
  incompletePost,
  interruptions,
  invalidUtf8ByteValues,
  limit,
  memoryCases,
  plan,
  prefix,
  probeDiagnosticCodes,
  probes,
  runtimeProfile,
  transportFailures,
} from './ios-libcurl-scenarios';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const probeTimeoutMs = 6000;
const ports: Record<Destination, number> = {
  A: fixturePort,
  B: fixturePort + 1,
  C: fixturePort + 2,
  unknown: fixturePort + 3,
  wrong: fixturePort + 4,
  'stalled-tls': fixturePort + 6,
};
const origin = (destination: Destination = 'A') => 'https://localhost:' + ports[destination];

function requireEvidence(condition: unknown): asserts condition {
  if (!condition) throw new Error('qualification assertion');
}

function checkBytes(bytes: Uint8Array, outcome: Probe['outcome']) {
  if (outcome === 'empty') {
    requireEvidence(bytes.length === 0);
    return;
  }
  if (outcome === 'json' || outcome === 'invalid-utf8') {
    const expected = outcome === 'json' ? fixtureByteValues : invalidUtf8ByteValues;
    requireEvidence(
      bytes.length === expected.length && bytes.every((value, index) => value === expected[index]),
    );
    return;
  }
  // The exact response is an ASCII JSON object with limit - 11 data bytes.
  const head = '{"data":"';
  requireEvidence(
    outcome === 'exact' &&
      bytes.length === limit &&
      bytes.every((value, index) => {
        if (index < head.length) return value === head.charCodeAt(index);
        if (index === limit - 2) return value === 34;
        return value === (index === limit - 1 ? 125 : 120);
      }),
  );
}

function failure(value: unknown, kind: string) {
  requireEvidence(
    value !== null &&
      typeof value === 'object' &&
      'ok' in value &&
      value.ok === false &&
      'kind' in value &&
      value.kind === kind &&
      !('bytes' in value) &&
      !('body' in value),
  );
}

async function qualify(report: (line: string) => void) {
  const native = requireNativeModule<ApplicationHttpsModule & { qualificationProfile(): string }>(
    'ApplicationHttps',
  );
  const hermes: unknown = Reflect.get(globalThis, 'HermesInternal');
  requireEvidence(
    Platform.OS === 'ios' &&
      __DEV__ === false &&
      hermes !== null &&
      typeof hermes === 'object' &&
      native.qualificationProfile() === runtimeProfile,
  );
  report('READY ApplicationHttps Release Hermes ' + runtimeProfile);

  const slots = (budget: number) => {
    const ids: string[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const id = native.reserve(budget);
        requireEvidence(typeof id === 'string' && id !== '' && !ids.includes(id));
        ids.push(id);
      }
      const before = performance.now();
      const third = native.reserve(budget);
      if (third !== null) native.cancel(third);
      requireEvidence(third === null && performance.now() - before <= 100);
      return ids;
    } catch (error) {
      ids.forEach((id) => native.cancel(id));
      throw error;
    }
  };
  const bothAvailable = () => slots(4000).forEach((id) => native.cancel(id));
  const reserve = (budget: number) => {
    const id = native.reserve(budget);
    requireEvidence(typeof id === 'string' && id !== '');
    return id;
  };
  const execute = (id: string, route: string, destination?: Destination) =>
    native.execute(id, origin(destination) + prefix + route, 'GET', {}, null, limit);

  async function runProbe(test: Probe, diagnostic?: ProbeDiagnostic) {
    let nativeResults = 0;
    let bridgeValidated = false;
    let adapterValidated = false;
    const transport = createNativeHttpsTransport(() => ({
      reserve: (timeout) => native.reserve(timeout),
      cancel: (id) => native.cancel(id),
      execute: async (...args) => {
        let result: unknown;
        try {
          result = await native.execute(...args);
        } catch (error) {
          if (diagnostic) diagnostic.native = 'bridge-rejected';
          throw error;
        }
        nativeResults++;
        if (diagnostic) {
          diagnostic.native = 'unexpected';
          if (result !== null && typeof result === 'object') {
            if ('qualificationCompletion' in result) {
              const completion = result.qualificationCompletion;
              diagnostic.completion =
                probeDiagnosticCodes.completion.find((code) => code === completion) ?? 'unexpected';
            }
            if ('ok' in result && result.ok === true) diagnostic.native = 'success';
            else if ('ok' in result && result.ok === false) {
              const kind = 'kind' in result ? result.kind : undefined;
              diagnostic.native =
                'bytes' in result || 'body' in result
                  ? 'partial-body'
                  : (transportFailures.find((code) => code === kind) ?? 'unexpected');
            }
          }
          // Let the real adapter observe a well-formed failure, including a wrong category.
          bridgeValidated =
            diagnostic.native === test.outcome && diagnostic.completion !== 'unexpected';
          requireEvidence(
            diagnostic.native !== 'success' &&
              diagnostic.native !== 'partial-body' &&
              diagnostic.native !== 'unexpected',
          );
          return result;
        }
        const expectedStatuses: Partial<Record<Probe['outcome'], number>> = {
          json: 200,
          exact: 200,
          empty: 204,
          'invalid-utf8': 200,
          status: test.id === 'auth-challenge' ? 401 : 503,
        };
        const expected = expectedStatuses[test.outcome];
        if (expected === undefined) failure(result, test.outcome);
        else {
          requireEvidence(
            result !== null &&
              typeof result === 'object' &&
              'ok' in result &&
              result.ok === true &&
              'status' in result &&
              result.status === expected &&
              'bytes' in result,
          );
          const bytes =
            result.bytes instanceof ArrayBuffer ? new Uint8Array(result.bytes) : result.bytes;
          requireEvidence(bytes instanceof Uint8Array);
          if (test.outcome === 'status')
            requireEvidence(bytes.length === 2 && bytes[0] === 123 && bytes[1] === 125);
          else checkBytes(bytes, test.outcome);
        }
        bridgeValidated = true;
        return result;
      },
    }));
    // Assertion errors in the observed bridge result must survive the adapter's error mapping.
    const client = createApplicationHttpClient({
      origin: origin(test.destination),
      transport: async (request) => {
        const result = await transport(request);
        if (diagnostic) {
          diagnostic.adapter = result.ok
            ? 'success'
            : 'body' in result || 'bytes' in result
              ? 'partial-body'
              : result.kind;
        }
        if (test.outcome === 'invalid-utf8') requireEvidence(result.ok && result.status === 200);
        if (result.ok && ['json', 'exact', 'empty', 'invalid-utf8'].includes(test.outcome))
          checkBytes(result.body, test.outcome);
        if (!result.ok) requireEvidence(!('body' in result) && !('bytes' in result));
        adapterValidated = true;
        return result;
      },
      timeoutMs: probeTimeoutMs,
      maxResponseBytes: limit,
    });
    const expectedFailure =
      ['network', 'response', 'size', 'redirect', 'status'].includes(test.outcome) ||
      test.outcome === 'invalid-utf8';
    const expectedKind = test.outcome === 'invalid-utf8' ? 'response' : test.outcome;
    const request = client.request({
      path: prefix + test.id,
      method: test.method,
      expectedStatuses: [test.outcome === 'empty' ? 204 : 200],
      ...(test.method === 'POST'
        ? {
            body:
              test.id === 'cut-post-before' ? incompletePost : (JSON.parse(fixturePost) as unknown),
          }
        : {}),
      ...(test.bearer ? { bearerToken: 'fixture-only' } : {}),
    });
    const value = await request.then(
      (answer) => {
        if (diagnostic) {
          diagnostic.client = 'success';
          diagnostic.assertion = 'client';
        }
        requireEvidence(!expectedFailure);
        return answer;
      },
      (error: unknown) => {
        if (diagnostic) {
          diagnostic.client =
            error instanceof ApplicationHttpError
              ? (probeDiagnosticCodes.client.find((code) => code === error.kind) ?? 'unexpected')
              : 'unexpected';
          diagnostic.assertion = !bridgeValidated
            ? 'bridge'
            : !adapterValidated
              ? 'adapter'
              : 'client';
        }
        requireEvidence(
          expectedFailure &&
            error instanceof ApplicationHttpError &&
            error.kind === expectedKind &&
            (error.kind !== 'status' ||
              error.status === (test.id === 'auth-challenge' ? 401 : 503)),
        );
        return undefined;
      },
    );
    if (diagnostic) diagnostic.assertion = 'probe-evidence';
    requireEvidence(nativeResults === 1 && bridgeValidated && adapterValidated);
    if (test.outcome === 'json') requireEvidence(JSON.stringify(value) === fixtureText);
    if (test.outcome === 'exact') requireEvidence(JSON.stringify(value).length === limit);
    if (test.outcome === 'empty') requireEvidence(value === undefined);
    if (diagnostic) diagnostic.assertion = 'slots';
    bothAvailable();
    if (diagnostic) diagnostic.assertion = 'none';
  }

  async function runDiagnosticProbe(test: Probe) {
    const diagnostic: ProbeDiagnostic = {
      native: 'not-observed',
      completion: 'unavailable',
      adapter: 'not-observed',
      client: 'not-observed',
      assertion: 'probe-evidence',
    };
    try {
      await runProbe(test, diagnostic);
    } finally {
      const { native, completion, adapter, client, assertion } = diagnostic;
      report(`DIAG ${test.id} ${native} ${completion} ${adapter} ${client} ${assertion}`);
    }
  }

  async function runCookieFetch(test: Probe): Promise<'NOT_RUN' | void> {
    // Expo selects the React Native XMLHttpRequest-backed fetch when bundling this profile.
    if (process.env.EXPO_PUBLIC_USE_RN_FETCH !== '1') return 'NOT_RUN';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
    try {
      const response = await fetch(origin(test.destination) + prefix + test.id, {
        credentials: 'include',
        signal: controller.signal,
      });
      if (!response.ok || JSON.stringify(await response.json()) !== fixtureText) return 'NOT_RUN';
    } catch {
      return 'NOT_RUN';
    } finally {
      clearTimeout(timer);
    }
  }

  async function interrupt(test: (typeof interruptions)[number]) {
    if (test.id === 'client-abort') {
      await abortClient(test.id, test.budgetMs);
      return;
    }
    const isDeadline = test.id === 'deadline';
    const budget = isDeadline ? test.budgetMs : 6000;
    const reservedAt = performance.now();
    const expectedDeadline = Date.now() + budget;
    const ids = slots(budget);
    const readyAt = performance.now();
    const paths = test.id === 'capacity' ? [test.id, 'capacity-two'] : [test.id];
    let settlements = 0;
    try {
      const pending = paths.map((path, index) =>
        execute(ids[index]!, path, test.destination).then(
          (value) => {
            settlements++;
            return value;
          },
          () => {
            settlements++;
            return null;
          },
        ),
      );
      if (isDeadline) report('STOP ' + test.id + ' ' + expectedDeadline);
      else {
        await delay(test.budgetMs);
        requireEvidence(settlements === 0);
        if (test.id === 'capacity') {
          const client = createApplicationHttpClient({
            origin: origin(),
            maxResponseBytes: limit,
            timeoutMs: budget,
            transport: createNativeHttpsTransport(() => native),
          });
          const before = performance.now();
          const refused = await client
            .request({
              path: prefix + 'capacity-refused',
              method: 'GET',
              expectedStatuses: [200],
            })
            .then(
              () => false,
              (error: unknown) => error instanceof ApplicationHttpError && error.kind === 'network',
            );
          requireEvidence(refused && performance.now() - before <= 150);
        }
        report('STOP ' + test.id + ' ' + Date.now());
        ids.forEach((id) => native.cancel(id));
      }
      const results = await Promise.all(pending);
      requireEvidence(settlements === paths.length);
      results.forEach((result) => failure(result, isDeadline ? 'timeout' : 'network'));
      if (isDeadline) {
        const now = performance.now();
        requireEvidence(now - reservedAt >= budget - 5 && now - readyAt <= budget + 500);
      }
    } finally {
      ids.forEach((id) => native.cancel(id));
    }
    await recover(test.id);
    requireEvidence(settlements === paths.length);
  }

  async function recover(id: string) {
    // Results can settle before the worker releases its place. Poll both together.
    const recoveryDeadline = performance.now() + 1000;
    for (;;) {
      try {
        bothAvailable();
        report('SLOTS ' + id + ' ' + Date.now());
        break;
      } catch {
        if (performance.now() >= recoveryDeadline) throw new Error('capacity not recovered');
        await delay(20);
      }
    }
    await delay(150);
  }

  async function abortClient(id: string, waitMs: number) {
    const controller = new AbortController();
    let raw: Promise<unknown> | undefined;
    let nativeSettlements = 0;
    let clientSettlements = 0;
    const transport = createNativeHttpsTransport(() => ({
      reserve: (timeout) => native.reserve(timeout),
      cancel: (slot) => native.cancel(slot),
      execute: (...args) => {
        raw = native.execute(...args).then(
          (value) => {
            nativeSettlements++;
            return value;
          },
          () => null,
        );
        return raw;
      },
    }));
    const client = createApplicationHttpClient({
      origin: origin(),
      timeoutMs: 6000,
      maxResponseBytes: limit,
      transport,
    });
    const pending = client
      .request({
        method: 'GET',
        path: prefix + id,
        expectedStatuses: [200],
        signal: controller.signal,
      })
      .then(
        () => {
          clientSettlements++;
          return false;
        },
        (error: unknown) => {
          clientSettlements++;
          return error instanceof ApplicationHttpError && error.kind === 'cancelled';
        },
      );
    try {
      await delay(waitMs);
      requireEvidence(raw !== undefined && nativeSettlements + clientSettlements === 0);
      report('STOP ' + id + ' ' + Date.now());
      controller.abort();
      requireEvidence(await pending);
      failure(await raw, 'network');
    } finally {
      controller.abort();
    }
    await recover(id);
    requireEvidence(nativeSettlements === 1 && clientSettlements === 1);
  }

  async function memory(id: (typeof memoryCases)[number]) {
    const phase = (name: string) => report('MEM ' + id + ' ' + name + ' ' + Date.now());
    phase('baseline');
    await delay(1300);
    phase('active');
    let retained: unknown[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const routes =
        id === 'memory-zero' ? [] : id === 'memory-one' ? [id] : [id, 'memory-two-peer'];
      const pending = routes.map(async (route) => {
        const slot = reserve(5000);
        try {
          const result = await execute(slot, route);
          requireEvidence(
            result !== null &&
              typeof result === 'object' &&
              'ok' in result &&
              result.ok === true &&
              'bytes' in result,
          );
          const bytes =
            result.bytes instanceof ArrayBuffer ? new Uint8Array(result.bytes) : result.bytes;
          requireEvidence(bytes instanceof Uint8Array);
          checkBytes(bytes, 'exact');
          return bytes;
        } finally {
          native.cancel(slot);
        }
      });
      retained = await Promise.all(pending);
      bothAvailable();
      // The producer has completed. Keep the bridge results reachable across samples.
      if (cycle === 2) phase('retained');
      await delay(1300);
      requireEvidence(retained.length === routes.length);
      retained = [];
      if (cycle === 2) phase('released');
      await delay(1300);
    }
    requireEvidence(retained.length === 0);
    phase('end');
  }

  const scenarios = new Map<string, () => void | Promise<'NOT_RUN' | void>>();
  for (const probe of probes)
    scenarios.set(probe.id, () =>
      probe.id === diagnosticProbe
        ? runDiagnosticProbe(probe)
        : probe.cookie?.client === 'fetch'
          ? runCookieFetch(probe)
          : runProbe(probe),
    );
  for (const test of interruptions) scenarios.set(test.id, () => interrupt(test));
  for (const id of memoryCases) scenarios.set(id, () => memory(id));
  scenarios.set('cancel-before', async () => {
    const id = reserve(4000);
    native.cancel(id);
    failure(await execute(id, 'cancel-before'), 'network');
    bothAvailable();
  });
  scenarios.set('expired-before', async () => {
    const ids = slots(250);
    await delay(450);
    failure(await execute(ids[0]!, 'expired-before'), 'network');
    bothAvailable();
  });
  scenarios.set('invalid-request', async () => {
    const id = reserve(4000);
    try {
      failure(
        await native.execute(
          id,
          origin() + prefix + 'invalid-request',
          'POST',
          { Cookie: 'fixture-only' },
          '{}',
          limit,
        ),
        'network',
      );
      bothAvailable();
    } finally {
      native.cancel(id);
    }
  });

  for (const id of plan) {
    report('BEGIN ' + id + ' ' + Date.now());
    try {
      const result = await scenarios.get(id)!();
      report('END ' + id + ' ' + Date.now() + ' ' + (result ?? 'PASS'));
    } catch {
      report('END ' + id + ' ' + Date.now() + ' FAIL');
    }
  }
  report('DONE');
}

function Qualification() {
  const started = useRef(false);
  const [status, setStatus] = useState('Qualification HTTPS');
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const report = (line: string) => {
      console.log('[BunnyIosCurlRuntime] ' + line);
      setStatus(line);
    };
    void qualify(report).catch(() => report('FAIL setup'));
  }, []);
  return <Text>{status}</Text>;
}

registerRootComponent(Qualification);
