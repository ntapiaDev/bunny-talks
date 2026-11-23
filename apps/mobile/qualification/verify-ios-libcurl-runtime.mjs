import process from 'node:process';

import { diagnosticProbe, probeDiagnosticCodes } from './ios-libcurl-diagnostics.ts';
import {
  interruptions,
  localCases,
  memoryCases,
  memoryPhases,
  plan,
  prefix,
  probes,
  runtimeProfile,
  runtimeRoutes,
  standardHttpsBefore,
  standardHttpsLocalCases,
  standardHttpsMarker,
  standardHttpsPlan,
  standardHttpsProbes,
  standardHttpsReady,
  standardHttpsRoutes,
} from './ios-libcurl-scenarios.ts';

const marker = '[BunnyIosCurlRuntime] ';
const ready = 'READY ApplicationHttps Release Hermes ' + runtimeProfile;
const timestamp = (value) => Number.isSafeInteger(value) && value >= 1e12 && value < 1e13;
const httpsTargets = ['A', 'B', 'unknown', 'wrong'];
const destinations = [...httpsTargets, 'C', 'stalled-tls'];
const tlsProtocols = ['TLSv1.2', 'TLSv1.3'];
const fetchProbes = new Set(
  probes.filter(({ cookie }) => cookie?.client === 'fetch').map(({ id }) => id),
);
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const invalid = () => {
  throw new Error('invalid-evidence');
};
const requireEvidence = (condition) => {
  if (!condition) invalid();
};

const historical = {
  marker,
  ready,
  plan,
  probes,
  localCases,
  interruptions,
  memoryCases,
  routes: runtimeRoutes,
};
const standard = {
  marker: standardHttpsMarker,
  ready: standardHttpsReady,
  plan: standardHttpsPlan,
  probes: standardHttpsProbes,
  localCases: standardHttpsLocalCases,
  interruptions,
  memoryCases: [],
  routes: standardHttpsRoutes,
};
const beforeTrust = {
  ...standard,
  plan: [standardHttpsBefore.id],
  probes: [standardHttpsBefore],
  localCases: [],
  interruptions: [],
};

export function readAppLog(log, profile = historical) {
  const { marker, ready, plan, interruptions, memoryCases } = profile;
  const lines = [];
  const intervals = new Map();
  let current;
  let index = 0;
  let done = false;
  let setupFailed = false;
  for (const row of log.split(/\r?\n/)) {
    const offset = row.indexOf(marker);
    if (offset < 0) continue;
    const line = row.slice(offset + marker.length);
    if (lines.length >= 300 || done || setupFailed) invalid();
    if (!lines.length && line === 'FAIL setup') setupFailed = true;
    else if (!lines.length) requireEvidence(line === ready);
    else if (line === 'DONE') {
      requireEvidence(index === plan.length && !current);
      done = true;
    } else {
      const [action, id, ...fields] = line.split(' ');
      requireEvidence(id === plan[index]);
      if (action === 'BEGIN') {
        const start = Number(fields[0]);
        requireEvidence(
          !current &&
            fields.length === 1 &&
            validTime(fields[0]) &&
            (index === 0 || intervals.get(plan[index - 1]).end <= start),
        );
        current = { start, memory: {} };
      } else {
        requireEvidence(current);
        if (action === 'END') {
          const [time, verdict] = fields;
          const end = Number(time);
          requireEvidence(
            fields.length === 2 &&
              validTime(time) &&
              end >= current.start &&
              (['PASS', 'FAIL'].includes(verdict) ||
                (verdict === 'NOT_RUN' && fetchProbes.has(id))),
          );
          for (const observed of [current.stop, current.slots, ...Object.values(current.memory)]) {
            requireEvidence(observed === undefined || observed <= end + 5);
          }
          intervals.set(id, { ...current, end, verdict });
          current = undefined;
          index++;
        } else if (action === 'DIAG') {
          const [native, completion, adapter, client, assertion] = fields;
          requireEvidence(
            id === diagnosticProbe &&
              current.diagnostic === undefined &&
              fields.length === 5 &&
              probeDiagnosticCodes.native.includes(native) &&
              probeDiagnosticCodes.completion.includes(completion) &&
              probeDiagnosticCodes.adapter.includes(adapter) &&
              probeDiagnosticCodes.client.includes(client) &&
              probeDiagnosticCodes.assertion.includes(assertion),
          );
          current.diagnostic = { native, completion, adapter, client, assertion };
        } else if (action === 'STOP') {
          requireEvidence(
            fields.length === 1 &&
              validTime(fields[0]) &&
              interruptions.some((item) => item.id === id) &&
              current.stop === undefined &&
              Number(fields[0]) >= current.start,
          );
          current.stop = Number(fields[0]);
        } else if (action === 'SLOTS') {
          requireEvidence(
            fields.length === 1 &&
              current.stop !== undefined &&
              current.slots === undefined &&
              validTime(fields[0]) &&
              Number(fields[0]) >= current.stop - 10,
          );
          current.slots = Number(fields[0]);
        } else if (action === 'MEM') {
          const [phase, time] = fields;
          const recorded = Object.values(current.memory);
          requireEvidence(
            fields.length === 2 &&
              memoryCases.includes(id) &&
              phase === memoryPhases[recorded.length] &&
              validTime(time) &&
              Number(time) >= current.start &&
              (!recorded.length || Number(time) > recorded.at(-1)),
          );
          current.memory[phase] = Number(time);
        } else invalid();
      }
    }
    lines.push(line);
  }
  return { lines, intervals, done, setupFailed };
}

