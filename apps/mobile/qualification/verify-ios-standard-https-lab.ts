import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Phase, Scenario } from './ios-standard-https-lab-plan.ts';
import {
  isPhase,
  labPath,
  marker,
  phases,
  routes,
  session,
} from './ios-standard-https-lab-plan.ts';
import { startFixture } from './server.ts';
import { port } from './standard-json-scenarios.ts';
import type { Snapshot } from './verify-standard-json.ts';
import {
  completePost,
  cut,
  interrupted,
  knownLength,
  readApp,
  tlsEstablished,
} from './verify-standard-json.ts';

type Event = Snapshot['events'][number];
type Verdict = 'PASS' | 'FAIL' | 'NOT_RUN';
const verdict = (condition: unknown): Verdict => (condition ? 'PASS' : 'FAIL');

export function verifyLaboratory(phase: Phase, log: string, snapshot: Snapshot) {
  const meta = log.split(/\r?\n/).filter((line) => {
    const at = line.lastIndexOf(marker);
    return at >= 0 && /^(STOP [0-9]{13}|EARLY)$/.test(line.slice(at + marker.length).trim());
  });
  const app = readApp(
    log
      .split(/\r?\n/)
      .filter((line) => !meta.includes(line))
      .join('\n'),
    phase,
    phases[phase],
    marker,
  );
  const { events, connections } = snapshot;
  const phasesWithoutHttp = phase !== 'nominal' && phase !== 'loss';
  const expectedRoutes = routes(phase);
  const tls = new Set(connections.filter(tlsEstablished).map(({ id }) => id));
  const noUnexpectedTraffic =
    !snapshot.overflow &&
    connections.every((row) => row.destination === 'A') &&
    (phasesWithoutHttp
      ? events.length === 0
      : events.every(
          (event) =>
            event.destination === 'A' &&
            event.iosPrimaryTarget &&
            event.connectionId !== undefined &&
            tls.has(event.connectionId) &&
            expectedRoutes.has(event.method + ' ' + event.path),
        ));

  function exact(
    method: string,
    path: string,
    expected: number,
    check: (rows: Event[]) => Verdict,
  ) {
    const rows = events.filter((row) => row.method === method && row.path === path);
    if (rows.length > expected) return 'FAIL';
    return rows.length < expected ? 'NOT_RUN' : check(rows);
  }

  const native = (event: Event, bearer?: 'first' | 'second') =>
    !event.cookie &&
    event.requestedCoding === 'identity' &&
    event.requestNoStore === true &&
    (bearer === 'first'
      ? event.authorizationMatchesFixture
      : bearer === 'second'
        ? event.authorizationMatchesSecond === true
        : !event.authorization);
  const json = (event: Event) =>
    knownLength(event) && event.responseStatus === 200 && event.finished;
  const mutation = (event: Event) =>
    event.processed === true && event.requestComplete === true && !event.headersSent && cut(event);

  function tlsRejected(): Verdict {
    if (tls.size > 0) return 'FAIL';
    return connections.length > 0 &&
      connections.every((row) => row.receivedBytes && row.fixtureName && row.closedAtMs != null)
      ? 'PASS'
      : 'NOT_RUN';
  }

  function redirected(id: string, status: number) {
    return exact('POST', labPath(id), 1, ([event]) =>
      verdict(native(event!, 'first') && event!.responseStatus === status && event!.headersSent),
    );
  }

  const checks: Record<Scenario, () => Verdict> = {
    'tls-untrusted': tlsRejected,
    'tls-wrong-name': tlsRejected,
    'origin-refused': () => verdict(connections.length === 0),
    'get-path-refused': () => verdict(connections.length === 0),
    'delete-path-refused': () => verdict(connections.length === 0),
    get: () => exact('GET', session, 1, ([row]) => verdict(native(row!) && json(row!))),
    post: () =>
      exact('POST', labPath('messages'), 1, ([row]) =>
        verdict(native(row!) && completePost(row!) && json(row!)),
      ),
    delete: () =>
      exact('DELETE', session, 1, ([row]) =>
        verdict(
          native(row!, 'first') &&
            row!.requestComplete &&
            row!.processed &&
            row!.responseStatus === 204 &&
            row!.finished,
        ),
      ),
    'redirect-same': () => redirected('redirect-same', 303),
    'redirect-other': () => redirected('redirect-other', 307),
    'redirect-http': () => redirected('redirect-http', 302),
    identity: () => {
      const ambient = exact('GET', labPath('ambient'), 2, ([seed, witness]) => {
        if (
          !seed!.authorizationMatchesFixture ||
          seed!.cookie ||
          witness!.authorization ||
          !json(seed!) ||
          !json(witness!)
        )
          return 'FAIL';
        return witness!.cookie ? 'PASS' : 'NOT_RUN';
      });
      const isolated = exact('POST', labPath('identity'), 3, ([first, second, anonymous]) =>
        verdict(
          native(first!, 'first') &&
            native(second!, 'second') &&
            native(anonymous!) &&
            [first!, second!, anonymous!].every(json),
        ),
      );
      return ambient === 'FAIL' || isolated === 'FAIL'
        ? 'FAIL'
        : ambient === 'PASS' && isolated === 'PASS'
          ? 'PASS'
          : 'NOT_RUN';
    },
    'auth-challenge': () =>
      exact('POST', labPath('challenge'), 1, ([row]) =>
        verdict(native(row!) && row!.responseStatus === 401 && row!.headersSent),
      ),
    'post-loss': () =>
      exact('POST', labPath('lost-post'), 1, ([row]) =>
        verdict(native(row!) && completePost(row!) && mutation(row!)),
      ),
    'delete-loss': () =>
      exact('DELETE', session, 1, ([row]) => verdict(native(row!, 'first') && mutation(row!))),
    'cancel-retried-get': () => {
      const attempts = events.filter((event) => event.method === 'GET' && event.path === session);
      if (attempts.length > 2) return 'FAIL';
      const [lost, retry] = attempts;
      if (!lost) return 'NOT_RUN';
      if (!native(lost, 'first') || !mutation(lost)) return 'FAIL';
      if (!retry) return 'NOT_RUN';
      const stop = meta.length === 1 ? /STOP ([0-9]{13})$/.exec(meta[0]!.trim()) : null;
      if (!stop || lost.fixtureCutAtMs === undefined || retry.responseStartedAtMs === null)
        return 'NOT_RUN';
      const stoppedAt = Number(stop[1]);
      const closedAt = retry.startedAtMs + (retry.closedAfterMs ?? Infinity);
      return verdict(
        native(retry, 'first') &&
          retry.requestComplete &&
          lost.connectionId !== retry.connectionId &&
          lost.fixtureCutAtMs <= retry.startedAtMs &&
          retry.responseStartedAtMs <= stoppedAt &&
          stoppedAt <= closedAt &&
          closedAt - stoppedAt <= 1500 &&
          interrupted(retry),
      );
    },
  };

  const plan = phases[phase];
  const scenarios = plan.map((id) => {
    const client = app.observed.get(id);
    const wire = checks[id]();
    return {
      id,
      verdict:
        client === 'fail' || wire === 'FAIL'
          ? 'FAIL'
          : client === 'success' && wire === 'PASS'
            ? 'PASS'
            : 'NOT_RUN',
      wire,
    };
  });
  return {
    phase,
    appCompleted: app.done,
    connections: connections.length,
    requests: events.length,
    verdict:
      !noUnexpectedTraffic || scenarios.some((row) => row.verdict === 'FAIL')
        ? 'FAIL'
        : app.done && scenarios.every((row) => row.verdict === 'PASS')
          ? 'PASS'
          : 'NOT_RUN',
    scenarios,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , mode, phase, input, snapshot] = process.argv;
  if (!isPhase(phase) || !input) throw new Error('Invalid laboratory phase');
  if (mode === 'fixture') {
    const fixture = await startFixture(input, port, '127.0.0.1', {
      routes: routes(phase),
      primaryCertificate: phase === 'wrong-name' ? 'wrong' : 'server',
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => void fixture.close());
  } else if (mode === 'verify' && snapshot) {
    const report = verifyLaboratory(
      phase,
      readFileSync(input, 'utf8'),
      JSON.parse(readFileSync(snapshot, 'utf8')),
    );
    process.stdout.write(JSON.stringify(report) + '\n');
    process.exitCode = report.verdict === 'PASS' ? 0 : 1;
  } else {
    throw new Error('Invalid laboratory operation');
  }
}
