import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { URL } from 'node:url';

import { classify } from '../../../../experiments/libcurl-single-emission/run.mjs';
import {
  fixtureByteValues,
  fixtureText,
  interruptions,
  memoryCases,
  memoryPhases,
  plan,
  prefix,
  probes,
  runtimeProfile,
  runtimeRoutes,
  standardHttpsBefore,
  standardHttpsMarker,
  standardHttpsPlan,
  standardHttpsProbes,
  standardHttpsReady,
} from '../ios-libcurl-scenarios.ts';
import {
  standardPhaseLog,
  summarizeRuntimeChecks,
  validateStage,
  validateStandardFixture,
} from '../run-ios-libcurl-runtime.mjs';
import {
  evaluateRuntime,
  evaluateStandardRuntime,
  readAppLog,
} from '../verify-ios-libcurl-runtime.mjs';

const tag = '[BunnyIosCurlRuntime] ';

test('C2 fixture readiness requires all actual loopback listeners and a fresh control snapshot', () => {
  const fixtureId = 'b'.repeat(32);
  const bindings = Array.from({ length: 7 }, (_, i) => ({ address: '127.0.0.1', port: 29443 + i }));
  const initial = { fixtureId, overflow: false, events: [], connections: [] };
  assert.deepEqual(validateStandardFixture(bindings, initial, fixtureId), bindings);
  assert.throws(() => validateStandardFixture(bindings.slice(0, 6), initial, fixtureId));
  assert.throws(() =>
    validateStandardFixture(
      [{ ...bindings[0], address: '0.0.0.0' }, ...bindings.slice(1)],
      initial,
      fixtureId,
    ),
  );
  assert.throws(() => validateStandardFixture(bindings, { ...initial, events: [{}] }, fixtureId));
  assert.throws(() => validateStandardFixture(bindings, initial, 'c'.repeat(32)));
});

test('C2 capture binds the log to its phase, actual PID and fresh run and fixture identities', () => {
  const runId = 'a'.repeat(32);
  const fixtureId = 'b'.repeat(32);
  const marker = '[BunnyIosStandardHttpsRun] ' + runId + ' ' + fixtureId + ' before';
  const raw = [marker, '[BunnyIosStandardHttps] DONE']
    .map((eventMessage) => JSON.stringify({ processID: 42, eventMessage, unrelated: 'private' }))
    .join('\n');
  const actual = standardPhaseLog(raw, 42, runId, fixtureId, 'before');
  assert.equal(actual, marker + '\n[BunnyIosStandardHttps] DONE\n');
  assert.throws(() => standardPhaseLog(raw, 43, runId, fixtureId, 'before'));
  assert.throws(() => standardPhaseLog(raw, 42, 'c'.repeat(32), fixtureId, 'before'));
  assert.throws(() => standardPhaseLog(raw, 42, runId, fixtureId, 'after'));
  assert.throws(() => standardPhaseLog(raw + '\n' + raw, 42, runId, fixtureId, 'before'));
});

test('requires correlated finite diagnostics for a newly qualified length conflict', () => {
  const { log, wire, samples } = complete();
  const options = { requireProbeDiagnostic: true };
  const diagnostic = 'response weird-reply-before-headers response response none';
  const withDiagnostic = (fields, id = 'length-conflict') =>
    log.replace(
      tag + 'END length-conflict ',
      tag + `DIAG ${id} ${fields}\n` + tag + 'END length-conflict ',
    );

  assert.equal(
    evaluateRuntime(log, wire, samples, options).checks['length-conflict'].verdict,
    'NOT_RUN',
  );
  const confirmed = evaluateRuntime(withDiagnostic(diagnostic), wire, samples, options);
  assert.equal(confirmed.checks['length-conflict'].verdict, 'PASS');
  const incomplete = evaluateRuntime(
    withDiagnostic('response not-completed response response none'),
    wire,
    samples,
    options,
  );
  assert.equal(incomplete.checks['length-conflict'].verdict, 'NOT_RUN');
  assert.equal(
    confirmed.checks['length-conflict'].diagnostic.completion,
    'weird-reply-before-headers',
  );
  for (const fields of [
    'network receive-error network network bridge',
    'success unavailable network network bridge',
    'partial-body write-error network network bridge',
    'response write-error partial-body response adapter',
    'response write-error response success client',
  ]) {
    assert.equal(
      evaluateRuntime(withDiagnostic(fields), wire, samples, options).checks['length-conflict']
        .verdict,
      'FAIL',
    );
  }
  for (const invalid of [
    withDiagnostic('bad-category weird-reply-before-headers response response none'),
    withDiagnostic(diagnostic, 'length-and-chunked'),
    withDiagnostic(diagnostic + '\n' + tag + 'DIAG length-conflict ' + diagnostic),
  ]) {
    const result = evaluateRuntime(invalid, wire, samples, options);
    assert.equal(result.checks.evidence.verdict, 'FAIL');
    assert.doesNotMatch(JSON.stringify(result), /bad-category/);
  }
  const failed = withDiagnostic('bridge-rejected unavailable network network bridge').replace(
    /(END length-conflict \d+) PASS/,
    '$1 FAIL',
  );
  const observed = evaluateRuntime(failed, wire, samples, options).checks['length-conflict'];
  assert.equal(observed.verdict, 'FAIL');
  assert.equal(observed.diagnostic.native, 'bridge-rejected');
});

