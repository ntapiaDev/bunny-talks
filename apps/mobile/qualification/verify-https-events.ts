import { readFileSync } from 'node:fs';
import process from 'node:process';

type Event = {
  destination: string;
  path: string;
  method: string;
  authorization: boolean;
  authorizationMatchesFixture: boolean;
  cookie: boolean;
  expoFixtureCookie: boolean;
  nativeFixtureCookie: boolean;
  contentTypeIsJson: boolean;
  postBodyMatchesFixture: boolean;
  requestedCoding?: string;
  responseCoding?: string;
  configuredFraming?: string;
  controlFraming?: string;
  controlCoding?: string;
  controlOversizeLength?: boolean;
  configuredOversizeLength?: boolean;
  controlBody?: string;
  heldLengthEnd?: string;
  fixtureCut?: boolean;
  headersSent?: boolean;
  responseStarted: boolean;
  responseStartedAtMs: number | null;
  startedAtMs: number;
  closed: boolean;
  finished: boolean;
  closedAfterMs: number | null;
};

const ios = process.argv[2] === 'ios';
const appReport = process.argv[3];
const started = new Set<string>();
const appPassed = new Set<string>();
const appFailed = new Set<string>();
const timings = new Map<string, { earliest: number; latest: number }>();
const invocations = new Map<string, Set<number>>();
const traces = new Map<string, string[]>();
let identityProfile = false;
let events: Event[];
try {
  const input: unknown = JSON.parse(readFileSync(0, 'utf8'));
  if (
    !Array.isArray(input) ||
    input.length > 4096 ||
    input.some(
      (event) => !event || typeof event.path !== 'string' || typeof event.method !== 'string',
    )
  ) {
    throw new Error('invalid report');
  }
  events = input;
  if (appReport) {
    for (const line of readFileSync(appReport, 'utf8').split('\n')) {
      if (line === 'PROFILE identity') identityProfile = true;
      const native =
        /^(INVOKE|NATIVE) ([a-z0-9-]+) ([1-9][0-9]?)(?: ((?:[a-z][a-z0-9-]{0,27}:[0-9]{1,6},){0,23}[a-z][a-z0-9-]{0,27}:[0-9]{1,6}))?$/.exec(
          line,
        );
      if (native) {
        const [, type, id, lane, sequence] = native;
        const number = Number(lane);
        if (type === 'INVOKE' && !sequence) {
          const lanes = invocations.get(id!) ?? new Set<number>();
          if (lanes.has(number)) throw new Error('duplicate invocation evidence');
          lanes.add(number);
          invocations.set(id!, lanes);
        } else if (type === 'NATIVE' && sequence) {
          const key = id + '/' + lane;
          if (traces.has(key)) throw new Error('duplicate native evidence');
          let previous = -1;
          const tags = sequence.split(',').map((entry) => {
            const [tag, offset] = entry.split(':');
            const millis = Number(offset);
            if (millis < previous || millis > 120_000) throw new Error('invalid native timing');
            previous = millis;
            return tag!;
          });
          if (!/^resolve-(success|response|network|timeout|size|redirect)$/.test(tags.at(-1)!))
            throw new Error('missing native resolution');
          traces.set(key, tags);
        }
      }
      const match = /^(START|PASS) ([a-z0-9-]+)$/.exec(line);
      if (match?.[1] === 'START') started.add(match[2]!);
      if (match?.[1] === 'PASS') appPassed.add(match[2]!);
      const failed = /^FAIL ([a-z0-9-]+) /.exec(line);
      if (failed?.[1]) appFailed.add(failed[1]);
      const timing = /^TIMING ([a-z0-9-]+) ([0-9]{13}) ([0-9]{13})$/.exec(line);
      if (timing?.[1]) {
        const [id, earliest, latest] = [timing[1], Number(timing[2]), Number(timing[3])] as const;
        if (timings.has(id) || latest < earliest) throw new Error('invalid timing');
        timings.set(id, { earliest, latest });
      }
    }
  }
} catch {
  process.stdout.write('FAIL input expected-valid-evidence observed-unavailable-or-invalid\n');
  process.exit(1);
}

const prefix = '/v1/https-qualification';
const byPath = (path: string) => events.filter((event) => event.path === prefix + path);
const methods = ['DELETE', 'GET', 'POST'];
let passed = 0;
let failed = 0;
let notRun = 0;

function check(id: string, expected: string, observed: string, ok: boolean, ran = true) {
  const result = ok ? 'PASS' : ran ? 'FAIL' : 'NOT_RUN';
  if (result === 'PASS') passed++;
  else if (result === 'FAIL') failed++;
  else notRun++;
  process.stdout.write(`${result} ${id} expected-${expected} observed-${observed}\n`);
}

