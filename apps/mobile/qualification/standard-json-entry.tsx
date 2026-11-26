import { registerRootComponent, requireNativeModule } from 'expo';
import { useEffect } from 'react';
import { Platform, Text } from 'react-native';
import {
  ApplicationHttpError,
  createApplicationHttpClient,
} from '../src/infrastructure/http/application-http';
import type { ApplicationHttpsModule } from '../src/infrastructure/http/native-https-transport';
import { createNativeHttpsTransport } from '../src/infrastructure/http/native-https-transport';
import type { CallDiagnostic } from './standard-json-diagnostics';
import { describeNativeResult, httpFailure, httpStatus } from './standard-json-diagnostics';
import {
  firstBearer,
  limit,
  marker,
  message,
  port,
  postBody,
  prefix,
  probes,
  requestTimeoutMs,
  retryFramingFaults,
  secondBearer,
} from './standard-json-scenarios';

const report = (line: string) => console.log(marker + line);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const offsets = { A: 0, B: 1, unknown: 3, wrong: 4 };

class QualificationAssertion extends Error {}

function assert(condition: unknown): asserts condition {
  if (!condition) throw new QualificationAssertion();
}

function expectJson(value: unknown) {
  assert(value && typeof value === 'object' && 'message' in value && value.message === message);
}