test('attributes failed and unconfirmed runtime checks independently of orchestration', () => {
  const checks = { runtime: 'FAIL', link: 'NOT_RUN', guard: 'PASS', cleanup: 'PASS' };
  const summary = summarizeRuntimeChecks(checks);
  assert.equal(summary.verdict, 'FAIL');
  assert.equal(summary.automatedVerdict, 'FAIL');
  assert.equal(summary.reason, 'checks-failed');
  assert.deepEqual(summary.failedChecks, ['runtime']);
  assert.deepEqual(summary.unconfirmedChecks, ['link']);
  assert.equal(summary.interruptedStage, undefined);

  const interrupted = summarizeRuntimeChecks({ ...checks, runtime: 'NOT_RUN' }, 'application');
  assert.equal(interrupted.reason, 'checks-incomplete');
  assert.equal(interrupted.interruptedStage, 'application');
  assert.deepEqual(interrupted.unconfirmedChecks, ['runtime', 'link']);
  const allPassed = summarizeRuntimeChecks({
    runtime: 'PASS',
    link: 'PASS',
    guard: 'PASS',
    cleanup: 'PASS',
  });
  assert.equal(allPassed.automatedVerdict, 'PASS');
  assert.equal(allPassed.verdict, 'NOT_RUN');
  assert.equal(allPassed.reason, 'memory-attribution-required');
});