function validTime(value) {
  return /^[1-9][0-9]{12}$/.test(value ?? '') && timestamp(Number(value));
}

const flags = [
  'authorization',
  'authorizationMatchesFixture',
  'cookie',
  'headersSent',
  'responseStarted',
  'closed',
  'finished',
  'postBodyMatchesFixture',
];
const optionalFlags = [
  'fixtureCut',
  'requestComplete',
  'processed',
  'offeredLimitPlusOne',
  'encodedBelowLimit',
  'configuredOversizeLength',
  'requestedRuntimeCoding',
  'contentTypeIsJson',
  'expoFixtureCookie',
  'nativeFixtureCookie',
  'ambientFixtureCookieMatches',
];

function readWire(wire, routes) {
  requireEvidence(
    wire &&
      wire.overflow === false &&
      Array.isArray(wire.events) &&
      Array.isArray(wire.connections) &&
      wire.events.length < 4096 &&
      wire.connections.length < 4096,
  );
  const connections = new Map();
  for (const row of wire.connections) {
    requireEvidence(
      row &&
        positiveInteger(row.id) &&
        !connections.has(row.id) &&
        destinations.includes(row.destination) &&
        timestamp(row.acceptedAtMs) &&
        (row.closedAtMs == null ||
          (timestamp(row.closedAtMs) && row.closedAtMs >= row.acceptedAtMs)) &&
        (row.receivedBytes === undefined || typeof row.receivedBytes === 'boolean') &&
        (row.fixtureName === undefined || typeof row.fixtureName === 'boolean') &&
        (row.tls == null || tlsProtocols.includes(row.tls)),
    );
    const { id, destination, acceptedAtMs, closedAtMs, receivedBytes, fixtureName, tls } = row;
    connections.set(id, {
      id,
      destination,
      acceptedAtMs,
      closedAtMs,
      receivedBytes,
      fixtureName,
      tls,
    });
  }

  const events = wire.events.map((row) => {
    requireEvidence(
      row &&
        destinations.includes(row.destination) &&
        timestamp(row.startedAtMs) &&
        flags.every((flag) => typeof row[flag] === 'boolean') &&
        optionalFlags.every((flag) => row[flag] === undefined || typeof row[flag] === 'boolean') &&
        (row.responseFixtureCookie === undefined ||
          ['none', 'ambient', 'native', 'unexpected'].includes(row.responseFixtureCookie)) &&
        (!row.authorizationMatchesFixture || row.authorization) &&
        (row.responseStarted
          ? timestamp(row.responseStartedAtMs) && row.responseStartedAtMs >= row.startedAtMs
          : row.responseStartedAtMs === null) &&
        (row.closed
          ? Number.isSafeInteger(row.closedAfterMs) && row.closedAfterMs >= 0
          : row.closedAfterMs === null),
    );
    const connection = connections.get(row.connectionId);
    requireEvidence(
      connection &&
        connection.destination === row.destination &&
        row.startedAtMs >= connection.acceptedAtMs &&
        (!row.finished || row.headersSent) &&
        (!row.responseStarted ||
          !row.closed ||
          row.responseStartedAtMs <= row.startedAtMs + row.closedAfterMs) &&
        (connection.closedAtMs == null ||
          row.startedAtMs + (row.closedAfterMs ?? 0) <= connection.closedAtMs + 100),
    );
    const stall = row.destination === 'stalled-tls';
    if (stall)
      requireEvidence(row.path === '' && row.method === '' && row.httpVersion === undefined);
    else
      requireEvidence(
        routes.has(row.path) &&
          ['GET', 'POST', 'DELETE'].includes(row.method) &&
          row.httpVersion === '1.1' &&
          ['absent', 'identity', 'gzip', 'stacked', 'other'].includes(row.responseCoding) &&
          ['length', 'chunked', 'other', 'unobserved'].includes(row.configuredFraming),
      );
    const {
      destination,
      path,
      method,
      startedAtMs,
      responseStartedAtMs,
      closedAfterMs,
      connectionId,
      httpVersion,
      responseCoding,
      configuredFraming,
      responseFixtureCookie,
    } = row;
    return {
      destination,
      path,
      method,
      startedAtMs,
      responseStartedAtMs,
      closedAfterMs,
      connectionId,
      httpVersion,
      responseCoding,
      configuredFraming,
      responseFixtureCookie,
      ...Object.fromEntries([...flags, ...optionalFlags].map((flag) => [flag, row[flag]])),
    };
  });
  return { events, connections };
}

