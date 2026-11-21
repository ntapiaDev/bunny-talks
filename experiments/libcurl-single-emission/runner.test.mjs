import { deepEqual, equal, throws } from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { waitForResult } from './run-apple.mjs';
import { classify, parseNative } from './run.mjs';

const attempt = (connectionId, newConnections, allowed = true) => ({
  connectionId,
  newConnections,
  allowed,
});
const native = (guard) => ({
  libcurl: '8.23.0',
  tlsBackend: 'OpenSSL/3.5.9',
  prime: {
    code: 0,
    status: 503,
    http11: true,
    connectionId: 0,
    newConnections: 1,
    contentLength: 2,
    verifyResult: 0,
    earlyDataBytes: 0,
    bodyBytes: 2,
    expectedBody: true,
    retryAfterZero: true,
    prereqCalls: 1,
    attempts: [attempt(0, 1)],
  },
  drop: {
    code: guard ? 42 : 56,
    status: 0,
    http11: false,
    connectionId: 1,
    newConnections: 1,
    contentLength: -1,
    verifyResult: 0,
    earlyDataBytes: 0,
    bodyBytes: 0,
    expectedBody: false,
    retryAfterZero: false,
    prereqCalls: 2,
    attempts: [attempt(0, 0), attempt(1, 1, !guard)],
  },
});

const request = (route, connectionId) => ({
  route,
  connectionId,
  target: 'primary',
  http11: true,
  get: true,
  ambientCredentials: false,
  headersSent: route === 'prime',
  finished: route === 'prime',
  closed: true,
});
const prime = request('prime', 3);
const first = request('drop', 3);
const second = request('drop', 4);

test('qualifies the witness and the candidate only with their respective server correlation', () => {
  equal(classify(native(false), [prime, first, second], false)[0], 'PASS');
  equal(classify(native(true), [prime, first], true)[0], 'PASS');
  deepEqual(classify(native(false), [prime, first], false), ['NOT_RUN', 'witness-did-not-reemit']);
  deepEqual(classify(native(true), [prime, second], true), [
    'NOT_RUN',
    'connection-reuse-unconfirmed',
  ]);
  deepEqual(classify(native(true), [prime, { ...first, closed: false }], true), [
    'NOT_RUN',
    'drop-evidence-incomplete',
  ]);
});

test('reports extra emissions and a false success as failures', () => {
  deepEqual(classify(native(true), [prime, first, second], true), ['FAIL', 'guard-bypassed']);
  deepEqual(classify(native(true), [prime, prime, first], true), ['FAIL', '503-reemitted']);
  const result = native(true);
  result.drop.attempts[1].allowed = true;
  deepEqual(classify(result, [prime, first], true), ['FAIL', 'guard-did-not-refuse-retry']);
  result.drop.code = 0;
  deepEqual(classify(result, [prime, first], true), ['FAIL', 'drop-reported-as-success']);
});

test('reports failure to establish TLS separately from replay evidence', () => {
  const result = native(true);
  result.prime.code = 60;
  result.prime.verifyResult = 20;
  deepEqual(classify(result, [], true), ['NOT_RUN', 'tls-connection-unconfirmed']);
});

test('requires a complete JSON result and the expected backend, and keeps only defined evidence', () => {
  const result = native(true);
  const output = JSON.stringify({ ...result, unused: 'discarded' });
  deepEqual(parseNative(output, 'candidate', 'OpenSSL/3.5.9'), result);
  throws(() => parseNative(output, 'candidate', 'OpenSSL/3.5.5'));
  throws(() => parseNative(output.slice(0, -1), 'candidate'));
  throws(() => parseNative(null, 'candidate'));
  delete result.drop.attempts[1].allowed;
  throws(() => parseNative(JSON.stringify(result), 'candidate'));
});

test('only accepts the result filename after atomic publication', async () => {
  const work = await mkdtemp('/tmp/bunny-libcurl-result-test.');
  try {
    const pending = join(work, 'trial.pending');
    const result = join(work, 'trial.json');
    await writeFile(pending, '{}');
    equal(await waitForResult(result, 0), null);
    await rename(pending, result);
    equal(await waitForResult(result, 100), '{}');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