function complete(options = {}) {
  const wire = { overflow: false, events: [], connections: [] };
  const samples = [];
  const lines = [options.ready ?? 'READY ApplicationHttps Release Hermes ' + runtimeProfile];
  const epoch = options.epoch ?? 1_800_000_000_000;
  let fetchConnection;
  for (const [index, id] of (options.plan ?? plan).entries()) {
    const start = epoch + index * 10000;
    const end = start + 5000;
    const probe = (options.probes ?? probes).find((probe) => probe.id === id);
    const interrupt = interruptions.find((test) => test.id === id);
    const stop = start + (interrupt?.budgetMs ?? 0);
    function connection(destination, acceptedAtMs = start + 10) {
      const conn = {
        id: wire.connections.length + 1,
        destination,
        acceptedAtMs,
        closedAtMs: interrupt ? stop + 10 : acceptedAtMs + 190,
        receivedBytes: true,
        fixtureName: destination !== 'stalled-tls',
        tls: destination === 'stalled-tls' ? null : 'TLSv1.3',
      };
      wire.connections.push(conn);
      return conn;
    }
    function event(name, destination = 'A', acceptedAtMs = start + 10) {
      const fetch = probe?.cookie?.client === 'fetch';
      const conn = fetch
        ? (fetchConnection ??= connection(destination, acceptedAtMs))
        : connection(destination, acceptedAtMs);
      if (fetch) conn.closedAtMs = null;
      const bearer = probe?.bearer === true;
      const stalled = destination === 'stalled-tls';
      const ambient = probe?.cookie?.receives === 'ambient';
      const nominal = name === 'post-body';
      const row = {
        destination,
        connectionId: conn.id,
        method: stalled ? '' : (probe?.method ?? 'GET'),
        path: stalled ? '' : prefix + name,
        httpVersion: stalled ? undefined : '1.1',
        startedAtMs: acceptedAtMs,
        closedAfterMs: fetch ? 50 : conn.closedAtMs - conn.acceptedAtMs,
        configuredFraming: probe?.framing ?? 'length',
        responseCoding: probe?.coding ?? 'identity',
        requestedRuntimeCoding: !stalled && !fetch,
        authorization: bearer,
        authorizationMatchesFixture: bearer,
        cookie: ambient,
        expoFixtureCookie: ambient,
        nativeFixtureCookie: false,
        ambientFixtureCookieMatches: ambient,
        responseFixtureCookie: probe?.cookie?.sets,
        postBodyMatchesFixture: nominal || name === 'cut-post-after',
        requestComplete: nominal ? true : undefined,
        contentTypeIsJson: nominal,
        headersSent: !stalled,
        responseStarted: Boolean(interrupt && !stalled),
        responseStartedAtMs: interrupt && !stalled ? conn.acceptedAtMs + 10 : null,
        closed: true,
        finished: !interrupt,
        offeredLimitPlusOne: true,
        encodedBelowLimit: true,
        configuredOversizeLength: true,
      };
      wire.events.push(row);
      return row;
    }

    lines.push('BEGIN ' + id + ' ' + start);
    if (probe?.wire === 'reject') connection(probe.destination);
    else if (probe) {
      const row = event(id, probe.destination);
      row.finished = probe.wire === 'complete';
      row.fixtureCut = probe.wire === 'cut';
      if (id.startsWith('cut-')) {
        row.processed = row.headersSent = row.responseStarted = id.endsWith('-after');
        row.requestComplete = id !== 'cut-post-before';
        row.responseStartedAtMs = row.responseStarted ? row.startedAtMs + 10 : null;
      }
    } else if (interrupt) {
      event(id, interrupt.destination);
      if (id === 'capacity') event('capacity-two');
      lines.push('STOP ' + id + ' ' + stop);
      lines.push('SLOTS ' + id + ' ' + (stop + 30));
    } else if (memoryCases.includes(id)) {
      for (const [index, phase] of memoryPhases.entries()) {
        const at = start + 100 + index * 1000;
        lines.push('MEM ' + id + ' ' + phase + ' ' + at);
        if (phase !== 'end')
          samples.push({ atMs: at + 10, rssKiB: 10000 }, { atMs: at + 50, rssKiB: 10100 });
      }
      for (let cycle = 0; cycle < 3; cycle++) {
        if (id !== 'memory-zero') event(id, 'A', start + 1120 + cycle * 250);
        if (id === 'memory-two') event('memory-two-peer', 'A', start + 1125 + cycle * 250);
      }
    }
    lines.push('END ' + id + ' ' + end + ' PASS');
  }
  lines.push('DONE');
  const log = lines.map((line) => 'ignored prefix ' + (options.marker ?? tag) + line).join('\n');
  return { log, wire, samples, evaluate: () => evaluateRuntime(log, wire, samples) };
}

function standardProof(before = false) {
  return complete({
    plan: before ? [standardHttpsBefore.id] : standardHttpsPlan,
    probes: before ? [standardHttpsBefore] : standardHttpsProbes,
    marker: standardHttpsMarker,
    ready: standardHttpsReady,
    epoch: before ? 1_800_000_000_000 : 1_800_000_010_000,
  });
}

test('correlates the reduced standard plan before and after trust without publishing raw inputs', () => {
  const result = evaluateStandardRuntime(standardProof(true), standardProof());
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.beforeTrust.checks['identity-json'].reason, 'tls-handshake-without-http');
  assert.deepEqual(result.beforeTrust.counters, { requests: 0, connections: 1 });
  assert.equal(result.afterTrust.checks['cookie-fetch-after'].verdict, 'PASS');
  assert.equal(result.afterTrust.checks.capacity.verdict, 'PASS');
  assert.ok(standardHttpsPlan.length < plan.length / 2);
  assert.doesNotMatch(
    JSON.stringify(result),
    /ignored prefix|localhost|BunnyIosStandardHttps|\.pem/,
  );
});

