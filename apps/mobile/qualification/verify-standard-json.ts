import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { httpStatus, readDiagnostic } from './standard-json-diagnostics.ts';
import {
  firstBearer,
  marker,
  plan,
  prefix,
  probes,
  requestTimeoutMs,
} from './standard-json-scenarios.ts';

type Event = {
  path: string;
  destination: string;
  method: string;
  connectionId?: number;
  requestedCoding: string;
  responseCoding: string;
  configuredFraming: string;
  requestNoStore?: boolean;
  authorization: boolean;
  authorizationMatchesFixture: boolean;
  authorizationMatchesSecond?: boolean;
  cookie: boolean;
  contentTypeIsJson: boolean;
  postBodyMatchesFixture: boolean;
  requestComplete?: boolean;
  processed?: boolean;
  fixtureCut?: boolean;
  fixtureCutAtMs?: number;
  retryAfterZero?: boolean;
  offeredLimitPlusOne?: boolean;
  headersSent: boolean;
  responseStatus?: number;
  responseStarted: boolean;
  responseStartedAtMs: number | null;
  startedAtMs: number;
  closed: boolean;
  closedAfterMs: number | null;
  finished: boolean;
};

type Verdict = 'PASS' | 'FAIL' | 'NOT_RUN';
type WireEvidence = 'PASS' | 'FAIL' | { reason: string };
const missing = (reason: string): WireEvidence => ({ reason });
type Snapshot = {
  overflow: boolean;
  events: Event[];
  connections: { destination: string; receivedBytes: boolean; tls?: string | null }[];
};
const cut = (event: Event) => event.fixtureCut === true && event.closed && !event.finished;
const interrupted = (event: Event) =>
  event.responseStarted &&
  event.closed &&
  !event.finished &&
  event.closedAfterMs !== null &&
  event.closedAfterMs < 3500;
const completePost = (event: Event) =>
  event.requestComplete && event.contentTypeIsJson && event.postBodyMatchesFixture;

const codings = new Map([
  ['/coding-gzip', 'gzip'],
  ['/gzip-truncated', 'gzip'],
  ['/chunked-coding-gzip', 'gzip'],
  ['/coding-other', 'other'],
  ['/coding-stacked', 'stacked'],
]);
const cutPaths = new Set([
  '/length',
  '/truncated',
  '/chunked-incomplete-end',
  '/length-conflict',
  '/length-and-chunked',
]);

function readApp(log: string, profile: string) {
  const lines = log.split(/\r?\n/).flatMap((line) => {
    const at = line.lastIndexOf(marker);
    if (at < 0) return [];
    return [line.slice(at + marker.length).trim()];
  });
  const ready = lines.shift() === 'READY standard-json-' + profile;
  const observed = new Map<string, string>();
  const diagnostics = new Map<string, ReturnType<typeof readDiagnostic>>();
  if (!ready) return { observed, diagnostics, done: false, missing: 'app-readiness-unconfirmed' };
  for (const id of plan) {
    const start = lines.shift();
    if (start === undefined)
      return { observed, diagnostics, done: false, missing: 'scenario-start-missing' };
    if (start !== 'START ' + id)
      return {
        observed: new Map<string, string>(),
        diagnostics,
        done: false,
        missing: 'unexpected-scenario-start',
      };
    const result = lines.shift();
    const fail = /^FAIL ([a-z0-9-]+)(?: (\{.*\}))?$/.exec(result ?? '');
    if (fail?.[1] === id) {
      observed.set(id, 'fail');
      diagnostics.set(id, readDiagnostic(fail[2]));
      return { observed, diagnostics, done: false };
    }
    const pass =
      /^PASS ([a-z0-9-]+) (success|response|network|size|redirect|timeout|status-401|status-503)(?: (\{.*\}))?$/.exec(
        result ?? '',
      );
    if (pass?.[1] !== id)
      return { observed, diagnostics, done: false, missing: 'scenario-outcome-missing' };
    observed.set(id, pass[2]!);
    diagnostics.set(id, readDiagnostic(pass[3]));
  }
  const done = lines.length === 1 && lines[0] === 'DONE';
  return { observed, diagnostics, done, missing: done ? undefined : 'app-completion-unconfirmed' };
}