function count(id: string, observed: number, expected = 1) {
  const noEvidence = appReport && !started.has(id) && observed === 0;
  check(id, `count-${expected}`, `count-${observed}`, observed === expected, !noEvidence);
}

function property(id: string, rows: Event[], valid: boolean) {
  check(
    id,
    'match',
    rows.length === 0 ? 'no-event' : valid ? 'match' : 'mismatch',
    valid,
    rows.length > 0,
  );
}

function nativeTrace(id: string, lane = 1) {
  if (!invocations.get(id)?.has(lane)) return undefined;
  return traces.get(id + '/' + lane);
}

function onlyTag(trace: string[], pattern: RegExp) {
  const tags = trace.filter((tag) => pattern.test(tag));
  return tags.length === 1 ? tags[0] : undefined;
}

if (ios) {
  check(
    'identity-profile',
    'native-profile',
    identityProfile ? 'identity' : 'missing',
    identityProfile,
    identityProfile,
  );
  const observed = [...invocations].flatMap(([id, lanes]) =>
    [...lanes].map((lane) => id + '/' + lane),
  );
  const missing = observed.filter((key) => !traces.has(key)).length;
  const extra = [...traces.keys()].filter((key) => !observed.includes(key)).length;
  check(
    'native-traces',
    'one-trace-per-invocation',
    extra > 0
      ? 'unexpected-trace'
      : missing > 0
        ? 'missing-traces'
        : observed.length > 0
          ? 'complete'
          : 'no-invocations',
    missing === 0 && extra === 0 && observed.length > 0,
    extra > 0 || (missing === 0 && observed.length > 0),
  );

  const nativeRequests = events.filter(
    (event) =>
      event.method && !/\/cookies\/fixture\/(seed|expo-probe|expo-after)$/.test(event.path),
  );
  const wrongCoding = nativeRequests.some(
    (event) => event.requestedCoding !== undefined && event.requestedCoding !== 'identity',
  );
  const missingCoding = nativeRequests.some((event) => event.requestedCoding === undefined);
  check(
    'wire-request-coding',
    'identity-only',
    wrongCoding
      ? 'different-coding'
      : missingCoding || !nativeRequests.length
        ? 'no-observation'
        : 'identity',
    !wrongCoding && !missingCoding && nativeRequests.length > 0,
    wrongCoding || (!missingCoding && nativeRequests.length > 0),
  );
}

const sent = byPath('/request-body');
count('post-body', sent.length);
const [post] = sent;
property(
  'post-headers-and-body',
  sent,
  !!post &&
    post.method === 'POST' &&
    post.authorizationMatchesFixture &&
    post.contentTypeIsJson &&
    post.postBodyMatchesFixture,
);
const deleted = byPath('/no-content');
property('delete-204', deleted, deleted[0]?.method === 'DELETE');
count('oversize', byPath('/oversize').length, 2);
if (ios) {
  count('gzip-exact', byPath('/gzip-exact').length);
  for (const path of [
    'truncated',
    'length',
    'gzip-truncated',
    'gzip-bad-crc',
    'gzip-truncated-stream',
    'unframed',
  ])
    count(`framing-${path}`, byPath('/' + path).length);
}