test('leaves an absent TLS witness or partial standard plan unconfirmed and fails on extra emission', () => {
  const noCertificateExchange = standardProof(true);
  noCertificateExchange.wire.connections.length = 0;
  assert.equal(evaluateStandardRuntime(noCertificateExchange, standardProof()).verdict, 'NOT_RUN');
  const partial = standardProof();
  partial.log = partial.log.replace(/\n[^\n]*DONE$/, '');
  assert.equal(evaluateStandardRuntime(standardProof(true), partial).verdict, 'NOT_RUN');
  const repeated = standardProof();
  repeated.wire.events.push({ ...requestFor(repeated, 'cut-post-after') });
  assert.equal(evaluateStandardRuntime(standardProof(true), repeated).verdict, 'FAIL');
});

test('checks cumulative snapshots from the same server and detects a changed first phase', () => {
  const before = standardProof(true);
  const after = standardProof();
  after.wire.connections.forEach((row) => row.id++);
  after.wire.events.forEach((row) => row.connectionId++);
  after.wire.connections.unshift(...before.wire.connections.map((row) => ({ ...row })));
  assert.equal(evaluateStandardRuntime(before, after, { cumulative: true }).verdict, 'PASS');
  after.wire.connections[0].closedAtMs++;
  assert.equal(
    evaluateStandardRuntime(before, after, { cumulative: true }).reason,
    'fixture-snapshots-diverged',
  );
});

const requestFor = (proof, id) => proof.wire.events.find(({ path }) => path === prefix + id);
const connectionFor = (proof, destination) =>
  proof.wire.connections.find((row) => row.destination === destination);

test('uses an independent exact UTF-8 oracle and unique, fixed routes', () => {
  assert.deepEqual([...Buffer.from(fixtureText)], [...fixtureByteValues]);
  assert.equal(plan.length, new Set(plan).size);
  assert.ok(
    [...runtimeRoutes.keys()].every((path) =>
      /^\/v1\/https-qualification\/curl\/[a-z0-9-]+$/.test(path),
    ),
  );
});

test('accepts only the complete correlated plan and strips unrecognized fields', () => {
  const proof = complete();
  proof.wire.events[0].rawHeaders = { password: 'private-fixture-value' };
  proof.wire.connections[0].remoteAddress = 'private-fixture-value';
  const result = proof.evaluate();
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.checks));
  assert.doesNotMatch(
    JSON.stringify(result),
    /rawHeaders|remoteAddress|private-fixture-value|ignored prefix/,
  );
});

test('missing application, wire, stop or memory proof never produces PASS', () => {
  const { log, wire, samples } = complete();
  assert.equal(evaluateRuntime('', null, null).verdict, 'NOT_RUN');
  assert.equal(evaluateRuntime(log.replace(tag + 'DONE', ''), wire, samples).verdict, 'NOT_RUN');
  assert.equal(evaluateRuntime(log, null, samples).verdict, 'NOT_RUN');
  assert.equal(evaluateRuntime(log, wire, null).verdict, 'NOT_RUN');
  assert.equal(
    evaluateRuntime(log.replace(/.* (?:STOP|SLOTS) cancel-reading .+\n/g, ''), wire, samples)
      .checks['cancel-reading'].verdict,
    'NOT_RUN',
  );
});

test('refuses unknown scenario labels, corrupted times and out-of-order log records', () => {
  const { log, wire, samples } = complete();
  for (const invalid of [
    log.replace('BEGIN identity-json', 'BEGIN private-invalid-scenario'),
    log.replace(/END identity-json \d+/, 'END identity-json 180000000000'),
    log + '\n' + tag + 'DONE',
  ]) {
    const result = evaluateRuntime(invalid, wire, samples);
    assert.equal(result.verdict, 'FAIL');
    assert.doesNotMatch(JSON.stringify(result), /private-invalid-scenario/);
  }
});

test('reports an application failure even with complete wire evidence', () => {
  const { log, wire, samples } = complete();
  const result = evaluateRuntime(
    log.replace(/(END identity-json \d+) PASS/, '$1 FAIL'),
    wire,
    samples,
  );
  assert.equal(result.checks['identity-json'].verdict, 'FAIL');
  assert.equal(result.verdict, 'FAIL');
});

