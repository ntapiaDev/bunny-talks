import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

import { startFixture } from '../../apps/mobile/qualification/server.ts';

const exec = promisify(execFile);
const certificates = fileURLToPath(
  new URL('../../apps/mobile/qualification/certificates.sh', import.meta.url),
);
const primePath = '/retry-status-length';
const dropPath = '/drop-before-headers';
const curlCode = { ok: 0, abortedByCallback: 42, peerFailedVerification: 60 };
const tlsErrorCodes = new Set([35, 58, 59, 60, 77]);

export function fixturePort(value = '19443') {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65529 ? port : null;
}

function evidenceFields(source, integerFields, booleanFields) {
  const evidence = {};
  for (const name of integerFields) {
    if (!Number.isSafeInteger(source?.[name])) throw new Error('Missing native integer');
    evidence[name] = source[name];
  }
  for (const name of booleanFields) {
    if (typeof source?.[name] !== 'boolean') throw new Error('Missing native boolean');
    evidence[name] = source[name];
  }
  return evidence;
}

export function parseNative(stdout, mode, expectedBackend) {
  const { libcurl, tlsBackend, ...transfers } = JSON.parse(stdout);
  if (
    libcurl !== '8.23.0' ||
    typeof tlsBackend !== 'string' ||
    !/^OpenSSL\/\d+\.\d+\.\d+$/.test(tlsBackend) ||
    (expectedBackend && tlsBackend !== expectedBackend)
  ) {
    throw new Error('Unexpected libcurl or TLS backend');
  }
  const native = { libcurl, tlsBackend };
  const labels = mode === 'tls-control' ? ['unknownCa', 'wrongName'] : ['prime', 'drop'];
  for (const label of labels) {
    const transfer = transfers[label];
    const summary = evidenceFields(
      transfer,
      [
        'code',
        'status',
        'connectionId',
        'newConnections',
        'contentLength',
        'verifyResult',
        'earlyDataBytes',
        'bodyBytes',
        'prereqCalls',
      ],
      ['http11', 'expectedBody', 'retryAfterZero'],
    );
    if (
      summary.code < 0 ||
      summary.bodyBytes < 0 ||
      summary.prereqCalls < 0 ||
      !Array.isArray(transfer.attempts) ||
      transfer.attempts.length !== Math.min(summary.prereqCalls, 2)
    ) {
      throw new Error('Incomplete native attempts');
    }
    summary.attempts = transfer.attempts.map((attempt) =>
      evidenceFields(attempt, ['connectionId', 'newConnections'], ['allowed']),
    );
    native[label] = summary;
  }
  return native;
}