function rejectedTls(phase, attempts, httpReceived, trustedControlPassed) {
  if (httpReceived) return { verdict: 'FAIL', reason: 'http-on-rejected-tls' };
  if (attempts.length > 1) return { verdict: 'FAIL', reason: 'extra-tls-connection' };
  const [connection] = attempts;
  if (!connection) return { verdict: 'NOT_RUN', reason: 'tls-connection-missing' };
  const { acceptedAtMs, closedAtMs, receivedBytes, fixtureName, tls } = connection;
  if (
    acceptedAtMs < phase.start - 5 ||
    acceptedAtMs > phase.end ||
    (closedAtMs != null && closedAtMs > phase.end + 250)
  )
    return { verdict: 'FAIL', reason: 'tls-window-mismatch' };
  if (receivedBytes === false && (fixtureName === true || tlsProtocols.includes(tls)))
    return { verdict: 'FAIL', reason: 'contradictory-tls-evidence' };
  if (receivedBytes !== true || fixtureName !== true)
    return { verdict: 'NOT_RUN', reason: 'tls-client-hello-unconfirmed' };
  // The pinned curl backend checks the peer after SSL_connect succeeds.
  if (!tlsProtocols.includes(tls))
    return { verdict: 'NOT_RUN', reason: 'tls-handshake-unconfirmed' };
  if (closedAtMs == null) return { verdict: 'NOT_RUN', reason: 'tls-close-unconfirmed' };
  if (!trustedControlPassed)
    return { verdict: 'NOT_RUN', reason: 'tls-trusted-control-unconfirmed' };
  return { verdict: 'PASS', reason: 'tls-handshake-without-http' };
}

function cookieEvidence(id, row, cookie, prerequisitePassed) {
  if (row.expoFixtureCookie === true && !row.cookie)
    return { verdict: 'FAIL', reason: 'contradictory-cookie-evidence' };
  if (row.nativeFixtureCookie || (cookie.receives === 'none' && row.cookie))
    return { verdict: 'FAIL', reason: 'unexpected-request-cookie' };
  if (row.responseFixtureCookie !== undefined && row.responseFixtureCookie !== cookie.sets)
    return { verdict: 'FAIL', reason: 'unexpected-response-set-cookie' };
  if (row.ambientFixtureCookieMatches === true && (!row.cookie || row.expoFixtureCookie === false))
    return { verdict: 'FAIL', reason: 'contradictory-cookie-evidence' };
  if (cookie.receives === 'ambient' && row.cookie && row.ambientFixtureCookieMatches === false)
    return { verdict: 'FAIL', reason: 'unexpected-request-cookie' };
  if (
    !prerequisitePassed ||
    row.nativeFixtureCookie === undefined ||
    row.expoFixtureCookie === undefined ||
    row.ambientFixtureCookieMatches === undefined ||
    row.responseFixtureCookie === undefined
  )
    return { verdict: 'NOT_RUN', reason: 'cookie-evidence-unconfirmed' };
  if (cookie.receives === 'ambient' && !row.ambientFixtureCookieMatches)
    return id === 'cookie-fetch-probe'
      ? { verdict: 'NOT_RUN', reason: 'ambient-cookie-witness-missing' }
      : { verdict: 'FAIL', reason: 'ambient-cookie-lost' };
  return { verdict: 'PASS', reason: 'cookie-state-correlated' };
}