if (ios) {
  for (const [path, framing, expected] of [
    ['/retry-status', 'chunked', 3],
    ['/retry-status-length', 'length', 1],
    ['/slow/cancel', 'chunked', 1],
    ['/slow/cancel-length', 'length', 1],
    ['/slow/timeout', 'chunked', 1],
    ['/slow/concurrency-one', 'chunked', 1],
    ['/slow/concurrency-two', 'chunked', 1],
    ['/identity-oversize', 'chunked', 2],
    ['/identity-oversize-error', 'chunked', 1],
    ['/identity-oversize-length', 'length', 1],
    ['/chunked-complete', 'chunked', 1],
    ['/truncated', 'chunked', 1],
    ['/chunked-incomplete-end', 'chunked', 1],
  ] as const) {
    const rows = byPath(path);
    // A separate Node client read the headers for this path/method on the same worker.
    // The incomplete terminator is written directly to the fixture socket.
    const scripted = path === '/chunked-incomplete-end';
    const wrong = rows.some(
      (row) =>
        (row.controlFraming !== undefined && row.controlFraming !== framing) ||
        (!scripted &&
          row.headersSent &&
          row.configuredFraming !== undefined &&
          row.configuredFraming !== framing),
    );
    const ok =
      rows.length === expected &&
      rows.every(
        (row) =>
          row.controlFraming === framing &&
          (scripted ? row.closed : row.headersSent && row.configuredFraming === framing),
      );
    check(
      'control-framing-' + path.slice(1).replace('/', '-'),
      framing,
      wrong ? 'different-framing' : ok ? framing : 'unconfirmed',
      ok,
      wrong || ok || rows.length > expected,
    );
  }

  for (const [id, path, decision, terminal] of [
    ['identity-oversize', '/identity-oversize', 'body-size', 'size'],
    ['identity-oversize-native', '/identity-oversize', 'body-size', 'size'],
    ['identity-oversize-error', '/identity-oversize-error', 'body-size', 'size'],
    ['chunked-complete', '/chunked-complete', 'complete-ok', 'success'],
    ['framing-truncated', '/truncated', 'complete-error', 'response'],
    ['chunked-incomplete-end', '/chunked-incomplete-end', 'complete-error', 'response'],
    ...methods.map(
      (method) =>
        [
          'retry-status-' + method.toLowerCase(),
          '/retry-status',
          'complete-ok',
          'success',
        ] as const,
    ),
  ] as const) {
    const trace = nativeTrace(id);
    const rows = byPath(path);
    const attempts =
      path === '/retry-status' ? rows.filter((row) => id.endsWith(row.method.toLowerCase())) : rows;
    const countExpected = path === '/identity-oversize' ? 2 : 1;
    const haveServer =
      attempts.length === countExpected &&
      attempts.every(
        (row) =>
          row.controlFraming === 'chunked' &&
          row.destination === 'A' &&
          (path === '/retry-status' || row.method === 'GET'),
      );
    const complete = terminal === 'success';
    const haveClosure =
      haveServer &&
      attempts.every(
        (row) =>
          typeof row.closed === 'boolean' &&
          typeof row.finished === 'boolean' &&
          (decision !== 'complete-error' || typeof row.fixtureCut === 'boolean'),
      );
    const serverOk =
      haveClosure &&
      attempts.every((row) => {
        if (complete) return row.finished;
        if (!(row.closed && !row.finished)) return false;
        return decision !== 'complete-error' || row.fixtureCut === true;
      });
    const decisionIndex = trace?.indexOf(decision) ?? -1;
    const data = trace?.indexOf('first-data') ?? -1;
    const allowed = trace?.indexOf('allow') ?? -1;
    const nativeOk =
      invocations.get(id)?.size === 1 &&
      trace?.at(-1) === 'resolve-' + terminal &&
      allowed >= 0 &&
      data > allowed &&
      decisionIndex > data &&
      !trace.some((tag) => tag.startsWith('reject-'));
    const progressive = decision !== 'body-size' || trace?.includes('body-extra-one');
    const ok = serverOk && nativeOk && progressive && appPassed.has(id);
    const failed =
      appFailed.has(id) ||
      (!!trace && !nativeOk) ||
      (haveClosure && !serverOk) ||
      attempts.length > countExpected;
    check(
      id + '-decision',
      decision,
      failed ? 'unexpected-outcome' : ok ? 'confirmed' : 'unconfirmed',
      !!ok && !failed,
      failed || !!ok,
    );
  }

  const sizeId = 'identity-oversize-length';
  const sizeRows = byPath('/' + sizeId);
  const [sizeRow] = sizeRows;
  const sizeTrace = nativeTrace(sizeId);
  const correctLength =
    sizeRows.length === 1 &&
    sizeRow?.destination === 'A' &&
    sizeRow.method === 'GET' &&
    sizeRow.headersSent === true &&
    sizeRow.configuredFraming === 'length' &&
    sizeRow.controlFraming === 'length' &&
    sizeRow.configuredOversizeLength === true &&
    sizeRow.controlOversizeLength === true;
  const reject = sizeTrace?.indexOf('reject-size') ?? -1;
  const completed = sizeTrace?.indexOf('complete-cancelled') ?? -1;
  const lengthIndex = sizeTrace?.indexOf('length-valid') ?? -1;
  const nativeRejected =
    invocations.get(sizeId)?.size === 1 &&
    lengthIndex >= 0 &&
    reject > lengthIndex &&
    completed > reject &&
    sizeTrace?.at(-1) === 'resolve-size' &&
    onlyTag(sizeTrace, /^reject-[a-z0-9-]+$/) === 'reject-size';
  const rejected =
    correctLength && nativeRejected && appPassed.has(sizeId) && !appFailed.has(sizeId);
  const refusalFailed =
    sizeRows.length > 1 ||
    appFailed.has(sizeId) ||
    (!!sizeTrace && !nativeRejected) ||
    sizeRow?.controlOversizeLength === false ||
    sizeRow?.configuredOversizeLength === false;
  check(
    sizeId + '-decision',
    'reject-size',
    refusalFailed ? 'unexpected-outcome' : rejected ? 'confirmed' : 'unconfirmed',
    rejected && !refusalFailed,
    rejected || refusalFailed,
  );

  const delivered =
    sizeTrace?.includes('allow') ||
    sizeTrace?.includes('first-data') ||
    sizeTrace?.includes('late-data');
  const emptyDelegate =
    rejected &&
    !delivered &&
    (sizeTrace?.indexOf('delegate-empty') ?? -1) > reject &&
    (sizeTrace?.indexOf('delegate-empty') ?? -1) < completed;
  check(
    sizeId + '-delegate',
    'no-body-callback',
    delivered ? 'delegate-admitted-or-received-data' : emptyDelegate ? 'empty' : 'unconfirmed',
    emptyDelegate,
    !!delivered || emptyDelegate,
  );

  const peerClosed =
    rejected &&
    !sizeTrace?.includes('deadline') &&
    !sizeTrace?.includes('cancel') &&
    sizeRow?.heldLengthEnd === 'peer-close' &&
    sizeRow.closed === true &&
    sizeRow.finished === false;
  const closedAfterPrefix = peerClosed && sizeRow.responseStarted === true;
  const finished = sizeRows.some(
    (row) => row.finished === true || row.heldLengthEnd === 'finished',
  );
  check(
    sizeId + '-close',
    'peer-close-with-tail-held',
    finished
      ? 'body-finished'
      : peerClosed
        ? closedAfterPrefix
          ? 'peer-close-after-prefix'
          : 'peer-close-without-prefix-evidence'
        : sizeRow?.heldLengthEnd === 'fixture-watchdog'
          ? 'fixture-watchdog'
          : sizeRow?.heldLengthEnd === 'socket-error'
            ? 'socket-error'
            : 'unconfirmed',
    closedAfterPrefix && !finished,
    closedAfterPrefix || finished,
  );

  const recoveryId = sizeId + '-recovery';
  const recovered = rejected && appPassed.has(recoveryId) && !appFailed.has(recoveryId);
  check(
    recoveryId,
    'two-slots-available',
    appFailed.has(recoveryId) ? 'unavailable' : recovered ? 'confirmed' : 'unconfirmed',
    recovered,
    recovered || appFailed.has(recoveryId),
  );

  for (const [id, path, framing, coding] of [
    ['chunked-coding-absent', '/chunked-coding-absent', 'chunked', 'absent'],
    ['chunked-complete', '/chunked-complete', 'chunked', 'identity'],
    ['chunked-coding-gzip', '/chunked-coding-gzip', 'chunked', 'gzip'],
    ['standard-json', '/coding-absent', 'length', 'absent'],
    ['identity-json', '/json', 'length', 'identity'],
    ['forced-gzip-json', '/coding-gzip', 'length', 'gzip'],
  ] as const) {
    const rows = byPath(path);
    const [row] = rows;
    const wire =
      rows.length === 1 &&
      row?.destination === 'A' &&
      row.method === 'GET' &&
      row.headersSent === true &&
      row.requestedCoding === 'identity' &&
      row.configuredFraming === framing &&
      row.responseCoding === coding &&
      row.controlFraming === framing &&
      row.controlCoding === coding &&
      row.controlBody === 'complete-match';
    const different =
      rows.length > 1 ||
      (!!row &&
        (row.destination !== 'A' ||
          row.method !== 'GET' ||
          (row.controlFraming !== undefined && row.controlFraming !== framing) ||
          (row.controlCoding !== undefined && row.controlCoding !== coding) ||
          (row.controlBody !== undefined && row.controlBody !== 'complete-match') ||
          (row.headersSent === true &&
            ((row.configuredFraming !== undefined && row.configuredFraming !== framing) ||
              (row.responseCoding !== undefined && row.responseCoding !== coding)))));
    check(
      id + '-matrix-wire',
      framing + '-' + coding,
      different ? 'unexpected-wire' : wire ? 'confirmed' : 'unconfirmed',
      wire && !different,
      wire || different,
    );

    const trace = nativeTrace(id);
    const comparison = trace && onlyTag(trace, /^headers-(match|diverge)$/);
    const lookupCoding = trace && onlyTag(trace, /^coding-(absent|identity|gzip|stacked|other)$/);
    const lookupLength = trace && onlyTag(trace, /^length-(absent|valid|invalid)$/);
    const lookupTransfer =
      trace &&
      onlyTag(trace, /^transfer-(absent|chunked|empty|whitespace|ows|identity|list|unrecognized)$/);
    const mapCoding =
      trace &&
      onlyTag(trace, /^map-coding-(absent|identity|gzip|stacked|other|ambiguous|nonstring)$/);
    const mapLength =
      trace && onlyTag(trace, /^map-length-(absent|valid|invalid|ambiguous|nonstring)$/);
    const mapTransfer =
      trace &&
      onlyTag(
        trace,
        /^map-transfer-(absent|chunked|empty|whitespace|ows|identity|list|unrecognized|ambiguous|nonstring)$/,
      );
    const metadata =
      trace &&
      mapCoding &&
      mapLength &&
      mapTransfer &&
      lookupCoding &&
      lookupLength &&
      lookupTransfer &&
      onlyTag(trace, /^expected-length-(unknown|over|within)$/);
    const conflict =
      !!metadata &&
      comparison === 'headers-match' &&
      (mapCoding !== 'map-' + lookupCoding ||
        mapLength !== 'map-' + lookupLength ||
        mapTransfer !== 'map-' + lookupTransfer);
    const protocol = trace && onlyTag(trace, /^protocol-(http-one|h2|h3|unconfirmed)$/);
    const transactions = trace && onlyTag(trace, /^transactions-(none|one|multiple)$/);
    const admissible = coding === 'identity';
    const decision = trace && onlyTag(trace, /^(allow|reject-[a-z0-9-]+)$/);
    const complete = trace && onlyTag(trace, /^complete-[a-z-]+$/);
    const allowedFraming =
      framing === 'chunked'
        ? lookupTransfer === 'transfer-chunked' && lookupLength === 'length-absent'
        : lookupTransfer === 'transfer-absent' && lookupLength === 'length-valid';
    const decisionIndex = trace && decision ? trace.indexOf(decision) : -1;
    const dataIndex = trace?.indexOf('first-data') ?? -1;
    const phase = admissible
      ? decision === 'allow' &&
        complete === 'complete-ok' &&
        trace?.at(-1) === 'resolve-success' &&
        dataIndex > decisionIndex &&
        trace.indexOf(complete) > dataIndex &&
        row?.finished === true &&
        comparison === 'headers-match' &&
        allowedFraming
      : decision === 'reject-coding' &&
        complete === 'complete-cancelled' &&
        trace?.at(-1) === 'resolve-response' &&
        trace.indexOf('delegate-empty') > decisionIndex &&
        trace.indexOf(complete) > trace.indexOf('delegate-empty') &&
        dataIndex < 0 &&
        !trace.includes('late-data') &&
        !trace.includes('allow');
    const confirmed =
      wire &&
      !!metadata &&
      !!comparison &&
      protocol === 'protocol-http-one' &&
      transactions === 'transactions-one' &&
      invocations.get(id)?.size === 1 &&
      lookupCoding === 'coding-' + coding &&
      phase &&
      appPassed.has(id) &&
      !appFailed.has(id);
    const mismatch =
      wire &&
      (appFailed.has(id) ||
        conflict ||
        (!!decision && decision !== (admissible ? 'allow' : 'reject-coding')) ||
        (admissible && decision === 'allow' && comparison === 'headers-diverge') ||
        (!!protocol && protocol !== 'protocol-unconfirmed' && protocol !== 'protocol-http-one') ||
        transactions === 'transactions-multiple' ||
        (invocations.get(id)?.size ?? 0) > 1);
    check(
      id + '-matrix-native',
      admissible ? 'admit-complete' : 'reject-coding',
      mismatch ? 'unexpected-outcome' : confirmed ? comparison! : 'unconfirmed',
      confirmed && !mismatch,
      confirmed || mismatch,
    );
  }
  const codingCases = [
    ['identity-json', '/json', 'identity'],
    ['standard-json', '/coding-absent', 'absent'],
    ['forced-gzip-json', '/coding-gzip', 'gzip'],
    ['identity-exact', '/identity-exact', 'identity'],
    ['identity-oversize', '/identity-oversize', 'identity', 2],
    ['retry-status-length-get', '/retry-status-length', 'identity'],
    ['gzip-exact', '/gzip-exact', 'gzip'],
    ['oversize', '/oversize', 'gzip', 2],
    ['framing-gzip-truncated', '/gzip-truncated', 'gzip'],
    ['framing-gzip-bad-crc', '/gzip-bad-crc', 'gzip'],
    ['framing-gzip-truncated-stream', '/gzip-truncated-stream', 'gzip'],
    ['framing-coding-other', '/coding-other', 'other'],
    ['framing-coding-stacked', '/coding-stacked', 'stacked'],
    ['retry-status-gzip', '/retry-status-gzip', 'gzip'],
  ] as const;
  const verifiedWire = new Set<string>();
  const rawCoding = (trace: string[] | undefined) => {
    const tags = trace?.filter((tag) => tag.startsWith('coding-'));
    return tags?.length === 1 ? tags[0]!.slice('coding-'.length) : undefined;
  };
  for (const [id, path, coding, expected = 1] of codingCases) {
    const rows = byPath(path).filter((event) => event.destination === 'A');
    const sent = rows.filter((event) => event.headersSent);
    const missingCoding = sent.some(
      (event) => event.requestedCoding === undefined || event.responseCoding === undefined,
    );
    const wrong = sent.some(
      (event) =>
        (event.requestedCoding !== undefined && event.requestedCoding !== 'identity') ||
        (event.responseCoding !== undefined && event.responseCoding !== coding),
    );
    const standard = id === 'standard-json';
    const wrongFraming =
      standard &&
      sent.some(
        (event) => event.configuredFraming !== undefined && event.configuredFraming !== 'length',
      );
    const incomplete =
      standard && sent.some((event) => !event.finished || event.configuredFraming === undefined);
    const proven =
      !wrong &&
      !wrongFraming &&
      !missingCoding &&
      !incomplete &&
      rows.length === expected &&
      sent.length === expected;
    if (proven) verifiedWire.add(id);
    check(
      id + '-coding-wire',
      coding,
      wrong
        ? 'different-coding'
        : wrongFraming
          ? 'different-framing'
          : rows.length > expected
            ? 'extra-requests'
            : missingCoding
              ? 'missing-coding'
              : sent.length < expected
                ? 'missing-headers'
                : incomplete
                  ? 'completion-unconfirmed'
                  : coding,
      proven,
      wrong || wrongFraming || rows.length > expected || proven,
    );

    if (standard) continue; // A standards-compliant response is not a forbidden coding.
    const scenarios =
      id === 'oversize'
        ? ['oversize-app', 'oversize-native']
        : id === 'identity-oversize'
          ? [id, 'identity-oversize-native']
          : [id];
    for (const scenario of scenarios) {
      const trace = nativeTrace(scenario);
      const exposed = rawCoding(trace);
      const forbidden = coding !== 'identity';
      const refused = trace?.includes('reject-coding') && trace.at(-1) === 'resolve-response';
      const expectedOutcome = id === 'identity-oversize' ? 'resolve-size' : 'resolve-success';
      const confirmed =
        proven &&
        exposed === coding &&
        (forbidden ? refused : trace?.at(-1) === expectedOutcome) &&
        appPassed.has(scenario);
      const failure =
        proven &&
        !!trace &&
        (appFailed.has(scenario) ||
          (forbidden &&
            (exposed === 'identity' ||
              trace.includes('allow') ||
              trace.at(-1) === 'resolve-success')));
      const observed = failure
        ? 'unexpected-native-outcome'
        : confirmed
          ? 'confirmed'
          : !proven
            ? 'wire-unconfirmed'
            : !trace
              ? 'missing-native-trace'
              : forbidden && exposed === 'absent' && refused
                ? 'hidden-coding-refused'
                : 'unconfirmed';
      check(
        scenario + '-coding-native',
        forbidden ? 'visible-coding-refused-without-delivery' : 'identity-and-expected-outcome',
        observed,
        !!confirmed && !failure,
        failure || !!confirmed,
      );
    }
  }

  const standard = nativeTrace('standard-json');
  const exposedStandard = rawCoding(standard);
  const exposedGzip = rawCoding(nativeTrace('forced-gzip-json'));
  const standardWire = verifiedWire.has('standard-json');
  const observedRefusal =
    standardWire &&
    exposedStandard === 'absent' &&
    standard?.includes('reject-coding') &&
    standard.at(-1) === 'resolve-response' &&
    appPassed.has('standard-json');
  const escapedRefusal =
    standardWire &&
    !!standard &&
    (standard.includes('allow') ||
      standard.at(-1) === 'resolve-success' ||
      appFailed.has('standard-json'));
  // A safe refusal in this experiment does not establish compatibility with standard HTTP.
  check(
    'standard-json-compatibility',
    'usable-standard-http',
    escapedRefusal
      ? 'unexpected-native-outcome'
      : observedRefusal
        ? 'profile-refused-standard-http'
        : 'unconfirmed',
    false,
    escapedRefusal || !!observedRefusal,
  );
  const comparable =
    standardWire &&
    verifiedWire.has('forced-gzip-json') &&
    exposedStandard !== undefined &&
    exposedGzip !== undefined;
  const same = comparable && exposedStandard === exposedGzip;
  const distinct = comparable && exposedStandard === 'absent' && exposedGzip === 'gzip';
  check(
    'coding-distinguishability',
    'distinct-standard-and-gzip',
    same ? 'same-delegate-coding' : distinct ? 'absent-vs-gzip' : 'unconfirmed',
    distinct,
    same || distinct,
  );
}