test('rejects replay, incorrect destinations, unexpected connections, and missing HTTP evidence', () => {
  const replay = complete();
  const cut = replay.wire.events.find(({ path }) => path === prefix + 'cut-post-after');
  replay.wire.events.push({ ...cut });
  assert.equal(replay.evaluate().checks['cut-post-after'].verdict, 'FAIL');

  const mismatched = complete();
  mismatched.wire.events[0].connectionId = mismatched.wire.events[1].connectionId;
  assert.equal(mismatched.evaluate().verdict, 'FAIL');

  const wrong = complete();
  wrong.wire.events[0].destination = 'B';
  assert.equal(wrong.evaluate().verdict, 'FAIL');

  const unexpected = complete();
  unexpected.wire.connections.push({ ...unexpected.wire.connections[0], id: 999 });
  assert.equal(unexpected.evaluate().checks.server.verdict, 'FAIL');

  const missing = complete();
  missing.wire.events.splice(0, 1);
  assert.equal(missing.evaluate().checks['identity-json'].verdict, 'FAIL');
});

test('accepts the nominal POST only with the exact body, headers and complete private exchange', () => {
  assert.equal(complete().evaluate().checks['post-body'].verdict, 'PASS');
  for (const [field, value] of [
    ['postBodyMatchesFixture', false],
    ['contentTypeIsJson', false],
    ['authorizationMatchesFixture', false],
    ['authorization', false],
    ['cookie', true],
    ['requestComplete', false],
    ['method', 'GET'],
    ['finished', false],
  ]) {
    const proof = complete();
    const request = requestFor(proof, 'post-body');
    request[field] = value;
    if (field === 'authorization') request.authorizationMatchesFixture = false;
    assert.equal(proof.evaluate().checks['post-body'].verdict, 'FAIL', field);
  }
  const extra = complete();
  extra.wire.events.push({ ...requestFor(extra, 'post-body') });
  assert.equal(extra.evaluate().checks['post-body'].verdict, 'FAIL');
});

test('retains one fetch connection for the full verified cookie sequence', () => {
  const proof = complete();
  const result = proof.evaluate();
  const fetchIds = probes.filter(({ cookie }) => cookie?.client === 'fetch').map(({ id }) => id);
  const nativeIds = probes.filter(({ cookie }) => cookie?.client === 'native').map(({ id }) => id);
  const fetchConnections = new Set(fetchIds.map((id) => requestFor(proof, id).connectionId));
  assert.equal(fetchConnections.size, 1);
  for (const id of [...fetchIds, ...nativeIds]) assert.equal(result.checks[id].verdict, 'PASS', id);
  assert.equal(
    new Set(nativeIds.map((id) => requestFor(proof, id).connectionId)).size,
    nativeIds.length,
  );
  assert.equal(result.checks.server.verdict, 'PASS');
});

test('a missing ambient witness or fetch request cannot pass cookie isolation', () => {
  const proof = complete();
  const witness = requestFor(proof, 'cookie-fetch-probe');
  for (const key of ['cookie', 'expoFixtureCookie', 'ambientFixtureCookieMatches'])
    witness[key] = false;
  const result = proof.evaluate();
  for (const id of ['cookie-fetch-probe', 'cookie-native-probe', 'cookie-fetch-after'])
    assert.equal(result.checks[id].verdict, 'NOT_RUN', id);
  assert.equal(result.verdict, 'NOT_RUN');

  const missing = complete();
  missing.wire.events.splice(
    missing.wire.events.indexOf(requestFor(missing, 'cookie-fetch-probe')),
    1,
  );
  const report = evaluateRuntime(
    missing.log.replace(/(END cookie-fetch-probe \d+) PASS/, '$1 NOT_RUN'),
    missing.wire,
    missing.samples,
  );
  assert.equal(report.checks['cookie-fetch-probe'].reason, 'fetch-request-unobserved');
  assert.equal(report.verdict, 'NOT_RUN');
});