const min = (samples) => Math.min(...samples.map((row) => row.rssKiB));
const max = (samples) => Math.max(...samples.map((row) => row.rssKiB));

function memoryEvidence(app, samples) {
  if (
    !Array.isArray(samples) ||
    !samples.length ||
    samples.length > 2000 ||
    samples.some(
      (row, i) =>
        !row ||
        !timestamp(row.atMs) ||
        !positiveInteger(row.rssKiB) ||
        (i > 0 && samples[i - 1].atMs >= row.atMs),
    )
  )
    return null;
  const result = {};
  for (const id of memoryCases) {
    const phase = app.intervals.get(id)?.memory;
    if (!phase?.end) return null;
    result[id] = {};
    for (const [i, name] of memoryPhases.slice(0, -1).entries()) {
      const rows = samples.filter(
        ({ atMs }) => atMs >= phase[name] && atMs < phase[memoryPhases[i + 1]],
      );
      if (rows.length < 2) return null;
      result[id][name] = { samples: rows.length, minRssKiB: min(rows), maxRssKiB: max(rows) };
    }
  }
  return result;
}

export function evaluateRuntime(
  log,
  wire,
  samples,
  { requireProbeDiagnostic = false, profile = historical, trustedAfter = false } = {},
) {
  const { plan, probes, localCases, interruptions, memoryCases, routes } = profile;
  const checks = {};
  let evidence;
  let rss = null;
  const record = (id, verdict, reason) => {
    checks[id] = { verdict, reason };
  };
  try {
    const app = readAppLog(log, profile);
    evidence = { application: app.lines, events: [], connections: [] };
    record(
      'application',
      app.setupFailed ? 'FAIL' : app.done ? 'PASS' : 'NOT_RUN',
      app.setupFailed ? 'native-profile-or-engine' : app.done ? 'plan-complete' : 'plan-incomplete',
    );
    for (const id of plan) {
      const item = app.intervals.get(id);
      record(
        id,
        item?.verdict === 'FAIL' ? 'FAIL' : 'NOT_RUN',
        item?.verdict === 'FAIL' ? 'application-assertion' : 'wire-unconfirmed',
      );
    }
    if (wire == null) {
      record('server', 'NOT_RUN', 'fixture-evidence-missing');
    } else {
      const { events, connections } = readWire(wire, routes);
      evidence.events = events;
      evidence.connections = [...connections.values()];
      const used = new Set();
      const fetchConnections = new Set();
      const matched = new Set();
      function verify(id, check) {
        const phase = app.intervals.get(id);
        if (!phase) return;
        const result = check(phase);
        if (phase.verdict === 'FAIL') return;
        const { verdict, reason } =
          typeof result === 'string'
            ? { verdict: result, reason: result === 'PASS' ? 'correlated' : 'wire-mismatch' }
            : result;
        if (id === diagnosticProbe && verdict === 'PASS') {
          const diagnostic = phase.diagnostic;
          if (
            diagnostic &&
            (diagnostic.native !== 'response' ||
              diagnostic.adapter !== 'response' ||
              diagnostic.client !== 'response' ||
              diagnostic.assertion !== 'none' ||
              diagnostic.completion === 'unexpected')
          ) {
            record(id, 'FAIL', 'probe-diagnostic-mismatch');
            return;
          }
          if (
            requireProbeDiagnostic &&
            (!diagnostic || ['unavailable', 'not-completed'].includes(diagnostic.completion))
          ) {
            record(id, 'NOT_RUN', 'probe-diagnostic-missing');
            return;
          }
        }
        if (phase.verdict === 'NOT_RUN' && verdict === 'PASS')
          record(id, 'NOT_RUN', 'fetch-witness-unconfirmed');
        else record(id, verdict, reason);
      }
      function attach(row, phase) {
        const conn = connections.get(row.connectionId);
        const fresh = !used.has(conn.id);
        used.add(conn.id);
        matched.add(row);
        return (
          fresh &&
          conn.acceptedAtMs >= phase.start - 5 &&
          conn.acceptedAtMs <= phase.end &&
          timestamp(conn.closedAtMs) &&
          row.closed &&
          (row.destination === 'stalled-tls'
            ? conn.receivedBytes && conn.tls === null
            : conn.fixtureName === true &&
              tlsProtocols.includes(conn.tls) &&
              row.requestedRuntimeCoding === true)
        );
      }
      function attachFetch(row, phase) {
        const conn = connections.get(row.connectionId);
        const fresh = !used.has(conn.id);
        const reusable = fetchConnections.has(conn.id);
        used.add(conn.id);
        matched.add(row);
        if (fresh) fetchConnections.add(conn.id);
        return (
          (reusable || (fresh && conn.acceptedAtMs >= phase.start - 5)) &&
          row.startedAtMs >= phase.start - 5 &&
          row.startedAtMs <= phase.end &&
          tlsProtocols.includes(conn.tls) &&
          row.closed
        );
      }
      for (const spec of probes) {
        verify(spec.id, (phase) => {
          const requests = events.filter((row) => row.path === prefix + spec.id);
          if (spec.wire === 'reject') {
            const rejected = [...connections.values()].filter(
              (conn) => conn.destination === spec.destination,
            );
            for (const connection of rejected) used.add(connection.id);
            return rejectedTls(
              phase,
              rejected,
              requests.length > 0 || events.some((row) => row.destination === spec.destination),
              profile === beforeTrust
                ? trustedAfter
                : checks['tls-trusted-other-port']?.verdict === 'PASS',
            );
          }
          const [row] = requests;
          const bearer = spec.bearer === true;
          const fetch = spec.cookie?.client === 'fetch';
          if (fetch && !requests.length)
            return { verdict: 'NOT_RUN', reason: 'fetch-request-unobserved' };
          if (
            requests.length !== 1 ||
            row.destination !== spec.destination ||
            row.method !== spec.method ||
            !(fetch ? attachFetch(row, phase) : attach(row, phase)) ||
            (!spec.cookie && row.cookie) ||
            row.authorization !== bearer ||
            row.authorizationMatchesFixture !== bearer
          )
            return 'FAIL';
          if (
            (spec.framing && row.configuredFraming !== spec.framing) ||
            (spec.coding && row.responseCoding !== spec.coding)
          )
            return 'FAIL';
          if (spec.wire === 'complete' && (!row.headersSent || !row.finished)) return 'FAIL';
          if (
            profile === standard &&
            spec.id === 'gzip-oversize' &&
            (row.offeredLimitPlusOne !== true || row.encodedBelowLimit !== true)
          )
            return { verdict: 'NOT_RUN', reason: 'decoded-boundary-unconfirmed' };
          if (
            spec.id === 'post-body' &&
            (row.requestComplete !== true ||
              !row.postBodyMatchesFixture ||
              row.contentTypeIsJson !== true)
          )
            return { verdict: 'FAIL', reason: 'nominal-post-mismatch' };
          if (spec.cookie)
            return cookieEvidence(
              spec.id,
              row,
              spec.cookie,
              spec.cookie.needs === undefined || checks[spec.cookie.needs]?.verdict === 'PASS',
            );
          if (spec.wire === 'cut' && (row.fixtureCut !== true || row.finished)) return 'FAIL';
          if (
            spec.wire === 'held' &&
            (!row.headersSent ||
              row.finished ||
              (spec.id === 'identity-oversize'
                ? row.offeredLimitPlusOne !== true
                : row.configuredOversizeLength !== true || row.closedAfterMs >= 6000))
          )
            return 'FAIL';
          if (spec.id.startsWith('cut-')) {
            const after = spec.id.endsWith('-after');
            if (
              row.processed !== after ||
              row.headersSent !== after ||
              row.responseStarted !== after ||
              row.requestComplete !== (spec.id !== 'cut-post-before') ||
              (spec.id === 'cut-post-after' && !row.postBodyMatchesFixture)
            )
              return 'FAIL';
          }
          return 'PASS';
        });
      }
      for (const id of localCases) {
        verify(id, () => (events.some((row) => row.path === prefix + id) ? 'FAIL' : 'PASS'));
      }
      for (const test of interruptions) {
        verify(test.id, (phase) => {
          if (phase.stop === undefined || phase.slots === undefined) return 'NOT_RUN';
          const cancelReading = test.id === 'cancel-reading';
          if ((cancelReading || profile === standard) && phase.slots < phase.stop)
            return { verdict: 'FAIL', reason: 'slots-recovery-before-stop' };
          if ((cancelReading || profile === standard) && phase.slots > phase.stop + 1000)
            return { verdict: 'FAIL', reason: 'slots-recovery-late' };
          if (profile === standard && test.id === 'capacity') {
            const active = events.filter((row) =>
              [prefix + test.id, prefix + 'capacity-two'].includes(row.path),
            );
            if (
              active.length !== 2 ||
              !active.every(
                (row) =>
                  row.responseStartedAtMs !== null &&
                  row.responseStartedAtMs < phase.stop &&
                  connections.get(row.connectionId).closedAtMs >= phase.stop,
              )
            )
              return 'FAIL';
          }
          const paths = test.id === 'capacity' ? [test.id, 'capacity-two'] : [test.id];
          return paths.every((id) => {
            const rows = events.filter((row) =>
              test.destination === 'stalled-tls'
                ? row.destination === test.destination
                : row.path === prefix + id,
            );
            const [row] = rows;
            if (
              rows.length !== 1 ||
              row.destination !== test.destination ||
              !attach(row, phase) ||
              (cancelReading && !row.closed) ||
              row.finished ||
              row.cookie ||
              row.authorization
            )
              return false;
            const conn = connections.get(row.connectionId);
            const progressedAt =
              test.destination === 'stalled-tls' ? conn.acceptedAtMs : row.responseStartedAtMs;
            const earliest = phase.stop - (test.id === 'deadline' ? 10 : 0);
            return (
              progressedAt !== null &&
              progressedAt < phase.stop &&
              conn.closedAtMs >= earliest &&
              conn.closedAtMs <= phase.stop + 1000 &&
              // Peer notification and slot recovery are timed independently for cancel-reading.
              (cancelReading || profile === standard || conn.closedAtMs <= phase.slots + 100) &&
              (test.destination === 'stalled-tls' || (row.headersSent && row.method === 'GET'))
            );
          })
            ? 'PASS'
            : 'FAIL';
        });
      }
      for (const id of memoryCases) {
        verify(id, (phase) => {
          if (phase.memory.active === undefined || phase.memory.retained === undefined)
            return 'NOT_RUN';
          const routes =
            id === 'memory-zero' ? [] : id === 'memory-one' ? [id] : [id, 'memory-two-peer'];
          const groups = routes.map((route) => events.filter((row) => row.path === prefix + route));
          if (
            !groups.every(
              (rows) =>
                rows.length === 3 &&
                rows.every(
                  (row) =>
                    row.destination === 'A' &&
                    row.method === 'GET' &&
                    !row.cookie &&
                    !row.authorization &&
                    row.headersSent &&
                    row.finished &&
                    row.configuredFraming === 'length' &&
                    row.startedAtMs >= phase.memory.active &&
                    row.startedAtMs < phase.memory.retained &&
                    attach(row, phase),
                ),
            )
          )
            return 'FAIL';
          if (
            groups.length === 2 &&
            !groups[0].every((row, i) => {
              const a = connections.get(row.connectionId);
              const b = connections.get(groups[1][i].connectionId);
              return a.acceptedAtMs < b.closedAtMs && b.acceptedAtMs < a.closedAtMs;
            })
          )
            return 'FAIL';
          return 'PASS';
        });
      }
      record(
        'server',
        !app.done
          ? 'NOT_RUN'
          : matched.size === events.length && used.size === connections.size
            ? 'PASS'
            : 'FAIL',
        !app.done
          ? 'plan-incomplete'
          : matched.size === events.length && used.size === connections.size
            ? 'all-traffic-accounted-for'
            : 'unexpected-http-or-connection',
      );
    }
    const diagnostic = app.intervals.get(diagnosticProbe)?.diagnostic;
    if (diagnostic) checks[diagnosticProbe].diagnostic = diagnostic;
    if (memoryCases.length) {
      rss = memoryEvidence(app, samples);
      record(
        'memory-rss',
        rss ? 'PASS' : 'NOT_RUN',
        rss ? 'phase-samples-collected' : 'phase-samples-missing',
      );
    }
  } catch {
    record('evidence', 'FAIL', 'invalid-evidence');
  }
  const statuses = Object.values(checks).map(({ verdict }) => verdict);
  return {
    verdict: statuses.includes('FAIL') ? 'FAIL' : statuses.includes('NOT_RUN') ? 'NOT_RUN' : 'PASS',
    checks,
    evidence,
    rss,
  };
}