const destinations = events.filter((event) => event.path.endsWith('/destination'));
const expectedDestinations = ios ? ['A', 'B'] : ['A', 'B', 'C'];
const baseline = ['tls-origin-a', 'tls-origin-b', ...(ios ? [] : ['tls-http-control'])];
const hasControls = (!ios && !appReport) || baseline.every((id) => appPassed.has(id));
const matchesDestinations =
  destinations.map((event) => event.destination).join('') === expectedDestinations.join('');
check(
  'redirect-destinations',
  'only-controls',
  `count-${destinations.length}`,
  hasControls && matchesDestinations,
  hasControls || destinations.length > expectedDestinations.length,
);
for (const status of [301, 302, 303, 307, 308])
  for (const target of ['same', 'host', 'http']) {
    const sources = byPath(`/redirect/${status}/${target}`);
    for (const method of methods) {
      const id = `redirect-${method.toLowerCase()}-${status}-${target}`;
      const attempts = sources.filter((event) => event.method === method);
      count(id, attempts.length);
      property(
        `${id}-credentials`,
        attempts,
        attempts.length > 0 &&
          attempts.every((source) => source.authorizationMatchesFixture && !source.cookie),
      );
    }
  }

function noTraffic(id: string, rows: Event[]) {
  const ran = (!ios && !appReport) || appPassed.has(id);
  check(id, 'count-0', `count-${rows.length}`, ran && rows.length === 0, ran || rows.length > 0);
}
noTraffic(
  'tls-unknown-ca',
  events.filter((event) => event.destination === 'unknown'),
);
noTraffic(
  'tls-wrong-host',
  events.filter((event) => event.destination === 'wrong'),
);

