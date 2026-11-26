import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
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
  responseStarted: boolean;
  responseStartedAtMs: number | null;
  startedAtMs: number;
  closed: boolean;
  closedAfterMs: number | null;
  finished: boolean;
};

type Verdict = 'PASS' | 'FAIL' | 'NOT_RUN';
type Snapshot = {
  overflow: boolean;
  events: Event[];
  connections: { destination: string; receivedBytes: boolean }[];
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
  if (!ready) return { observed, done: false };
  for (const id of plan) {
    const start = lines.shift();
    if (start === undefined) return { observed, done: false };
    if (start !== 'START ' + id) return { observed: new Map<string, string>(), done: false };
    const result = lines.shift();
    if (result === 'FAIL ' + id) {
      observed.set(id, 'fail');
      return { observed, done: false };
    }
    const pass =
      /^PASS ([a-z0-9-]+) (success|response|network|size|redirect|timeout|status-401|status-503)$/.exec(
        result ?? '',
      );
    if (pass?.[1] !== id) return { observed, done: false };
    observed.set(id, pass[2]!);
  }
  return { observed, done: lines.length === 1 && lines[0] === 'DONE' };
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

  function wire(id: string, result: string): Verdict {
    const probe = byId.get(id);
    if (!probe) {
      if (id === 'reuse') {
        const first = rows('/reuse/one');
        const second = rows('/reuse/two');
        if (!first.length || !second.length) return 'NOT_RUN';
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
        if (entries.length < 3) return 'NOT_RUN';
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
      if (!first.length || !second.length) return 'NOT_RUN';
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
        : 'NOT_RUN';
    }
    if (id === 'redirect' && events.some((event) => event.path === '/destination')) return 'FAIL';
    if (!entries.length) return 'NOT_RUN';
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
      if (
        !losses.every(
          (event) =>
            cut(event) &&
            event.requestComplete &&
            event.processed &&
            event.fixtureCutAtMs !== undefined,
        ) ||
        (last.finished &&
          !(last.requestComplete && last.headersSent && last.responseCoding === 'absent'))
      )
        return 'NOT_RUN';
      return last.finished === (result === 'success') ? 'PASS' : 'FAIL';
    }
    if (entries.length !== 1) return 'FAIL';
    if (method === 'POST' && !completePost(first!)) return result === 'fail' ? 'FAIL' : 'NOT_RUN';
    if (id === 'post-retry-status' && first.retryAfterZero !== true) return 'NOT_RUN';
    if (id === 'post-loss' || id === 'post-loss-prefix') {
      return cut(first!) &&
        first!.processed &&
        (id === 'post-loss' ? !first!.headersSent : first!.responseStarted)
        ? 'PASS'
        : 'NOT_RUN';
    }
    if (cutPaths.has(path)) return cut(first!) ? 'PASS' : 'NOT_RUN';
    if (id === 'limit-progressive') {
      return first!.configuredFraming === 'chunked' && first!.offeredLimitPlusOne === true
        ? first!.closed && !first!.finished
          ? 'PASS'
          : 'FAIL'
        : 'NOT_RUN';
    }
    if (id === 'timeout')
      return interrupted(first!) && first!.closedAfterMs! >= 450 && first!.closedAfterMs! < 2000
        ? 'PASS'
        : 'NOT_RUN';
    const coding = codings.get(path);
    if (coding) return first!.headersSent && first!.responseCoding === coding ? 'PASS' : 'NOT_RUN';
    if (
      id === 'standard-json' ||
      id === 'chunked-valid' ||
      id === 'limit-exact' ||
      id === 'close-delimited'
    ) {
      const framing =
        id === 'close-delimited' ? 'unobserved' : id === 'chunked-valid' ? 'chunked' : 'length';
      if (first!.configuredFraming !== framing) return 'NOT_RUN';
    }
    return first!.headersSent &&
      first!.responseCoding === 'absent' &&
      (first!.finished || id === 'redirect')
      ? 'PASS'
      : 'NOT_RUN';
  }

  let stopped = false;
  const scenarios = plan.map((id) => {
    const observed = app.observed.get(id);
    if (overflow !== false || stopped || !observed) return { id, verdict: 'NOT_RUN' as const };
    const evidence = wire(id, observed);
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
  return { verdict, scenarios };
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
