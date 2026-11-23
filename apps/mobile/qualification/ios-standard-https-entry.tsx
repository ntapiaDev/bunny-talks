import { registerRootComponent, requireNativeModule } from 'expo';
import { useEffect, useRef } from 'react';
import { Linking, Platform, Text } from 'react-native';
import {
  ApplicationHttpError,
  createApplicationHttpClient,
} from '../src/infrastructure/http/application-http';
import type { ApplicationHttpsModule } from '../src/infrastructure/http/native-https-transport';
import { createNativeHttpsTransport } from '../src/infrastructure/http/native-https-transport';
import type { Destination, Probe } from './ios-libcurl-scenarios';
import {
  fixturePort,
  fixturePost,
  fixtureText,
  incompletePost,
  interruptions,
  limit,
  prefix,
  standardHttpsBefore,
  standardHttpsMarker,
  standardHttpsPlan,
  standardHttpsProbes,
  standardHttpsReady,
} from './ios-libcurl-scenarios';

const ports: Record<Destination, number> = {
  A: fixturePort,
  B: fixturePort + 1,
  C: fixturePort + 2,
  unknown: fixturePort + 3,
  wrong: fixturePort + 4,
  'stalled-tls': fixturePort + 6,
};
const origin = (destination: Destination = 'A') => 'https://localhost:' + ports[destination];
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const report = (line: string) => console.log(standardHttpsMarker + line);

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('fixture assertion');
}

function failure(value: unknown, kind: string) {
  assert(
    value !== null &&
      typeof value === 'object' &&
      'ok' in value &&
      value.ok === false &&
      'kind' in value &&
      value.kind === kind &&
      !('body' in value) &&
      !('bytes' in value),
  );
}

async function expectError(result: Promise<unknown>, kind: string, status?: number) {
  const error: unknown = await result.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert(error instanceof ApplicationHttpError && error.kind === kind && error.status === status);
}

function cookieWitness(spec: Probe) {
  // Use the ordinary React Native cookie jar without build settings or changes to ATS.
  return new Promise<'NOT_RUN' | void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', origin(spec.destination) + prefix + spec.id);
    request.withCredentials = true;
    request.timeout = 6000;
    request.onload = () => {
      if (request.status === 200 && request.responseText === fixtureText) resolve();
      else reject(new Error('fixture response'));
    };
    request.onerror = request.ontimeout = () => resolve('NOT_RUN');
    request.send();
  });
}