const cookieEvents = events.filter((event) => event.path.startsWith(prefix + '/cookies/'));
const probe = cookieEvents.filter((event) => event.path.endsWith('/expo-probe'));
const after = cookieEvents.filter((event) => event.path.endsWith('/expo-after'));
property('cookies-expo-probe', probe, !!probe[0]?.expoFixtureCookie);
property('cookies-expo-after', after, after.length > 0 && !after[0]?.nativeFixtureCookie);
const nativeCookies = cookieEvents.filter((event) => /\/native-(probe|set)$/.test(event.path));
count('cookies-native-probes', nativeCookies.length, 3);
property(
  'cookies-native-isolation',
  nativeCookies,
  nativeCookies.length > 0 && nativeCookies.every((event) => !event.cookie && !event.authorization),
);
const challenges = byPath('/challenge');
count('auth-challenge', challenges.length);
property(
  'auth-challenge-credentials',
  challenges,
  challenges.length > 0 && challenges.every((event) => !event.authorization),
);

for (const [name, path] of [
  ['status', '/retry-status'],
  ['drop', '/drop-before-headers'],
]) {
  for (const method of methods) {
    const id = `retry-${name}-${method.toLowerCase()}`;
    count(id, byPath(path!).filter((event) => event.method === method).length);
    if (ios) {
      const total = invocations.get(id)?.size ?? 0;
      check(
        id + '-invocations',
        'count-1',
        `count-${total}`,
        total === 1,
        total > 0 || started.has(id),
      );
    }
  }
}
if (ios) count('retry-status-length-get', byPath('/retry-status-length').length);