test('refuses ambient leakage, native persistence, contaminated fetch and duplicate requests', () => {
  for (const [id, fields] of [
    [
      'cookie-native-probe',
      { cookie: true, expoFixtureCookie: true, ambientFixtureCookieMatches: true },
    ],
    ['cookie-native-probe-again', { cookie: true, nativeFixtureCookie: true }],
    ['cookie-fetch-after', { nativeFixtureCookie: true, ambientFixtureCookieMatches: false }],
    ['cookie-fetch-seed', { responseFixtureCookie: 'none' }],
  ]) {
    const proof = complete();
    Object.assign(requestFor(proof, id), fields);
    assert.equal(proof.evaluate().checks[id].verdict, 'FAIL', id);
  }
  const duplicate = complete();
  duplicate.wire.events.push({ ...requestFor(duplicate, 'cookie-fetch-probe') });
  assert.equal(duplicate.evaluate().checks['cookie-fetch-probe'].verdict, 'FAIL');
  const shared = complete();
  const native = requestFor(shared, 'cookie-native-probe');
  native.connectionId = requestFor(shared, 'cookie-fetch-probe').connectionId;
  assert.equal(shared.evaluate().checks['cookie-native-probe'].verdict, 'FAIL');
});

test('validates the complete fixture for all newly rejected responses', () => {
  for (const id of ['invalid-utf8', 'coding-other', 'coding-stacked']) {
    const proof = complete();
    assert.equal(proof.evaluate().checks[id].verdict, 'PASS', id);
    requestFor(proof, id).configuredFraming = 'unobserved';
    assert.equal(proof.evaluate().checks[id].verdict, 'FAIL', id);
  }
  const proof = complete();
  requestFor(proof, 'coding-stacked').responseCoding = 'gzip';
  assert.equal(proof.evaluate().checks['coding-stacked'].verdict, 'FAIL');
});

test('requires a correlated TLS handshake and closure for negative controls', () => {
  const untrustedControl = complete();
  requestFor(untrustedControl, 'tls-trusted-other-port').finished = false;
  assert.deepEqual(untrustedControl.evaluate().checks['tls-unknown-ca'], {
    verdict: 'NOT_RUN',
    reason: 'tls-trusted-control-unconfirmed',
  });
  for (const [id, destination] of [
    ['tls-unknown-ca', 'unknown'],
    ['tls-wrong-host', 'wrong'],
  ]) {
    assert.deepEqual(complete().evaluate().checks[id], {
      verdict: 'PASS',
      reason: 'tls-handshake-without-http',
    });
    const missing = complete();
    missing.wire.connections.splice(
      missing.wire.connections.indexOf(connectionFor(missing, destination)),
      1,
    );
    assert.equal(missing.evaluate().checks[id].verdict, 'NOT_RUN');
    for (const [fields, reason] of [
      [{ receivedBytes: false, fixtureName: false, tls: null }, 'tls-client-hello-unconfirmed'],
      [{ receivedBytes: undefined }, 'tls-client-hello-unconfirmed'],
      [{ tls: null }, 'tls-handshake-unconfirmed'],
      [{ tls: undefined }, 'tls-handshake-unconfirmed'],
      [{ closedAtMs: null }, 'tls-close-unconfirmed'],
    ]) {
      const incomplete = complete();
      Object.assign(connectionFor(incomplete, destination), fields);
      assert.deepEqual(incomplete.evaluate().checks[id], { verdict: 'NOT_RUN', reason });
      assert.equal(incomplete.evaluate().verdict, 'NOT_RUN');
    }
    const late = complete();
    connectionFor(late, destination).closedAtMs += 8000;
    assert.equal(late.evaluate().checks[id].verdict, 'FAIL');
    const contradictory = complete();
    connectionFor(contradictory, destination).receivedBytes = false;
    assert.deepEqual(contradictory.evaluate().checks[id], {
      verdict: 'FAIL',
      reason: 'contradictory-tls-evidence',
    });

    const { log, wire, samples } = complete();
    const bypass = log.replace(new RegExp('(END ' + id + ' \\d+) PASS'), '$1 FAIL');
    assert.equal(evaluateRuntime(bypass, wire, samples).checks[id].verdict, 'FAIL');

    const extra = complete();
    extra.wire.connections.push({ ...connectionFor(extra, destination), id: 999 });
    assert.equal(extra.evaluate().checks[id].verdict, 'FAIL');

    const http = complete();
    const conn = connectionFor(http, destination);
    http.wire.events.push({
      ...requestFor(http, 'identity-json'),
      path: prefix + id,
      connectionId: conn.id,
      destination,
      startedAtMs: conn.acceptedAtMs,
      closedAfterMs: conn.closedAtMs - conn.acceptedAtMs,
    });
    assert.deepEqual(http.evaluate().checks[id], {
      verdict: 'FAIL',
      reason: 'http-on-rejected-tls',
    });
  }
});