async function qualify() {
  const profile =
    Platform.OS === 'ios'
      ? 'standard-json-known-length-urlsession'
      : Platform.OS === 'android'
        ? 'standard-json-known-length-okhttp'
        : null;
  assert(profile && 'HermesInternal' in globalThis);
  const native = requireNativeModule<ApplicationHttpsModule & { qualificationProfile?(): string }>(
    'ApplicationHttps',
  );
  assert(native.qualificationProfile?.() === profile);
  const host = Platform.OS === 'ios' ? 'localhost' : '10.0.2.2';
  report('READY ' + profile);
  const calls: CallDiagnostic[] = [];
  let retryWindow: { openedAtMs: number; settledAtMs?: number } | undefined;

  function call(
    path: string,
    {
      destination = 'A',
      method = 'GET',
      bearer,
      timeoutMs = requestTimeoutMs,
      signal,
      status = 200,
      observeRetry = false,
    }: {
      destination?: keyof typeof offsets;
      method?: 'GET' | 'POST' | 'DELETE';
      bearer?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      status?: number;
      observeRetry?: boolean;
    } = {},
  ) {
    let raw: unknown;
    let execution: Promise<unknown> | undefined;
    const diagnostic: CallDiagnostic = { reservation: 'not-called', native: 'not-called' };
    calls.push(diagnostic);
    const transport = createNativeHttpsTransport(() => ({
      reserve(timeout) {
        diagnostic.reservation = 'threw';
        const id = native.reserve(timeout);
        diagnostic.reservation = id == null ? 'refused' : 'accepted';
        return id;
      },
      cancel: (id) => native.cancel(id),
      async execute(...args) {
        diagnostic.native = 'pending';
        try {
          execution = native.execute(...args);
          raw = await execution;
          Object.assign(diagnostic, describeNativeResult(raw));
        } catch (error) {
          diagnostic.native = 'threw';
          throw error;
        }
        return raw;
      },
    }));
    const client = createApplicationHttpClient({
      origin: `https://${host}:${port + offsets[destination]}`,
      maxResponseBytes: limit,
      timeoutMs,
      async transport(request) {
        const result = await transport(request);
        diagnostic.adapter = result.ok ? 'success' : result.kind;
        return result;
      },
    });
    const timing = observeRetry ? { openedAtMs: Date.now(), settledAtMs: 0 } : undefined;
    retryWindow = timing;
    const pending = client
      .request({
        method,
        path: prefix + path,
        ...(method === 'POST' ? { body: postBody } : {}),
        ...(bearer === undefined ? {} : { bearerToken: bearer }),
        ...(signal === undefined ? {} : { signal }),
        expectedStatuses: [status],
      })
      .catch((error: unknown) => {
        if (timing) timing.settledAtMs = Date.now();
        diagnostic.application =
          error instanceof ApplicationHttpError ? httpFailure(error.kind) : 'unexpected';
        if (error instanceof ApplicationHttpError && httpStatus(error.status) !== undefined)
          diagnostic.status = httpStatus(error.status);
        throw error;
      });
    return {
      pending: timing
        ? pending.then((value) => {
            timing.settledAtMs = Date.now();
            return value;
          })
        : pending,
      nativeRejected: () =>
        !!raw && typeof raw === 'object' && 'ok' in raw && raw.ok === false && !('bytes' in raw),
      async observeTerminal() {
        if (observeRetry && diagnostic.native === 'pending' && execution) {
          // A JS timeout can precede the acknowledgement of native cancellation.
          await Promise.race([execution.catch(() => undefined), wait(250)]);
        }
      },
    };
  }

  async function expectRejection(
    operation: ReturnType<typeof call>,
    kinds: readonly string[],
    checkNative = true,
  ) {
    const error = await operation.pending.catch((reason: unknown) => reason);
    assert(error instanceof ApplicationHttpError && kinds.includes(error.kind));
    if (checkNative) assert(operation.nativeRejected());
  }

  const scenarios = probes.map((probe) => ({
    id: probe.id,
    async run() {
      const { pending, nativeRejected, observeTerminal } = call(probe.path, {
        ...(probe.destination ? { destination: probe.destination } : {}),
        ...(probe.method ? { method: probe.method } : {}),
        ...(probe.bearer ? { bearer: probe.bearer } : {}),
        ...(probe.result === 'timeout' ? { timeoutMs: 900 } : {}),
        ...(probe.result === 'empty' ? { status: 204 } : {}),
        observeRetry:
          Platform.OS === 'ios' &&
          (probe.result === 'lost-get' || retryFramingFaults.has(probe.path)),
      });
      let result: unknown;
      try {
        result = await pending;
      } catch (error) {
        assert(error instanceof ApplicationHttpError);
        const kind = error.kind;
        if (probe.result === 'status-503' && kind === 'status' && error.status === 503)
          return 'status-503';
        if (probe.result === 'lost-get' && kind === 'timeout') {
          await observeTerminal();
          return kind;
        }
        if (probe.result === 'auth' && kind === 'status' && error.status === 401)
          return 'status-401';
        if (probe.result === 'auth') {
          assert(nativeRejected() && (kind === 'network' || kind === 'response'));
          return kind;
        }
        if (probe.result === 'reject' || probe.result === 'lost-get')
          assert(nativeRejected() && (kind === 'response' || kind === 'network'));
        else assert(kind === probe.result && (kind === 'timeout' || nativeRejected()));
        return kind;
      }
      switch (probe.result) {
        case 'json':
        case 'lost-get':
          expectJson(result);
          break;
        case 'empty':
          assert(result === undefined);
          break;
        case 'exact':
          assert(
            result &&
              typeof result === 'object' &&
              'data' in result &&
              typeof result.data === 'string' &&
              result.data.length === limit - 11 &&
              /^x+$/.test(result.data),
          );
          break;
        default:
          assert(false);
      }
      return 'success';
    },
  }));

  scenarios.push(
    {
      id: 'reuse',
      async run() {
        expectJson(await call('/reuse/one').pending);
        expectJson(await call('/reuse/two').pending);
        return 'success';
      },
    },
    {
      id: 'identity-isolation',
      async run() {
        const identities = [
          { bearer: firstBearer, expected: 'first' },
          { bearer: secondBearer, expected: 'second' },
          { expected: 'anonymous' },
        ];
        for (const { bearer, expected } of identities) {
          const value = await call('/identity', bearer === undefined ? {} : { bearer }).pending;
          assert(
            value &&
              typeof value === 'object' &&
              'identity' in value &&
              value.identity === expected,
          );
        }
        return 'success';
      },
    },
    {
      id: 'cancel-neighbour',
      async run() {
        const controller = new AbortController();
        const cancelled = call('/slow/concurrency-one', { signal: controller.signal }).pending;
        const neighbour = call('/slow/neighbour').pending;
        const third = call('/third-reservation').pending;
        const timer = setTimeout(() => controller.abort(), 450);
        try {
          const [first, second, refused] = await Promise.allSettled([cancelled, neighbour, third]);
          assert(
            first.status === 'rejected' &&
              first.reason instanceof ApplicationHttpError &&
              first.reason.kind === 'cancelled',
          );
          assert(
            refused.status === 'rejected' &&
              refused.reason instanceof ApplicationHttpError &&
              refused.reason.kind === 'network',
          );
          assert(second.status === 'fulfilled');
          expectJson(second.value);
          // Allow the fixture to observe the cancellation before the final report.
          await wait(100);
          return 'success';
        } finally {
          clearTimeout(timer);
        }
      },
    },
    {
      id: 'session-delete',
      async run() {
        const bearer = firstBearer;
        assert(
          (await call('/session-delete', { method: 'DELETE', bearer, status: 204 }).pending) ===
            undefined,
        );
        const lost = call('/session-delete-loss', { method: 'DELETE', bearer });
        await expectRejection(lost, ['network', 'response']);
        const check = await call('/session-delete-loss', { bearer }).pending.catch(
          (error: unknown) => error,
        );
        assert(
          check instanceof ApplicationHttpError && check.kind === 'status' && check.status === 401,
        );
        return 'success';
      },
    },
    {
      id: 'framing-recovery',
      async run() {
        await expectRejection(call('/recover-bad-length'), ['network', 'response']);
        expectJson(await call('/recover-json').pending);
        return 'success';
      },
    },
  );

  if (Platform.OS === 'ios') {
    scenarios.push({
      id: 'cancel-retried-get',
      async run() {
        const controller = new AbortController();
        const operation = call('/loss-get-cancel', {
          bearer: firstBearer,
          signal: controller.signal,
          observeRetry: true,
        });
        const timer = setTimeout(() => controller.abort(), 900);
        try {
          await expectRejection(operation, ['cancelled'], false);
          await operation.observeTerminal();
          assert(operation.nativeRejected());
          await wait(100);
          return 'success';
        } finally {
          clearTimeout(timer);
        }
      },
    });
  }

  for (const { id, run } of scenarios) {
    calls.length = 0;
    retryWindow = undefined;
    report('START ' + id);
    try {
      const result = await run();
      report(`PASS ${id} ${result} ${JSON.stringify({ calls, retryWindow })}`);
    } catch (error) {
      const failure =
        error instanceof QualificationAssertion
          ? 'assertion'
          : error instanceof ApplicationHttpError
            ? httpFailure(error.kind)
            : 'unexpected';
      report(`FAIL ${id} ${JSON.stringify({ failure, calls, retryWindow })}`);
    }
  }
  report('DONE');
}

let started = false;
function Qualification() {
  useEffect(() => {
    if (started) return;
    started = true;
    void qualify().catch(() => report('UNAVAILABLE'));
  }, []);
  return <Text>HTTPS qualification</Text>;
}

registerRootComponent(Qualification);