async function qualify() {
  const launch = await Linking.getInitialURL();
  const scope = /^bunnytalks:\/\/c2-(before|after)\/([a-f0-9]{32})\/([a-f0-9]{32})$/.exec(
    launch ?? '',
  );
  assert(scope && scope[0] === launch);
  assert(Platform.OS === 'ios' && !__DEV__ && !!Reflect.get(globalThis, 'HermesInternal'));
  const native = requireNativeModule<ApplicationHttpsModule>('ApplicationHttps');
  const adapter = createNativeHttpsTransport(() => native);
  const client = (address = origin(), transport = adapter) =>
    createApplicationHttpClient({
      origin: address,
      timeoutMs: 6000,
      maxResponseBytes: limit,
      transport,
    });

  const reserve = (timeout: number) => {
    const id = native.reserve(timeout);
    assert(id !== null);
    return id;
  };

  const execute = (slot: string, id: string, address: string) =>
    native.execute(slot, address + prefix + id, 'GET', {}, null, limit);

  async function probe(spec: Probe) {
    if (spec.cookie?.client === 'fetch') return cookieWitness(spec);
    const status = spec.outcome === 'status' ? (spec.id === 'auth-challenge' ? 401 : 503) : 200;
    const accepted = spec.outcome === 'json' || spec.outcome === 'exact';
    let observed = false;
    const transport = createNativeHttpsTransport(() => ({
      reserve: (ms) => native.reserve(ms),
      cancel: (id) => native.cancel(id),
      execute: async (...args) => {
        const result = await native.execute(...args);
        assert(!observed);
        if (accepted || spec.outcome === 'status') {
          assert(
            result &&
              typeof result === 'object' &&
              'ok' in result &&
              result.ok === true &&
              'status' in result &&
              result.status === status &&
              'bytes' in result,
          );
          const bytes =
            result.bytes instanceof ArrayBuffer ? new Uint8Array(result.bytes) : result.bytes;
          assert(
            bytes instanceof Uint8Array && (spec.outcome !== 'exact' || bytes.length === limit),
          );
          if (spec.outcome === 'status')
            assert(bytes.length === 2 && bytes[0] === 123 && bytes[1] === 125);
        } else failure(result, spec.outcome);
        observed = true;
        return result;
      },
    }));
    const result = client(origin(spec.destination), transport).request({
      path: prefix + spec.id,
      method: spec.method,
      expectedStatuses: [200],
      ...(spec.method === 'POST'
        ? {
            body:
              spec.id === 'cut-post-before' ? incompletePost : (JSON.parse(fixturePost) as unknown),
          }
        : {}),
      ...(spec.bearer ? { bearerToken: 'fixture-only' } : {}),
    });
    if (accepted) {
      const body: unknown = await result;
      if (spec.outcome === 'exact')
        assert(
          body &&
            typeof body === 'object' &&
            'data' in body &&
            body.data === 'x'.repeat(limit - 11),
        );
      else assert(JSON.stringify(body) === fixtureText);
    } else await expectError(result, spec.outcome, spec.outcome === 'status' ? status : undefined);
    assert(observed);
  }

  async function interrupt(spec: (typeof interruptions)[number]) {
    const ids: string[] = [];
    const abort = new AbortController();
    const deadline = spec.id === 'deadline';
    const throughClient = spec.id === 'client-abort';
    const stop = Date.now() + spec.budgetMs;
    let adapterResult: Promise<void> | undefined;
    let observed: Promise<unknown> | undefined;
    try {
      if (throughClient) {
        const transport = createNativeHttpsTransport(() => ({
          reserve: (ms) => native.reserve(ms),
          cancel: (id) => native.cancel(id),
          execute: (...args) => {
            assert(observed === undefined);
            observed = native.execute(...args);
            return observed;
          },
        }));
        adapterResult = expectError(
          client(origin(), transport).request({
            path: prefix + spec.id,
            method: 'GET',
            expectedStatuses: [200],
            signal: abort.signal,
          }),
          'cancelled',
        );
        // Attach a handler before waiting so an early outcome is captured as an assertion.
        void adapterResult.catch(() => undefined);
      } else {
        ids.push(reserve(deadline ? spec.budgetMs : 6000));
        if (spec.id === 'capacity') ids.push(reserve(6000));
      }
      const pending = ids.map((id, i) =>
        execute(id, i === 0 ? spec.id : 'capacity-two', origin(spec.destination)),
      );
      // A rejected bridge promise is handled with the rest of the outcomes.
      const outcomes = Promise.all(pending);
      void outcomes.catch(() => undefined);
      if (!deadline) await wait(spec.budgetMs);
      if (spec.id === 'capacity') {
        const third = native.reserve(6000);
        if (third !== null) native.cancel(third);
        assert(third === null);
      }
      report('STOP ' + spec.id + ' ' + (deadline ? stop : Date.now()));
      if (!deadline) ids.forEach((id) => native.cancel(id));
      abort.abort();
      if (adapterResult) {
        await adapterResult;
        assert(observed !== undefined);
        failure(await observed, 'network');
      }
      (await outcomes).forEach((value) => failure(value, deadline ? 'timeout' : 'network'));
    } finally {
      abort.abort();
      ids.forEach((id) => native.cancel(id));
    }
    const until = performance.now() + 1000;
    while (performance.now() <= until) {
      const one = native.reserve(6000);
      const two = one === null ? null : native.reserve(6000);
      if (one !== null) native.cancel(one);
      if (two !== null) native.cancel(two);
      if (one !== null && two !== null) {
        report('SLOTS ' + spec.id + ' ' + Date.now());
        return;
      }
      await wait(20);
    }
    throw new Error('fixture slots unavailable');
  }

  const scenarios = new Map<string, () => Promise<'NOT_RUN' | void>>();
  for (const spec of standardHttpsProbes) scenarios.set(spec.id, () => probe(spec));
  for (const spec of interruptions) scenarios.set(spec.id, () => interrupt(spec));
  scenarios.set('expired-before', async () => {
    const id = reserve(250);
    try {
      await wait(450);
      failure(await execute(id, 'expired-before', origin()), 'network');
    } finally {
      native.cancel(id);
    }
  });
  scenarios.set('direct-http', async () => {
    const address = 'http://localhost:' + ports.C;
    try {
      client(address);
      throw new Error('fixture URL accepted');
    } catch (error) {
      assert(error instanceof ApplicationHttpError && error.kind === 'configuration');
    }
    const id = reserve(6000);
    try {
      failure(await execute(id, 'direct-http', address), 'network');
    } finally {
      native.cancel(id);
    }
  });

  console.log('[BunnyIosStandardHttpsRun] ' + scope[2] + ' ' + scope[3] + ' ' + scope[1]);
  report(standardHttpsReady);
  const before = scope[1] === 'before';
  for (const id of before ? [standardHttpsBefore.id] : standardHttpsPlan) {
    report('BEGIN ' + id + ' ' + Date.now());
    let verdict = 'PASS';
    try {
      if (before) await probe(standardHttpsBefore);
      else verdict = (await scenarios.get(id)!()) ?? 'PASS';
    } catch {
      verdict = 'FAIL';
    }
    report('END ' + id + ' ' + Date.now() + ' ' + verdict);
  }
  report('DONE');
}

function Candidate() {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void qualify().catch(() => report('FAIL setup'));
  }, []);
  return <Text>Qualification HTTPS iOS</Text>;
}

registerRootComponent(Candidate);