export function verifyStandardJson(platform: 'ios' | 'android', log: string, snapshot: Snapshot) {
  const { events, connections, overflow } = snapshot;
  const app = readApp(log, platform === 'ios' ? 'urlsession' : 'okhttp');
  const rows = (path: string, destination = 'A') =>
    events.filter((event) => event.path === prefix + path && event.destination === destination);
  const clean = (event: Event) =>
    event.requestNoStore === true && event.requestedCoding === 'identity' && !event.cookie;
  const anonymous = (event: Event) => clean(event) && !event.authorization;
  const byId = new Map(probes.map((probe) => [probe.id, probe]));

  function wire(id: string, result: string): WireEvidence {
    const probe = byId.get(id);
    if (!probe) {
      if (id === 'reuse') {
        const first = rows('/reuse/one');
        const second = rows('/reuse/two');
        if (!first.length || !second.length)
          return missing(first.length ? 'no-second-reception' : 'no-first-reception');
        return first.length === 1 &&
          second.length === 1 &&
          [...first, ...second].every((event) => anonymous(event) && event.finished) &&
          first[0]!.connectionId !== undefined &&
          first[0]!.connectionId === second[0]!.connectionId
          ? 'PASS'
          : 'FAIL';
      }
      if (id === 'identity-isolation') {
        const entries = rows('/identity');
        if (entries.some((event) => !clean(event))) return 'FAIL';
        if (entries.length < 3) return missing('missing-identity-receptions');
        return entries.length === 3 &&
          entries.every((event) => event.finished) &&
          entries[0]!.authorizationMatchesFixture &&
          entries[1]!.authorizationMatchesSecond &&
          !entries[2]!.authorization
          ? 'PASS'
          : 'FAIL';
      }
      const first = rows('/slow/concurrency-one');
      const second = rows('/slow/neighbour');
      if (!first.length || !second.length)
        return missing(first.length ? 'no-second-reception' : 'no-first-reception');
      const [cancelled] = first;
      const [neighbour] = second;
      return first.length === 1 &&
        second.length === 1 &&
        anonymous(cancelled!) &&
        anonymous(neighbour!) &&
        interrupted(cancelled!) &&
        neighbour!.finished &&
        neighbour!.responseStartedAtMs !== null &&
        neighbour!.responseStartedAtMs <= cancelled!.startedAtMs + cancelled!.closedAfterMs! &&
        neighbour!.closedAfterMs !== null &&
        neighbour!.startedAtMs + neighbour!.closedAfterMs >
          cancelled!.startedAtMs + cancelled!.closedAfterMs!
        ? 'PASS'
        : 'FAIL';
    }

    const { path, method = 'GET', destination = 'A' } = probe;
    const entries = rows(path, destination);
    const lostGet = probe.result === 'lost-get';
    if (
      (lostGet || id === 'post-retry-status') &&
      events.some((event) => event.path === prefix + path && event.destination !== destination)
    )
      return 'FAIL';
    if (destination === 'unknown' || destination === 'wrong') {
      if (entries.length !== 0) return 'FAIL';
      return connections.some((row) => row.destination === destination && row.receivedBytes)
        ? 'PASS'
        : missing('no-tls-attempt-observed');
    }
    if (id === 'redirect' && events.some((event) => event.path === '/destination')) return 'FAIL';
    if (!entries.length) return missing('no-http-reception');
    if (
      entries.some(
        (event) =>
          event.method !== method ||
          !clean(event) ||
          (probe.bearer === firstBearer ? !event.authorizationMatchesFixture : event.authorization),
      )
    )
      return 'FAIL';

    const first = entries[0]!;
    if (lostGet) {
      if (platform === 'android' && entries.length !== 1) return 'FAIL';
      const last = entries.at(-1)!;
      const losses = last.finished ? entries.slice(0, -1) : entries;
      // The first server receipt can only give an upper bound on the original client deadline.
      const witnessDeadline = first.startedAtMs + requestTimeoutMs;
      if (
        !losses.length ||
        (id === 'get-loss-repeated' && last.finished) ||
        losses.some(
          (event) =>
            event.finished ||
            event.headersSent ||
            event.processed === false ||
            event.requestComplete === false,
        ) ||
        entries.some((event, index) => {
          const previousCut = entries[index - 1]?.fixtureCutAtMs;
          return (
            event.startedAtMs >= witnessDeadline ||
            (previousCut !== undefined && event.startedAtMs < previousCut)
          );
        })
      )
        return 'FAIL';
      if (!losses.every((event) => cut(event) && event.fixtureCutAtMs !== undefined))
        return missing('get-loss-cut-unconfirmed');
      if (!losses.every((event) => event.requestComplete && event.processed))
        return missing('get-loss-processing-unconfirmed');
      if (
        last.finished &&
        !(last.requestComplete && last.headersSent && last.responseCoding === 'absent')
      )
        return missing('get-recovery-response-unconfirmed');
      return last.finished === (result === 'success') ? 'PASS' : 'FAIL';
    }
    if (entries.length !== 1) return 'FAIL';
    if (method === 'POST' && !completePost(first!))
      return result === 'fail' ? 'FAIL' : missing('incomplete-post-request');
    if (id === 'post-retry-status' && first.retryAfterZero !== true)
      return missing('missing-retry-after-zero');
    if (id === 'post-loss' || id === 'post-loss-prefix') {
      return cut(first!) &&
        first!.processed &&
        (id === 'post-loss' ? !first!.headersSent : first!.responseStarted)
        ? 'PASS'
        : missing('missing-post-cut-evidence');
    }
    if (cutPaths.has(path)) return cut(first!) ? 'PASS' : missing('fixture-cut-unconfirmed');
    if (id === 'limit-progressive') {
      return first!.configuredFraming === 'chunked' && first!.offeredLimitPlusOne === true
        ? first!.closed && !first!.finished
          ? 'PASS'
          : 'FAIL'
        : missing('progressive-limit-unconfirmed');
    }
    if (id === 'timeout')
      return interrupted(first!) && first!.closedAfterMs! >= 450 && first!.closedAfterMs! < 2000
        ? 'PASS'
        : missing('timeout-interruption-unconfirmed');
    const coding = codings.get(path);
    if (coding) {
      if (!first.headersSent) return missing('headers-not-observed');
      return first.responseCoding === coding ? 'PASS' : missing('unexpected-response-coding');
    }
    if (!first.headersSent) return missing('headers-not-observed');
    if (
      id === 'standard-json' ||
      id === 'chunked-valid' ||
      id === 'limit-exact' ||
      id === 'close-delimited'
    ) {
      const framing =
        id === 'close-delimited' ? 'unobserved' : id === 'chunked-valid' ? 'chunked' : 'length';
      if (first.configuredFraming !== framing) return missing('unexpected-configured-framing');
    }
    if (first.responseCoding !== 'absent') return missing('unexpected-response-coding');
    if (!first.finished && id !== 'redirect') return missing('response-finish-unconfirmed');
    return 'PASS';
  }

  function serverDiagnostic(id: string) {
    const probe = byId.get(id);
    const paths = probe
      ? [probe.path]
      : id === 'reuse'
        ? ['/reuse/one', '/reuse/two']
        : id === 'identity-isolation'
          ? ['/identity']
          : ['/slow/concurrency-one', '/slow/neighbour'];
    const entries = events.filter(
      (event) =>
        paths.some((path) => event.path === prefix + path) ||
        (id === 'redirect' && event.path === '/destination'),
    );
    const targetConnections = connections.filter(
      (row) => row.destination === (probe?.destination ?? 'A'),
    );
    return {
      fixtureConnectionsToDestination: targetConnections.length,
      fixtureConnectionsWithBytes: targetConnections.filter((row) => row.receivedBytes === true)
        .length,
      fixtureConnectionsWithTls: targetConnections.filter(
        (row) => row.tls === 'TLSv1.2' || row.tls === 'TLSv1.3',
      ).length,
      receptionConnections: new Set(
        entries.flatMap((event) => (event.connectionId === undefined ? [] : [event.connectionId])),
      ).size,
      receptions: entries.length,
      samples: entries.slice(0, 8).map((event) => ({
        expectedDestination: event.destination === (probe?.destination ?? 'A'),
        framing: ['length', 'chunked', 'unobserved'].includes(event.configuredFraming)
          ? event.configuredFraming
          : 'other',
        requestedCoding: ['absent', 'identity', 'gzip', 'stacked'].includes(event.requestedCoding)
          ? event.requestedCoding
          : 'other',
        responseCoding: ['absent', 'identity', 'gzip', 'stacked'].includes(event.responseCoding)
          ? event.responseCoding
          : 'other',
        headersSent: event.headersSent === true,
        status: httpStatus(event.responseStatus),
        requestNoStore: event.requestNoStore === true,
        explicitResponseStartObserved: event.responseStarted === true,
        requestComplete:
          typeof event.requestComplete === 'boolean' ? event.requestComplete : undefined,
        finished: event.finished === true,
        closed: event.closed === true,
        fixtureCut: event.fixtureCut === true,
      })),
    };
  }

  let stopped = false;
  const scenarios = plan.map((id) => {
    const observed = app.observed.get(id);
    if (stopped || !observed) return { id, verdict: 'NOT_RUN' as const };
    const wireEvidence = overflow !== false ? missing('fixture-overflow') : wire(id, observed);
    const evidence = typeof wireEvidence === 'string' ? wireEvidence : 'NOT_RUN';
    const expected = byId.get(id)?.result;
    const expectedOutcomes =
      expected === 'reject'
        ? ['response', 'network']
        : expected === 'lost-get'
          ? ['success', 'response', 'network', 'timeout']
          : expected === 'auth'
            ? ['network', 'response', 'status-401']
            : expected === 'size' ||
                expected === 'redirect' ||
                expected === 'network' ||
                expected === 'timeout' ||
                expected === 'status-503'
              ? [expected]
              : ['success'];
    const verdict = evidence === 'PASS' && !expectedOutcomes.includes(observed) ? 'FAIL' : evidence;
    stopped = verdict !== 'PASS';
    const probe = byId.get(id);
    return {
      id,
      verdict,
      observed,
      ...(verdict !== 'PASS'
        ? {
            reason:
              typeof wireEvidence !== 'string'
                ? wireEvidence.reason
                : wireEvidence === 'FAIL'
                  ? 'wire-criteria-failed'
                  : 'unexpected-app-outcome',
            client: app.diagnostics.get(id),
            server: serverDiagnostic(id),
          }
        : {}),
      ...(probe?.result === 'lost-get'
        ? {
            receptions: events.filter((event) => event.path === prefix + probe.path).length,
          }
        : {}),
    };
  });
  const verdict: Verdict = scenarios.some((row) => row.verdict === 'FAIL')
    ? 'FAIL'
    : app.done && scenarios.every((row) => row.verdict === 'PASS')
      ? 'PASS'
      : 'NOT_RUN';
  return { verdict, scenarios, ...(app.missing ? { appEvidence: app.missing } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [platform, log, events] = process.argv.slice(2);
  if ((platform !== 'ios' && platform !== 'android') || !log || !events)
    throw new Error('Expected platform, app log and fixture events');
  const report = verifyStandardJson(
    platform,
    readFileSync(log, 'utf8'),
    JSON.parse(readFileSync(events, 'utf8')) as Snapshot,
  );
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.verdict === 'PASS' ? 0 : 1;
}
