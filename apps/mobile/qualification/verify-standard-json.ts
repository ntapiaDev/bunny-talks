import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { httpStatus, readDiagnostic } from './standard-json-diagnostics.ts';
import {
  androidPlan,
  firstBearer,
  marker,
  plan,
  prefix,
  probes,
  requestTimeoutMs,
  retryFramingFaults,
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
  framingFault?: string;
  framingFaultOfferedAtMs?: number;
  framingFaultConfirmedAtMs?: number;
  iosPrimaryTarget?: boolean;
  retryAfterZero?: boolean;
  configuredOversizeLength?: boolean;
  heldLengthEnd?: string;
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
export type Snapshot = {
  overflow: boolean;
  events: Event[];
  connections: {
    id?: number;
    destination: string;
    receivedBytes: boolean;
    fixtureName?: boolean;
    closedAtMs?: number | null;
    tls?: string | null;
  }[];
};
export const cut = (event: Event) => event.fixtureCut === true && event.closed && !event.finished;
const keepEvidence = new Set([
  'chunked-valid-rejected',
  'limit-exact',
  'limit-declared',
  'timeout',
  'cancel-neighbour',
  'reuse',
  'identity-isolation',
  'redirect',
  'auth-challenge',
  'empty-204',
  'session-delete',
  'framing-recovery',
  'cancel-retried-get',
]);
const supplementalPaths = new Map([
  ['reuse', ['/reuse/one', '/reuse/two']],
  ['identity-isolation', ['/identity']],
  ['cancel-neighbour', ['/slow/concurrency-one', '/slow/neighbour', '/third-reservation']],
  ['session-delete', ['/session-delete', '/session-delete-loss']],
  ['framing-recovery', ['/recover-bad-length', '/recover-json']],
  ['cancel-retried-get', ['/loss-get-cancel']],
]);
export const knownLength = (event: Event) =>
  event.headersSent && event.configuredFraming === 'length' && event.responseCoding === 'absent';
export const interrupted = (event: Event) =>
  knownLength(event) &&
  event.responseStarted &&
  event.closed &&
  !event.finished &&
  event.closedAfterMs !== null &&
  event.closedAfterMs < 3500;
export const completePost = (event: Event) =>
  event.requestComplete && event.contentTypeIsJson && event.postBodyMatchesFixture;
const neighbourOverlapped = (cancelled: Event, neighbour: Event) =>
  cancelled.closedAfterMs !== null &&
  neighbour.responseStartedAtMs !== null &&
  neighbour.responseStartedAtMs <= cancelled.startedAtMs + cancelled.closedAfterMs &&
  neighbour.closedAfterMs !== null &&
  neighbour.startedAtMs + neighbour.closedAfterMs > cancelled.startedAtMs + cancelled.closedAfterMs;

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
const knownFramingFaults = new Set(retryFramingFaults.values());
export const tlsEstablished = (connection: Snapshot['connections'][number]) =>
  connection.tls === 'TLSv1.2' || connection.tls === 'TLSv1.3';
const elapsed = (end: number | undefined, start: number | undefined) =>
  end !== undefined &&
  start !== undefined &&
  Number.isSafeInteger(end - start) &&
  end - start >= 0 &&
  end - start <= 120_000
    ? end - start
    : undefined;

export function readApp(
  log: string,
  profile: string,
  scenarioIds: readonly string[],
  logMarker = marker,
) {
  const lines = log.split(/\r?\n/).flatMap((line) => {
    const at = line.lastIndexOf(logMarker);
    if (at < 0) return [];
    return [line.slice(at + logMarker.length).trim()];
  });
  const ready = lines.shift() === 'READY standard-json-known-length-' + profile;
  const observed = new Map<string, string>();
  const diagnostics = new Map<string, ReturnType<typeof readDiagnostic>>();
  const started = new Set<string>();
  if (!ready)
    return { observed, diagnostics, started, done: false, missing: 'app-readiness-unconfirmed' };
  for (const id of scenarioIds) {
    const start = lines.shift();
    if (start === undefined)
      return { observed, diagnostics, started, done: false, missing: 'scenario-start-missing' };
    if (start !== 'START ' + id)
      return {
        observed,
        diagnostics,
        started,
        done: false,
        missing: 'unexpected-scenario-start',
      };
    started.add(id);
    const result = lines.shift();
    const fail = /^FAIL ([a-z0-9-]+)(?: (\{.*\}))?$/.exec(result ?? '');
    if (fail?.[1] === id) {
      observed.set(id, 'fail');
      diagnostics.set(id, readDiagnostic(fail[2]));
      if (!lines.length) return { observed, diagnostics, started, done: false };
      continue;
    }
    const pass =
      /^PASS ([a-z0-9-]+) (success|response|network|size|redirect|timeout|status-401|status-503)(?: (\{.*\}))?$/.exec(
        result ?? '',
      );
    if (pass?.[1] !== id)
      return { observed, diagnostics, started, done: false, missing: 'scenario-outcome-missing' };
    observed.set(id, pass[2]!);
    diagnostics.set(id, readDiagnostic(pass[3]));
  }
  const done = lines.length === 1 && lines[0] === 'DONE';
  return {
    observed,
    diagnostics,
    started,
    done,
    missing: done ? undefined : 'app-completion-unconfirmed',
  };
}

export function verifyStandardJson(platform: 'ios' | 'android', log: string, snapshot: Snapshot) {
  const { events, connections, overflow } = snapshot;
  const scenarioIds = platform === 'ios' ? plan : androidPlan;
  const app = readApp(log, platform === 'ios' ? 'urlsession' : 'okhttp', scenarioIds);
  const rows = (path: string, destination = 'A') =>
    events.filter((event) => event.path === prefix + path && event.destination === destination);
  const clean = (event: Event) =>
    event.requestNoStore === true && event.requestedCoding === 'identity' && !event.cookie;
  const anonymous = (event: Event) => clean(event) && !event.authorization;
  const byId = new Map(probes.map((probe) => [probe.id, probe]));
  const tlsConnections = new Map(
    connections
      .filter((connection) => connection.receivedBytes && tlsEstablished(connection))
      .map((connection) => [connection.id, connection.destination]),
  );

  function retrySequence(
    id: string,
    entries: Event[],
    offeredAt: (event: Event) => number | undefined,
    result: string,
  ): WireEvidence {
    const diagnostic = app.diagnostics.get(id);
    const timing = diagnostic?.retryWindow;
    if (!diagnostic || !timing || timing.openedAtMs > timing.settledAtMs)
      return missing('retry-window-unconfirmed');
    const { openedAtMs, settledAtMs } = timing;
    if (entries.some((event) => event.iosPrimaryTarget === false)) return 'FAIL';
    if (
      entries.some(
        (event) =>
          Number.isSafeInteger(event.startedAtMs) &&
          (event.startedAtMs >= openedAtMs + requestTimeoutMs || event.startedAtMs > settledAtMs),
      )
    )
      return 'FAIL';
    if (
      entries.some(
        (event) => !Number.isSafeInteger(event.startedAtMs) || event.startedAtMs < openedAtMs,
      )
    )
      return missing('retry-receipt-clock-unconfirmed');
    const otherPath = events.filter(
      (event) =>
        event.path !== entries[0]!.path &&
        event.startedAtMs >= openedAtMs &&
        event.startedAtMs <= settledAtMs,
    );
    if (
      otherPath.some((event) => event.startedAtMs > openedAtMs && event.startedAtMs < settledAtMs)
    )
      return 'FAIL';
    if (otherPath.length) return missing('retry-path-timing-ambiguous');
    if (entries.some((event) => event.requestComplete === false)) return 'FAIL';
    if (
      entries.some(
        (event) =>
          event.iosPrimaryTarget !== true ||
          event.requestComplete !== true ||
          event.connectionId === undefined ||
          tlsConnections.get(event.connectionId) !== event.destination,
      )
    )
      return missing('retry-request-or-connection-unconfirmed');
    for (const [index, event] of entries.entries()) {
      // The server may confirm a write or close after the client has already rejected it.
      const currentFault = offeredAt(event);
      if (
        currentFault !== undefined &&
        (!Number.isSafeInteger(currentFault) ||
          currentFault < event.startedAtMs ||
          currentFault > settledAtMs)
      )
        return missing('retry-fault-offer-clock-unconfirmed');
      const previous = entries[index - 1];
      if (!previous) continue;
      const fault = offeredAt(previous);
      if (fault === undefined) return missing('previous-retry-fault-unconfirmed');
      if (event.startedAtMs < fault) return 'FAIL';
    }
    const call = diagnostic.calls[0];
    if (diagnostic.calls.length > 1) return 'FAIL';
    if (
      !call ||
      call.reservation !== 'accepted' ||
      call.native === 'pending' ||
      call.native === 'not-called' ||
      call.native === 'threw' ||
      call.native === 'invalid'
    )
      return missing('terminal-native-result-unconfirmed');
    if (result === 'success')
      return call.native === 'success' && call.adapter === 'success' ? 'PASS' : 'FAIL';
    const kindMatches =
      result === 'timeout'
        ? ['network', 'response', 'timeout'].some((kind) => kind === call.nativeKind)
        : call.nativeKind === result;
    return call.native === 'rejected' &&
      call.bytes === undefined &&
      kindMatches &&
      call.application === result
      ? 'PASS'
      : 'FAIL';
  }

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
          [...first, ...second].every(
            (event) => anonymous(event) && knownLength(event) && event.finished,
          ) &&
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
          entries.every((event) => knownLength(event) && event.finished) &&
          entries[0]!.authorizationMatchesFixture &&
          entries[1]!.authorizationMatchesSecond &&
          !entries[2]!.authorization
          ? 'PASS'
          : 'FAIL';
      }
      if (
        events.some(
          (event) =>
            event.destination !== 'A' &&
            supplementalPaths.get(id)?.some((path) => prefix + path === event.path),
        )
      )
        return 'FAIL';
      if (id === 'session-delete') {
        const nominal = rows('/session-delete');
        const lost = rows('/session-delete-loss');
        if (nominal.length > 1 || lost.length > 2) return 'FAIL';
        if (nominal.length !== 1 || lost.length !== 2)
          return missing('revocation-receptions-unconfirmed');
        const [revoked] = nominal;
        const [mutation, check] = lost;
        return [...nominal, ...lost].every(
          (event) => clean(event) && event.authorizationMatchesFixture && event.requestComplete,
        ) &&
          revoked!.method === 'DELETE' &&
          revoked!.processed === true &&
          revoked!.responseStatus === 204 &&
          revoked!.finished &&
          revoked!.configuredFraming === 'unobserved' &&
          revoked!.responseCoding === 'absent' &&
          mutation!.method === 'DELETE' &&
          mutation!.processed === true &&
          !mutation!.headersSent &&
          cut(mutation!) &&
          check!.method === 'GET' &&
          check!.responseStatus === 401 &&
          knownLength(check!) &&
          check!.finished
          ? 'PASS'
          : 'FAIL';
      }
      if (id === 'framing-recovery') {
        const bad = rows('/recover-bad-length');
        const good = rows('/recover-json');
        if (!bad.length || !good.length) return missing('recovery-receptions-unconfirmed');
        if (
          (platform === 'android' && bad.length !== 1) ||
          good.length !== 1 ||
          ![...bad, ...good].every((event) => event.method === 'GET' && anonymous(event)) ||
          !bad.every(
            (event) =>
              cut(event) && knownLength(event) && event.startedAtMs <= good[0]!.startedAtMs,
          ) ||
          !knownLength(good[0]!) ||
          !good[0]!.finished
        )
          return 'FAIL';
        return 'PASS';
      }
      if (id === 'cancel-retried-get') {
        const attempts = rows('/loss-get-cancel');
        if (attempts.length > 2) return 'FAIL';
        if (attempts.length < 2) return missing('retry-not-observed-before-cancel');
        const [lost, retry] = attempts;
        const diagnostic = app.diagnostics.get(id);
        const timing = diagnostic?.retryWindow;
        if (!timing || lost!.fixtureCutAtMs === undefined || retry!.responseStartedAtMs === null)
          return missing('retry-cancel-timing-unconfirmed');
        const call = diagnostic?.calls[0];
        if (!call || call.native === 'pending') return missing('native-cancel-unconfirmed');
        if (
          diagnostic.calls.length !== 1 ||
          call.reservation !== 'accepted' ||
          call.native !== 'rejected' ||
          call.nativeKind !== 'network' ||
          call.application !== 'cancelled' ||
          call.bytes !== undefined
        )
          return 'FAIL';
        const closedAt = retry!.startedAtMs + (retry!.closedAfterMs ?? Infinity);
        return attempts.every(
          (event) =>
            event.method === 'GET' &&
            clean(event) &&
            event.authorizationMatchesFixture &&
            event.requestComplete &&
            event.iosPrimaryTarget &&
            event.connectionId !== undefined &&
            tlsConnections.get(event.connectionId) === 'A',
        ) &&
          lost!.connectionId !== retry!.connectionId &&
          cut(lost!) &&
          !lost!.headersSent &&
          timing.openedAtMs <= lost!.startedAtMs &&
          lost!.fixtureCutAtMs <= retry!.startedAtMs &&
          retry!.responseStartedAtMs < timing.settledAtMs &&
          closedAt >= timing.settledAtMs - 100 &&
          closedAt <= timing.settledAtMs + 700 &&
          timing.settledAtMs < timing.openedAtMs + requestTimeoutMs &&
          interrupted(retry!)
          ? 'PASS'
          : 'FAIL';
      }
      const refused = app.diagnostics.get(id)?.calls[2];
      if (events.some((event) => event.path === prefix + '/third-reservation')) return 'FAIL';
      if (refused?.reservation !== 'refused' || refused.native !== 'not-called')
        return missing('third-reservation-unconfirmed');
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
        cancelled!.closedAfterMs! >= 200 &&
        knownLength(neighbour!) &&
        neighbour!.finished &&
        neighbourOverlapped(cancelled!, neighbour!)
        ? 'PASS'
        : 'FAIL';
    }

    const { path, method = 'GET', destination = 'A' } = probe;
    const entries = rows(path, destination);
    const lostGet = probe.result === 'lost-get';
    const framingFault = retryFramingFaults.get(path);
    if (
      (lostGet || framingFault || method === 'POST') &&
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
      if (last.finished && !(last.requestComplete && knownLength(last)))
        return missing('get-recovery-response-unconfirmed');
      if (last.finished !== (result === 'success')) return 'FAIL';
      return platform === 'ios'
        ? retrySequence(id, entries, (event) => event.fixtureCutAtMs, result)
        : 'PASS';
    }
    if (framingFault && platform === 'ios') {
      const sequence = retrySequence(id, entries, (event) => event.framingFaultOfferedAtMs, result);
      if (sequence !== 'PASS') return sequence;
      const completedFault = id === 'chunked-valid-rejected' || id === 'close-delimited';
      if (
        entries.some(
          (event) =>
            !(completedFault
              ? event.finished &&
                event.headersSent &&
                event.responseCoding === 'absent' &&
                event.configuredFraming ===
                  (id === 'chunked-valid-rejected' ? 'chunked' : 'unobserved')
              : cut(event)) ||
            event.framingFault !== framingFault ||
            event.framingFaultOfferedAtMs === undefined ||
            event.framingFaultConfirmedAtMs === undefined ||
            !Number.isSafeInteger(event.framingFaultConfirmedAtMs) ||
            event.framingFaultConfirmedAtMs < event.framingFaultOfferedAtMs,
        )
      )
        return missing('framing-fault-unconfirmed');
      return 'PASS';
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
    if (id === 'limit-declared') {
      if (!knownLength(first) || first.configuredOversizeLength !== true)
        return missing('excessive-declared-length-unconfirmed');
      if (!first.closed || first.heldLengthEnd === undefined)
        return missing('held-response-end-unconfirmed');
      return !first.finished &&
        first.closedAfterMs !== null &&
        first.closedAfterMs < requestTimeoutMs &&
        (first.heldLengthEnd === 'peer-close' || first.heldLengthEnd === 'socket-error')
        ? 'PASS'
        : 'FAIL';
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
    const framing =
      id === 'chunked-valid-rejected'
        ? 'chunked'
        : id === 'close-delimited' || id === 'empty-204'
          ? 'unobserved'
          : 'length';
    if (id !== 'redirect' && first.configuredFraming !== framing)
      return missing('unexpected-configured-framing');
    if (id === 'empty-204' && first.responseStatus !== 204) return missing('empty-204-unconfirmed');
    if (first.responseCoding !== 'absent') return missing('unexpected-response-coding');
    if (!first.finished && id !== 'redirect') return missing('response-finish-unconfirmed');
    return 'PASS';
  }

  function serverDiagnostic(id: string) {
    const probe = byId.get(id);
    const timing = app.diagnostics.get(id)?.retryWindow;
    const paths = probe ? [probe.path] : (supplementalPaths.get(id) ?? []);
    const destination = probe?.destination ?? 'A';
    const matchingPath = events.filter((event) =>
      paths.some((path) => event.path === prefix + path),
    );
    const entries = matchingPath.filter((event) => event.destination === destination);
    const targetConnections = connections.filter((row) => row.destination === destination);
    const cancelled = id === 'cancel-neighbour' ? rows('/slow/concurrency-one') : [];
    const neighbour = id === 'cancel-neighbour' ? rows('/slow/neighbour') : [];
    return {
      destination,
      retryWindowMs: elapsed(timing?.settledAtMs, timing?.openedAtMs),
      fixtureConnectionsToDestination: targetConnections.length,
      fixtureConnectionsWithBytes: targetConnections.filter((row) => row.receivedBytes === true)
        .length,
      fixtureConnectionsWithTls: targetConnections.filter(tlsEstablished).length,
      receptionConnections: new Set(
        entries.flatMap((event) => (event.connectionId === undefined ? [] : [event.connectionId])),
      ).size,
      receptions: entries.length,
      // The three TLS probes share /json, so another listener's row belongs to another scenario.
      ...(probe?.path !== '/json'
        ? { offTargetReceptions: matchingPath.length - entries.length }
        : {}),
      ...(id === 'redirect'
        ? {
            redirectedReceptions: events.filter((event) => event.path === '/destination').length,
          }
        : {}),
      ...(cancelled.length === 1 && neighbour.length === 1
        ? { neighbourOverlapped: neighbourOverlapped(cancelled[0]!, neighbour[0]!) }
        : {}),
      samples: entries.slice(0, 8).map((event, index) => ({
        connectionIdentified: event.connectionId !== undefined,
        expectedMethod:
          event.method ===
          (id === 'session-delete'
            ? entries.find((row) => row.path === event.path) === event
              ? 'DELETE'
              : 'GET'
            : (probe?.method ?? 'GET')),
        expectedBearer:
          id === 'identity-isolation'
            ? index === 0
              ? event.authorizationMatchesFixture === true
              : index === 1
                ? event.authorizationMatchesSecond === true
                : event.authorization === false
            : probe?.bearer === firstBearer ||
                id === 'session-delete' ||
                id === 'cancel-retried-get'
              ? event.authorizationMatchesFixture === true
              : event.authorization === false,
        cookiePresent: event.cookie === true,
        ...(timing
          ? {
              exactTarget: event.iosPrimaryTarget === true,
              receivedAfterStartMs: elapsed(event.startedAtMs, timing.openedAtMs),
              faultOfferedAfterReceiptMs: elapsed(
                event.framingFaultOfferedAtMs ?? event.fixtureCutAtMs,
                event.startedAtMs,
              ),
              faultConfirmedAfterReceiptMs: elapsed(
                event.framingFaultConfirmedAtMs,
                event.startedAtMs,
              ),
            }
          : {}),
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
        processed: typeof event.processed === 'boolean' ? event.processed : undefined,
        ...(probe?.method === 'POST'
          ? {
              contentTypeIsJson: event.contentTypeIsJson === true,
              postBodyMatchesFixture: event.postBodyMatchesFixture === true,
              ...(id === 'post-retry-status'
                ? { retryAfterZero: event.retryAfterZero === true }
                : {}),
            }
          : {}),
        finished: event.finished === true,
        closed: event.closed === true,
        closedAfterMs:
          typeof event.closedAfterMs === 'number' &&
          Number.isInteger(event.closedAfterMs) &&
          event.closedAfterMs >= 0 &&
          event.closedAfterMs <= 120_000
            ? event.closedAfterMs
            : undefined,
        fixtureCut: event.fixtureCut === true,
        framingFault:
          event.framingFault && knownFramingFaults.has(event.framingFault)
            ? event.framingFault
            : undefined,
        excessiveDeclaredLength: event.configuredOversizeLength === true,
        heldLengthEnd: ['peer-close', 'socket-error', 'fixture-watchdog', 'finished'].find(
          (value) => value === event.heldLengthEnd,
        ),
      })),
    };
  }

  function scenarioDiagnostics(id: string) {
    const diagnostic = app.diagnostics.get(id);
    return {
      client: diagnostic && { failure: diagnostic.failure, calls: diagnostic.calls },
      server: serverDiagnostic(id),
    };
  }

  let stopped = false;
  const scenarios = scenarioIds.map((id) => {
    const observed = app.observed.get(id);
    if (!observed) {
      return {
        id,
        verdict: 'NOT_RUN' as const,
        ...(app.started.has(id)
          ? {
              appStarted: true,
              reason: stopped ? 'previous-scenario-unqualified' : 'scenario-outcome-missing',
              ...scenarioDiagnostics(id),
            }
          : {}),
      };
    }
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
    const assessed =
      evidence === 'PASS' && !expectedOutcomes.includes(observed) ? 'FAIL' : evidence;
    const reason =
      assessed === 'PASS'
        ? undefined
        : typeof wireEvidence !== 'string'
          ? wireEvidence.reason
          : wireEvidence === 'FAIL'
            ? 'wire-criteria-failed'
            : 'unexpected-app-outcome';
    const verdict = stopped ? 'NOT_RUN' : assessed;
    const afterStop = stopped;
    stopped ||= assessed !== 'PASS';
    const probe = byId.get(id);
    return {
      id,
      verdict,
      observed,
      ...(afterStop
        ? {
            reason: 'previous-scenario-unqualified',
            diagnostic: { verdict: assessed, reason },
          }
        : reason
          ? { reason }
          : {}),
      ...(verdict !== 'PASS' ||
      keepEvidence.has(id) ||
      probe?.method === 'POST' ||
      probe?.path === '/json' ||
      (platform === 'ios' &&
        probe &&
        (probe.result === 'lost-get' || retryFramingFaults.has(probe.path)))
        ? scenarioDiagnostics(id)
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
  return {
    verdict,
    scenarios,
    appCompleted: app.done,
    ...(app.missing ? { appEvidence: app.missing } : {}),
  };
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