function readEvents(port) {
  return new Promise((resolve, reject) => {
    const req = get(
      { host: '127.0.0.1', port: port + 5, path: '/events', agent: false },
      async (response) => {
        try {
          if (response.statusCode !== 200) throw new Error('Fixture control unavailable');
          response.setEncoding('utf8');
          let body = '';
          for await (const chunk of response) body += chunk;
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      },
    );
    req.setTimeout(2000, () => req.destroy(new Error('Fixture control timeout')));
    req.on('error', reject);
  });
}

function summarizeEvents(events) {
  return events.map((event) => ({
    route: event.path === primePath ? 'prime' : event.path === dropPath ? 'drop' : 'unexpected',
    target: event.destination === 'A' ? 'primary' : 'unexpected',
    connectionId: event.connectionId,
    http11: event.httpVersion === '1.1',
    get: event.method === 'GET',
    ambientCredentials: event.authorization !== false || event.cookie !== false,
    ...evidenceFields(event, [], ['headersSent', 'finished', 'closed']),
  }));
}

export function classify(native, received, guardEnabled) {
  const { prime, drop } = native;
  const priming = received.filter((event) => event.route === 'prime');
  const drops = received.filter((event) => event.route === 'drop');
  if (priming.length > 1) return ['FAIL', '503-reemitted'];
  if (guardEnabled && drops.length > 1) return ['FAIL', 'guard-bypassed'];
  if (drop.code === curlCode.ok && drops.length > 0) return ['FAIL', 'drop-reported-as-success'];
  if ([prime, drop].some((item) => item.verifyResult !== 0 || tlsErrorCodes.has(item.code))) {
    return ['NOT_RUN', 'tls-connection-unconfirmed'];
  }

  if (
    received.some(
      (event) =>
        event.route === 'unexpected' ||
        event.target !== 'primary' ||
        !event.get ||
        !event.http11 ||
        !Number.isInteger(event.connectionId) ||
        event.ambientCredentials,
    )
  ) {
    return ['NOT_RUN', 'unexpected-server-events'];
  }
  const [primeRequest] = priming;
  if (
    received[0] !== primeRequest ||
    !primeRequest?.finished ||
    !primeRequest.headersSent ||
    prime.code !== curlCode.ok ||
    prime.status !== 503 ||
    !prime.http11 ||
    !prime.retryAfterZero ||
    prime.contentLength !== 2 ||
    prime.bodyBytes !== 2 ||
    !prime.expectedBody ||
    prime.earlyDataBytes !== 0 ||
    prime.prereqCalls !== 1 ||
    prime.newConnections !== 1 ||
    prime.connectionId < 0 ||
    prime.attempts[0]?.connectionId !== prime.connectionId ||
    prime.attempts[0]?.newConnections !== 1 ||
    !prime.attempts[0]?.allowed
  ) {
    return ['NOT_RUN', 'priming-unconfirmed'];
  }

  const [first, second] = drop.attempts;
  if (
    !drops[0] ||
    drops[0].connectionId !== primeRequest.connectionId ||
    first?.connectionId !== prime.connectionId ||
    first?.newConnections !== 0 ||
    !first?.allowed
  ) {
    return ['NOT_RUN', 'connection-reuse-unconfirmed'];
  }
  if (
    drops.some((event) => event.headersSent || event.finished || !event.closed) ||
    drop.status !== 0 ||
    drop.earlyDataBytes !== 0
  ) {
    return ['NOT_RUN', 'drop-evidence-incomplete'];
  }
  if (drop.bodyBytes > 0) return ['FAIL', 'drop-delivered-body'];
  if (!guardEnabled && drops.length < 2) return ['NOT_RUN', 'witness-did-not-reemit'];
  if (
    drop.prereqCalls !== 2 ||
    drop.newConnections !== 1 ||
    second?.newConnections !== 1 ||
    second?.connectionId !== drop.connectionId ||
    second?.connectionId === first.connectionId ||
    second?.connectionId < 0
  ) {
    return ['NOT_RUN', 'retry-connection-unconfirmed'];
  }
  if (guardEnabled) {
    if (second.allowed) return ['FAIL', 'guard-did-not-refuse-retry'];
    if (drop.code !== curlCode.abortedByCallback) {
      return ['NOT_RUN', 'guard-abort-unconfirmed'];
    }
    return ['PASS', 'second-attempt-aborted-before-http'];
  }
  if (!second.allowed || drops.length !== 2 || drops[1].connectionId === drops[0].connectionId) {
    return ['NOT_RUN', 'witness-retry-correlation-incomplete'];
  }
  return ['PASS', 'second-reception-on-new-connection'];
}

export async function runExperiment(runNative, port, expectedBackend) {
  const report = { verdict: 'NOT_RUN' };
  let work;
  let fixture;
  let stage = 'temporary-directory';
  try {
    work = await mkdtemp(
      join(process.env.BUNNY_LIBCURL_TMPDIR || '/tmp', 'bunny-libcurl-fixture.'),
    );
    stage = 'certificate-generation';
    await exec('bash', [certificates, work + '/certs'], { timeout: 15_000 });
    stage = 'fixture-startup';
    fixture = await startFixture(work + '/certs', port, '127.0.0.1', false, true);
    const initial = await readEvents(port);
    if (!Array.isArray(initial) || initial.length !== 0) throw new Error('Fixture is not isolated');

    let observed = 0;
    async function run(mode) {
      stage = mode + '-native-launch';
      const stdout = await runNative(mode, port, work + '/certs/ca.pem');
      stage = mode + '-native-report';
      const native = parseNative(stdout, mode, expectedBackend);
      stage = mode + '-fixture-events';
      const events = await readEvents(port);
      if (!Array.isArray(events) || events.length < observed || events.length >= 4096) {
        throw new Error('Incomplete fixture events');
      }
      const received = summarizeEvents(events.slice(observed));
      observed = events.length;
      return { native, received };
    }

    stage = 'tls-control';
    const tls = (report.tls = await run(stage));
    const rejected = [tls.native.unknownCa, tls.native.wrongName].every(
      (transfer) =>
        transfer.code === curlCode.peerFailedVerification &&
        transfer.prereqCalls === 0 &&
        transfer.earlyDataBytes === 0 &&
        transfer.status === 0 &&
        transfer.bodyBytes === 0,
    );
    tls.verdict = tls.received.length > 0 ? 'FAIL' : rejected ? 'PASS' : 'NOT_RUN';
    if (tls.verdict !== 'PASS') {
      report.verdict = tls.verdict;
      report.reason = 'tls-rejection-unconfirmed';
    } else {
      stage = 'witness';
      const witness = (report.witness = await run(stage));
      [witness.verdict, witness.reason] = classify(witness.native, witness.received, false);
      report.verdict = witness.verdict;
      report.reason = witness.reason;
      if (witness.verdict === 'PASS') {
        stage = 'candidate';
        const candidate = (report.candidate = await run(stage));
        [candidate.verdict, candidate.reason] = classify(
          candidate.native,
          candidate.received,
          true,
        );
        report.verdict = candidate.verdict;
        report.reason = candidate.reason;
      }
    }
  } catch {
    report.verdict = 'NOT_RUN';
    report.reason = stage + '-unavailable';
  } finally {
    await fixture?.close();
    if (work) await rm(work, { recursive: true, force: true });
  }
  return report;
}

export function printReport(report) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.verdict === 'PASS' ? 0 : report.verdict === 'FAIL' ? 1 : 2;
}

if (import.meta.main) {
  const [, , binaryArg, portArg] = process.argv;
  const port = fixturePort(portArg);
  if (!binaryArg || !port || process.argv.length > 4) {
    process.stderr.write('Usage: node run.mjs BINARY [BASE_PORT]\n');
    printReport({ verdict: 'NOT_RUN', reason: 'invalid-arguments' });
  } else {
    const runNative = async (mode, basePort, ca) => {
      const { stdout } = await exec(resolve(binaryArg), [mode, String(basePort), ca], {
        env: { LC_ALL: 'C' },
        timeout: 12_000,
      });
      return stdout;
    };
    printReport(await runExperiment(runNative, port));
  }
}