export function evaluateStandardRuntime(before, after, { cumulative = false } = {}) {
  if (cumulative && before?.wire && after?.wire) {
    const old = before.wire;
    const current = after.wire;
    if (
      old.overflow !== false ||
      current.overflow !== false ||
      !['events', 'connections'].every(
        (key) =>
          Array.isArray(old[key]) &&
          Array.isArray(current[key]) &&
          JSON.stringify(current[key].slice(0, old[key].length)) === JSON.stringify(old[key]),
      )
    )
      return { verdict: 'FAIL', reason: 'fixture-snapshots-diverged' };
    const following = current.connections.slice(old.connections.length);
    const oldClosures = old.connections.map((row) => row.closedAtMs);
    if (
      oldClosures.every(timestamp) &&
      following.some((row) => row.acceptedAtMs < Math.max(...oldClosures))
    )
      return { verdict: 'FAIL', reason: 'fixture-phase-order' };
    after = {
      log: after.log,
      wire: {
        overflow: false,
        events: current.events.slice(old.events.length),
        connections: following,
      },
    };
  }
  const trusted = evaluateRuntime(after?.log ?? '', after?.wire, null, { profile: standard });
  const untrusted = evaluateRuntime(before?.log ?? '', before?.wire, null, {
    profile: beforeTrust,
    trustedAfter: trusted.checks['identity-json']?.verdict === 'PASS',
  });
  const phase = ({ verdict, checks, evidence }, specs) => ({
    verdict,
    checks: Object.fromEntries(
      Object.entries(checks).map(([id, row]) => {
        const outcome = specs.find((spec) => spec.id === id)?.outcome;
        const category = ['json', 'exact'].includes(outcome) ? 'success' : outcome;
        return [id, row.verdict === 'PASS' && category ? { ...row, category } : row];
      }),
    ),
    counters: {
      requests: evidence?.events.filter((row) => row.httpVersion === '1.1').length ?? 0,
      connections: evidence?.connections.length ?? 0,
    },
  });
  const verdicts = [trusted.verdict, untrusted.verdict];
  return {
    verdict: verdicts.includes('FAIL')
      ? 'FAIL'
      : verdicts.every((v) => v === 'PASS')
        ? 'PASS'
        : 'NOT_RUN',
    beforeTrust: phase(untrusted, [standardHttpsBefore]),
    afterTrust: phase(trusted, standardHttpsProbes),
  };
}

if (import.meta.main) {
  const { readFileSync } = await import('node:fs');
  try {
    const [log, events, rss, afterLog, afterEvents] = process.argv.slice(2);
    const read = (path) => (path === undefined ? null : JSON.parse(readFileSync(path, 'utf8')));
    const report =
      log === '--standard'
        ? evaluateStandardRuntime(
            { log: events && readFileSync(events, 'utf8'), wire: read(rss) },
            { log: afterLog && readFileSync(afterLog, 'utf8'), wire: read(afterEvents) },
            { cumulative: true },
          )
        : evaluateRuntime(
            log === undefined ? '' : readFileSync(log, 'utf8'),
            read(events),
            read(rss),
          );
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = report.verdict === 'PASS' ? 0 : report.verdict === 'FAIL' ? 1 : 2;
  } catch {
    process.stdout.write('{"verdict":"NOT_RUN","reason":"evidence-unavailable"}\n');
    process.exitCode = 2;
  }
}