for (const [id, path] of [
  ['cancel-before-start', '/cancel-before-start'],
  ['cancel-before-execute', '/cancel-before-execute'],
  ['invalid-native-request', '/invalid-native-request'],
  ['capacity-overflow', '/refused-over-capacity'],
] as const)
  noTraffic(id, byPath(path));
if (ios) {
  noTraffic('expired-before-execute', byPath('/expired-before-execute'));
  count('multipart', byPath('/multipart').length);
}
const stalled = events.filter((event) => event.destination === 'stalled-tls');
const isMillis = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const clock = timings.get('clock');
const clockControls = byPath('/json').filter((event) => event.destination === 'A');
const clockAligned =
  !!clock &&
  appPassed.has(ios ? 'identity-json' : 'json') &&
  clockControls.length === 1 &&
  clock.latest - clock.earliest <= 2000 &&
  isMillis(clockControls[0]!.startedAtMs) &&
  clockControls[0]!.startedAtMs >= clock.earliest &&
  clockControls[0]!.startedAtMs <= clock.latest;
if (ios)
  check(
    'clock',
    'loopback-interval',
    clockAligned ? 'in-interval' : 'unconfirmed',
    clockAligned,
    clockAligned,
  );

function closeTime(event: Event) {
  if (!event.closed || !isMillis(event.startedAtMs) || !isMillis(event.closedAfterMs))
    return undefined;
  return event.startedAtMs + event.closedAfterMs;
}