test('requires truncation proof, decoded limit probe, and peer closure after the stop', () => {
  for (const [id, field] of [
    ['chunked-incomplete', 'fixtureCut'],
    ['identity-oversize', 'offeredLimitPlusOne'],
  ]) {
    const proof = complete();
    proof.wire.events.find(({ path }) => path === prefix + id)[field] = false;
    assert.equal(proof.evaluate().checks[id].verdict, 'FAIL');
  }

  const interrupted = complete();
  const row = interrupted.wire.events.find(({ path }) => path === prefix + 'cancel-reading');
  row.closedAfterMs = 30;
  interrupted.wire.connections.find(({ id }) => id === row.connectionId).closedAtMs =
    row.startedAtMs + 30;
  assert.equal(interrupted.evaluate().checks['cancel-reading'].verdict, 'FAIL');
});

test('bounds cancel-reading closure and capacity independently without accepting invalid evidence', () => {
  function result({
    id = 'cancel-reading',
    slots = 30,
    close = 10,
    extra = false,
    finished = false,
    appFailed = false,
    unexpectedConnection = false,
    responseStartsAtStop = false,
  } = {}) {
    const { log, wire, samples } = complete();
    const row = wire.events.find(({ path }) => path === prefix + id);
    const conn = wire.connections.find(({ id }) => id === row.connectionId);
    const { stop } = readAppLog(log).intervals.get(id);
    let app = log.replace(
      new RegExp('SLOTS ' + id + ' \\d+'),
      'SLOTS ' + id + ' ' + (stop + slots),
    );
    if (appFailed) app = app.replace(new RegExp('(END ' + id + ' \\d+) PASS'), '$1 FAIL');
    conn.closedAtMs = close === null ? null : stop + close;
    row.closed = close !== null;
    row.closedAfterMs = close === null ? null : conn.closedAtMs - row.startedAtMs;
    row.finished = finished;
    if (responseStartsAtStop) row.responseStartedAtMs = stop;
    if (extra)
      wire.events.push({
        ...row,
        startedAtMs: stop + 1,
        responseStarted: false,
        responseStartedAtMs: null,
        closedAfterMs: conn.closedAtMs - stop - 1,
      });
    if (unexpectedConnection) wire.connections.push({ ...conn, id: wire.connections.length + 1 });
    return evaluateRuntime(app, wire, samples);
  }

  const id = 'cancel-reading';
  assert.equal(result({ slots: 32, close: 174 }).verdict, 'PASS');
  assert.equal(result({ close: 1000 }).checks[id].verdict, 'PASS');
  assert.equal(result({ slots: 1000 }).checks[id].verdict, 'PASS');
  assert.equal(result({ slots: 0, close: 0 }).checks[id].verdict, 'PASS');
  assert.equal(result({ slots: -1 }).checks[id].reason, 'slots-recovery-before-stop');
  assert.equal(result({ close: -1 }).checks[id].reason, 'wire-mismatch');
  assert.equal(result({ close: 1001 }).checks[id].reason, 'wire-mismatch');
  assert.equal(result({ slots: 1001 }).checks[id].reason, 'slots-recovery-late');
  assert.equal(result({ close: null }).checks[id].reason, 'wire-mismatch');
  assert.equal(result({ finished: true }).checks[id].reason, 'wire-mismatch');
  assert.equal(result({ extra: true }).checks[id].reason, 'wire-mismatch');
  assert.equal(result({ responseStartsAtStop: true }).checks[id].reason, 'wire-mismatch');
  assert.equal(result({ appFailed: true }).checks[id].reason, 'application-assertion');
  assert.equal(
    result({ unexpectedConnection: true }).checks.server.reason,
    'unexpected-http-or-connection',
  );
  assert.equal(result({ id: 'client-abort', close: 130 }).checks['client-abort'].verdict, 'PASS');
  assert.equal(
    result({ id: 'client-abort', close: 131 }).checks['client-abort'].reason,
    'wire-mismatch',
  );
});

