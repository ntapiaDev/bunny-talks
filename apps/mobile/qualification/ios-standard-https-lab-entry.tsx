import { registerRootComponent, requireNativeModule } from 'expo';
import { useEffect, useRef } from 'react';
import { Platform, Settings, Text } from 'react-native';
import type { ApplicationHttpsModule } from '../src/infrastructure/http/native-https-transport';
import type { Scenario } from './ios-standard-https-lab-plan';
import { isPhase, labPath, marker, origin, phases, session } from './ios-standard-https-lab-plan';
import {
  firstBearer,
  limit,
  message,
  port,
  postBody,
  secondBearer,
} from './standard-json-scenarios';

const report = (line: string) => console.log(marker + line);

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('fixture assertion');
}

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object');
  return value as Record<string, unknown>;
}

function expectFailure(value: unknown, ...kinds: string[]) {
  const result = record(value);
  assert(
    Object.keys(result).sort().join(',') === 'kind,ok' &&
      result.ok === false &&
      typeof result.kind === 'string' &&
      kinds.includes(result.kind),
  );
}

function expectStatus(value: unknown, status: number) {
  const result = record(value);
  assert(
    Object.keys(result).sort().join(',') === 'bytes,contentType,ok,status' &&
      result.ok === true &&
      result.status === status,
  );
  const bytes = result.bytes instanceof ArrayBuffer ? new Uint8Array(result.bytes) : result.bytes;
  assert(bytes instanceof Uint8Array);
  return bytes;
}

function expectJson(value: unknown, status = 200, expected = JSON.stringify({ message })) {
  const bytes = expectStatus(value, status);
  const encoded = encodeURIComponent(expected).replace(/%([0-9A-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  assert(bytes.length === encoded.length);
  assert(bytes.every((byte, index) => byte === encoded.charCodeAt(index)));
}

function ambientCookie(seed: boolean) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', origin + labPath('ambient'));
    request.withCredentials = true;
    request.timeout = 4500;
    if (seed) request.setRequestHeader('Authorization', 'Bearer ' + firstBearer);
    request.onload = () => {
      if (request.status === 200) resolve();
      else reject(new Error('fixture response'));
    };
    request.onerror = request.ontimeout = () => reject(new Error('fixture unavailable'));
    request.send();
  });
}

async function qualify() {
  assert(Platform.OS === 'ios' && !__DEV__ && !!Reflect.get(globalThis, 'HermesInternal'));
  const phase: unknown = Settings.get('BunnyHttpsLabPhase');
  assert(isPhase(phase));
  const native = requireNativeModule<ApplicationHttpsModule>('ApplicationHttps');

  function start(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    bearer?: string,
    address = origin,
  ) {
    const id = native.reserve(4500);
    assert(id !== null);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    const pending = native
      .execute(
        id,
        address + path,
        method,
        headers,
        method === 'POST' ? JSON.stringify(postBody) : null,
        limit,
      )
      .finally(() => native.cancel(id));
    return { id, pending };
  }

  const tlsFailure = async () => expectFailure(await start('GET', session).pending, 'network');
  const redirect = async (name: string) =>
    expectFailure(await start('POST', labPath(name), firstBearer).pending, 'redirect');

  const cases: Record<Scenario, () => Promise<void>> = {
    'tls-untrusted': tlsFailure,
    'tls-wrong-name': tlsFailure,
    'origin-refused': async () =>
      expectFailure(
        await start('GET', session, firstBearer, 'https://localhost:' + (port + 1)).pending,
        'network',
      ),
    'get-path-refused': async () =>
      expectFailure(await start('GET', labPath('messages')).pending, 'network'),
    'delete-path-refused': async () =>
      expectFailure(await start('DELETE', labPath('messages'), firstBearer).pending, 'network'),
    get: async () => expectJson(await start('GET', session).pending),
    post: async () => expectJson(await start('POST', labPath('messages')).pending),
    delete: async () =>
      assert(expectStatus(await start('DELETE', session, firstBearer).pending, 204).length === 0),
    'redirect-same': () => redirect('redirect-same'),
    'redirect-other': () => redirect('redirect-other'),
    'redirect-http': () => redirect('redirect-http'),
    identity: async () => {
      await ambientCookie(true);
      await ambientCookie(false);
      for (const [bearer, identity] of [
        [firstBearer, 'first'],
        [secondBearer, 'second'],
        [undefined, 'anonymous'],
      ] as const) {
        expectJson(
          await start('POST', labPath('identity'), bearer).pending,
          200,
          JSON.stringify({ message, identity }),
        );
      }
    },
    'auth-challenge': async () => {
      const value = await start('POST', labPath('challenge')).pending;
      if (record(value).ok === true) expectJson(value, 401, '{}');
      else expectFailure(value, 'network', 'response');
    },
    'post-loss': async () =>
      expectFailure(await start('POST', labPath('lost-post')).pending, 'network'),
    'delete-loss': async () =>
      expectFailure(await start('DELETE', session, firstBearer).pending, 'network'),
    'cancel-retried-get': async () => {
      const { id, pending } = start('GET', session, firstBearer);
      let cancelled = false;
      const timer = setTimeout(() => {
        cancelled = true;
        report('STOP ' + Date.now());
        native.cancel(id);
      }, 900);
      try {
        const value = await pending;
        // A terminal failure before the timer can mean Foundation did not retry.
        expectFailure(value, 'network');
        if (!cancelled) report('EARLY');
      } finally {
        clearTimeout(timer);
      }
    },
  };

  report('READY standard-json-known-length-' + phase);
  for (const id of phases[phase]) {
    report('START ' + id);
    try {
      await cases[id]();
      report('PASS ' + id + ' success');
    } catch {
      report('FAIL ' + id);
    }
  }
  report('DONE');
}

function Laboratory() {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void qualify().catch(() => report('UNAVAILABLE'));
  }, []);
  return <Text>Bunny Talks HTTPS Lab</Text>;
}

registerRootComponent(Laboratory);