function checkInterruption(id: string, rows: Event[], minimumMs: number, tls = false) {
  count(id, rows.length);
  const [event] = rows;
  let observed = 'in-window';
  let ran = true;
  const ended = event && closeTime(event);
  const first = tls ? event?.startedAtMs : event?.responseStartedAtMs;
  if (!event) {
    observed = 'no-event';
    ran = false;
  } else if (rows.length !== 1) {
    observed = 'multiple-events';
  } else if (!tls && (!event.responseStarted || !isMillis(first) || first < event.startedAtMs)) {
    observed = 'no-body-start';
  } else if (event.finished) {
    observed = 'body-finished';
  } else if (ended === undefined || !isMillis(first) || ended - event.startedAtMs >= 2000) {
    observed = 'close-missing-or-late';
  } else if (ended - first < minimumMs) {
    observed = 'premature-close';
  } else if (ios) {
    const timing = timings.get(id);
    if (appFailed.has(id)) {
      observed = 'app-outcome-mismatch';
    } else if (
      !clockAligned ||
      !timing ||
      timing.latest - timing.earliest > 50 ||
      !appPassed.has(id)
    ) {
      observed = 'unconfirmed-trigger-or-outcome';
      ran = false;
    } else if (ended < timing.earliest - 25) {
      observed = 'close-before-trigger';
    } else if (first > timing.earliest || ended < timing.earliest) {
      observed = 'trigger-boundary';
      ran = false;
    } else if (ended > timing.latest + 800) {
      observed = 'close-too-late-after-trigger';
    }
  }
  if (ios && observed === 'in-window') {
    const capacity = id.startsWith('capacity-');
    const trace = nativeTrace(capacity ? 'capacity-overflow' : id, id.endsWith('-two') ? 2 : 1);
    if (!trace) {
      observed = 'missing-native-trace';
      ran = false;
    } else {
      const deadline = id === 'native-deadline';
      const trigger = trace.indexOf(
        deadline && !trace.includes('deadline')
          ? 'complete-timeout'
          : deadline
            ? 'deadline'
            : 'cancel',
      );
      const completed = trace.findIndex((tag) => tag.startsWith('complete-'));
      const firstData = trace.indexOf('first-data');
      if (
        trigger < 0 ||
        completed < trigger ||
        (!tls && (firstData < 0 || firstData >= trigger)) ||
        trace.at(-1) !== (deadline ? 'resolve-timeout' : 'resolve-network')
      ) {
        observed = 'native-interruption-unconfirmed';
      }
    }
  }
  const ok = observed === 'in-window';
  check(
    `${id}-close`,
    tls ? 'tls-held-and-interrupted' : 'body-held-and-interrupted',
    observed,
    ok,
    ran,
  );
  return ok;
}
checkInterruption('cancel-during-tls', stalled, 150, true);
checkInterruption('cancel-during-body', byPath('/slow/cancel'), 150);
if (ios) checkInterruption('cancel-during-length-body', byPath('/slow/cancel-length'), 150);
checkInterruption('native-deadline', byPath('/slow/timeout'), 350);
const oneOk = checkInterruption('capacity-cancel-one', byPath('/slow/concurrency-one'), 750);
const twoOk = checkInterruption('capacity-cancel-two', byPath('/slow/concurrency-two'), 750);
const one = byPath('/slow/concurrency-one')[0];
const two = byPath('/slow/concurrency-two')[0];
const oneEnd = one && closeTime(one);
const twoEnd = two && closeTime(two);
const overlap =
  isMillis(one?.responseStartedAtMs) &&
  isMillis(two?.responseStartedAtMs) &&
  oneEnd !== undefined &&
  twoEnd !== undefined
    ? Math.min(oneEnd, twoEnd) - Math.max(one.responseStartedAtMs, two.responseStartedAtMs)
    : undefined;