test('the historical witness reports inconclusive if the second attempt is absent', () => {
  const prime = {
    code: 0,
    status: 503,
    http11: true,
    retryAfterZero: true,
    contentLength: 2,
    bodyBytes: 2,
    expectedBody: true,
    earlyDataBytes: 0,
    prereqCalls: 1,
    newConnections: 1,
    connectionId: 0,
    verifyResult: 0,
    attempts: [{ connectionId: 0, newConnections: 1, allowed: true }],
  };
  const drop = {
    code: 52,
    status: 0,
    bodyBytes: 0,
    earlyDataBytes: 0,
    prereqCalls: 1,
    newConnections: 0,
    connectionId: 0,
    verifyResult: 0,
    attempts: [{ connectionId: 0, newConnections: 0, allowed: true }],
  };
  const events = [
    {
      route: 'prime',
      target: 'primary',
      connectionId: 1,
      get: true,
      http11: true,
      finished: true,
      headersSent: true,
    },
    { route: 'drop', target: 'primary', connectionId: 1, get: true, http11: true, closed: true },
  ];
  assert.deepEqual(classify({ prime, drop }, events, false), ['NOT_RUN', 'witness-did-not-reemit']);
});

test('checks the runtime profile in the linked stage and rejects profile or entry leakage', () => {
  const load = (file) =>
    JSON.parse(readFileSync(new URL('../../' + file, import.meta.url), 'utf8'));
  const eas = load('eas.json');
  const profile = 'ios-https-libcurl-runtime';
  const app = {
    expo: {
      slug: 'bunny-talks-https',
      extra: { eas: { projectId: '9f79f216-56bb-4a89-b2f2-ed367a4164da' } },
      ios: { bundleIdentifier: 'fr.bunnytalks.mobile.httpsqualification.libcurl' },
      jsEngine: 'hermes',
      plugins: ['./qualification/with-ios-libcurl-link-map.cjs'],
    },
  };
  const pkg = { main: 'qualification/ios-libcurl-runtime-entry.tsx' };
  const input = { reviewedRevision: 'a'.repeat(40) };
  const isolated = { build: { [profile]: eas.build[profile] } };
  assert.doesNotThrow(() => validateStage(app, pkg, isolated, input));
  assert.equal(eas.build['ios-https-qualification'], undefined);
  assert.equal(eas.build['ios-https-libcurl-build'].env.EXPO_PUBLIC_USE_RN_FETCH, undefined);
  const wrongFetch = {
    build: {
      [profile]: {
        ...eas.build[profile],
        env: { ...eas.build[profile].env, EXPO_PUBLIC_USE_RN_FETCH: '0' },
      },
    },
  };
  assert.throws(() => validateStage(app, pkg, wrongFetch, input));
  assert.throws(() => validateStage(app, pkg, eas, input));
  assert.throws(() => validateStage(app, load('package.json'), isolated, input));
  assert.throws(() => validateStage(app, pkg, isolated, { reviewedRevision: '' }));
  assert.throws(() => validateStage(load('app.json'), pkg, isolated, input));
});

test('sets link-map options on the one application Release configuration', async () => {
  const require = createRequire(import.meta.url);
  const withLinkMap = require('../with-ios-libcurl-link-map.cjs');
  const configurations = {
    appRelease: { name: 'Release', buildSettings: {} },
    appDebug: { name: 'Debug', buildSettings: {} },
    podRelease: { name: 'Release', buildSettings: {} },
  };
  const config = withLinkMap({});
  const mod = config.mods.ios.xcodeproj;
  const project = {
    pbxNativeTargetSection: () => ({
      app: { productType: '"com.apple.product-type.application"', buildConfigurationList: 'app' },
      pod: {
        productType: '"com.apple.product-type.library.static"',
        buildConfigurationList: 'pod',
      },
    }),
    pbxXCConfigurationList: () => ({
      app: { buildConfigurations: [{ value: 'appRelease' }, { value: 'appDebug' }] },
      pod: { buildConfigurations: [{ value: 'podRelease' }] },
    }),
    pbxXCBuildConfigurationSection: () => configurations,
  };
  await mod({ modRequest: {}, modResults: project });
  assert.equal(configurations.appRelease.buildSettings.LD_GENERATE_MAP_FILE, 'YES');
  assert.match(configurations.appRelease.buildSettings.LD_MAP_FILE_PATH, /BunnyHttpsLinkMap/);
  assert.deepEqual(configurations.appDebug.buildSettings, {});
  assert.deepEqual(configurations.podRelease.buildSettings, {});
});
