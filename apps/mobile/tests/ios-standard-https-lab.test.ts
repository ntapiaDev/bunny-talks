import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Phase } from '../qualification/ios-standard-https-lab-plan';
import {
  labPath,
  marker,
  phases,
  routes,
  session,
} from '../qualification/ios-standard-https-lab-plan';
import { fixtureJson, startFixture } from '../qualification/server';
import { verifyLaboratory } from '../qualification/verify-ios-standard-https-lab';
import type { Snapshot } from '../qualification/verify-standard-json';

const epoch = 1_800_000_000_000;
const log = (phase: Phase, extra: string[] = []) =>
  [
    'READY standard-json-known-length-' + phase,
    ...phases[phase].flatMap((id) => ['START ' + id, ...extra, 'PASS ' + id + ' success']),
    'DONE',
  ]
    .map((line) => marker + line)
    .join('\n');

it('requires a closed ClientHello with the approved name and no HTTP for a TLS refusal', () => {
  const snapshot: Snapshot = { overflow: false, events: [], connections: [] };
  expect(verifyLaboratory('wrong-name', log('wrong-name'), snapshot).verdict).toBe('NOT_RUN');
  snapshot.connections.push({
    id: 1,
    destination: 'A',
    receivedBytes: true,
    fixtureName: true,
    closedAtMs: epoch,
    tls: null,
  });
  expect(verifyLaboratory('wrong-name', log('wrong-name'), snapshot).verdict).toBe('PASS');
  expect(verifyLaboratory('refusals', log('refusals'), snapshot).verdict).toBe('FAIL');
  snapshot.connections[0]!.tls = 'TLSv1.3';
  expect(verifyLaboratory('wrong-name', log('wrong-name'), snapshot).verdict).toBe('FAIL');
  snapshot.connections = [];
  expect(verifyLaboratory('refusals', log('refusals'), snapshot).verdict).toBe('PASS');
});

it('requires a distinct resumed reception closed after cancellation and detects mutation replay', () => {
  const get = {
    path: session,
    destination: 'A',
    method: 'GET',
    connectionId: 1,
    requestedCoding: 'identity',
    responseCoding: 'absent',
    configuredFraming: 'length',
    requestNoStore: true,
    authorization: true,
    authorizationMatchesFixture: true,
    cookie: false,
    contentTypeIsJson: false,
    postBodyMatchesFixture: false,
    requestComplete: true,
    processed: true,
    fixtureCut: true,
    fixtureCutAtMs: epoch + 100,
    iosPrimaryTarget: true,
    headersSent: false,
    responseStarted: false,
    responseStartedAtMs: null,
    startedAtMs: epoch,
    closed: true,
    closedAfterMs: 100,
    finished: false,
  };
  const retry = {
    ...get,
    connectionId: 2,
    startedAtMs: epoch + 200,
    headersSent: true,
    responseStarted: true,
    responseStartedAtMs: epoch + 300,
    closedAfterMs: 800,
    fixtureCut: false,
  };
  const post = {
    ...get,
    path: labPath('lost-post'),
    method: 'POST',
    contentTypeIsJson: true,
    postBodyMatchesFixture: true,
    authorization: false,
    authorizationMatchesFixture: false,
  };
  const deletion = { ...get, method: 'DELETE' };
  const snapshot: Snapshot = {
    overflow: false,
    events: [get, retry, post, deletion],
    connections: [1, 2].map((id) => ({
      id,
      destination: 'A',
      receivedBytes: true,
      tls: 'TLSv1.3',
    })),
  };
  const completed = log('loss').replace(
    marker + 'PASS cancel-retried-get',
    marker + 'STOP ' + (epoch + 900) + '\n' + marker + 'PASS cancel-retried-get',
  );
  expect(verifyLaboratory('loss', completed, snapshot).verdict).toBe('PASS');
  snapshot.events = [get, post, deletion];
  expect(verifyLaboratory('loss', completed, snapshot).verdict).toBe('NOT_RUN');
  snapshot.events = [get, retry, post, post, deletion];
  expect(verifyLaboratory('loss', completed, snapshot).verdict).toBe('FAIL');
  snapshot.events = [get, { ...retry, closedAfterMs: 200 }, post, deletion];
  expect(verifyLaboratory('loss', completed, snapshot).verdict).toBe('FAIL');
});

it('serves the real session path and a same-origin redirect, then presents the wrong SAN on that port', async () => {
  const directory = join(tmpdir(), 'bunny-https-lab-test-' + crypto.randomUUID());
  const port = 30443;
  let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
  try {
    execFileSync('bash', ['qualification/certificates.sh', directory], { stdio: 'pipe' });
    const ca = readFileSync(join(directory, 'ca.pem'));
    const start = (primaryCertificate: 'server' | 'wrong') =>
      startFixture(directory, port, '127.0.0.1', {
        primaryCertificate,
        routes: routes('nominal'),
      });
    const call = (path: string, method: string) =>
      new Promise<{ status: number | undefined; body: string; location: string | undefined }>(
        (resolve, reject) => {
          const req = request(
            {
              hostname: '127.0.0.1',
              servername: 'localhost',
              port,
              ca,
              method,
              path,
              headers: { Host: 'localhost:' + port },
            },
            (response) => {
              let body = '';
              response.setEncoding('utf8').on('data', (chunk: string) => {
                body += chunk;
              });
              response.on('end', () =>
                resolve({ status: response.statusCode, body, location: response.headers.location }),
              );
            },
          );
          req.on('error', reject).end();
        },
      );
    fixture = await start('server');
    expect(await call(session, 'GET')).toMatchObject({ status: 200, body: fixtureJson });
    expect(await call(labPath('redirect-same'), 'POST')).toMatchObject({
      status: 303,
      location: 'https://localhost:' + port + session,
    });
    await fixture.close();
    fixture = undefined;
    fixture = await start('wrong');
    await expect(call(session, 'GET')).rejects.toMatchObject({
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
  } finally {
    await fixture?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