check(
  'capacity-overlap',
  'overlap-at-least-750ms',
  overlap === undefined
    ? 'missing-window'
    : overlap < 750
      ? 'insufficient-overlap'
      : oneOk && twoOk
        ? 'sustained-overlap'
        : 'interruptions-unconfirmed',
  overlap !== undefined && overlap >= 750 && oneOk && twoOk,
  overlap !== undefined && (overlap < 750 || (oneOk && twoOk)),
);
for (const name of ['one', 'two']) {
  const reused = byPath(`/reuse/${name}`);
  property(`capacity-reuse-${name}`, reused, reused.length === 1 && !!reused[0]?.finished);
}
if (ios) {
  const reused = ['/reuse/one', '/reuse/two'].map(byPath);
  const interrupted = oneOk && twoOk && overlap !== undefined && overlap >= 750;
  const recovered =
    appPassed.has('capacity-slots-recovered') &&
    oneEnd !== undefined &&
    twoEnd !== undefined &&
    reused.every(
      ([event, extra]) =>
        !extra && event?.finished && event.startedAtMs >= Math.max(oneEnd, twoEnd),
    );
  check(
    'capacity-recovery-after-interruption',
    'both-slots-reused-after-close',
    !interrupted
      ? 'interruptions-unconfirmed'
      : recovered
        ? 'both-recovered'
        : 'recovery-unconfirmed',
    interrupted && recovered,
    interrupted,
  );
}
const unexpected = events.filter(
  (event) =>
    event.path === '/unexpected' ||
    (event.destination !== 'stalled-tls' && !methods.includes(event.method)),
);
check(
  'unexpected-requests',
  'count-0',
  `count-${unexpected.length}`,
  events.length > 0 && unexpected.length === 0,
  events.length > 0,
);

process.stdout.write(`DONE ${passed} passed, ${failed} failed, ${notRun} not-run\n`);
process.exitCode = failed === 0 && notRun === 0 ? 0 : 1;
