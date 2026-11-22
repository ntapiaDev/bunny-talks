import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('reports missing, duplicated and skipped evidence without stopping at the first failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bunny-https-evidence-'));
  const report = join(directory, 'app-results.txt');
  writeFileSync(report, 'START retry-status-post\nSTART cancel-before-start\n');
  const event = {
    destination: 'A',
    path: '/v1/https-qualification/retry-status',
    method: 'GET',
  };
  try {
    const check = spawnSync(
      process.execPath,
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        'qualification/verify-https-events.ts',
        'ios',
        report,
      ],
      {
        encoding: 'utf8',
        input: JSON.stringify([event, event]),
      },
    );
    expect(check.status).toBe(1);
    expect(check.stderr).toBe('');
    expect(check.stdout).toContain('FAIL retry-status-get expected-count-1 observed-count-2');
    expect(check.stdout).toContain('FAIL retry-status-post expected-count-1 observed-count-0');
    expect(check.stdout).toContain('NOT_RUN retry-status-delete expected-count-1 observed-count-0');
    expect(check.stdout).toContain('NOT_RUN cancel-before-start expected-count-0 observed-count-0');
    expect(check.stdout).toContain('PASS unexpected-requests expected-count-0 observed-count-0');
    expect(check.stdout).toMatch(/DONE \d+ passed, \d+ failed, \d+ not-run/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('rejects malformed evidence without printing its contents', () => {
  const marker = 'synthetic-secret-placeholder';
  const check = spawnSync(
    process.execPath,
    [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      'qualification/verify-https-events.ts',
      'ios',
    ],
    {
      encoding: 'utf8',
      input: marker,
    },
  );
  expect(check.status).toBe(1);
  expect(check.stderr).toBe('');
  expect(check.stdout).toBe('FAIL input expected-valid-evidence observed-unavailable-or-invalid\n');
  expect(check.stdout).not.toContain(marker);
});

const epoch = 1_800_000_000_000;
const prefix = '/v1/https-qualification';
function slow(path: string, startedAt: number, closedAt: number) {
  return {
    destination: 'A',
    method: 'GET',
    path: prefix + path,
    startedAtMs: epoch + startedAt,
    responseStarted: true,
    responseStartedAtMs: epoch + startedAt,
    closed: true,
    closedAfterMs: closedAt - startedAt,
    finished: false,
  };
}

type EvidenceRow = Omit<ReturnType<typeof slow>, 'responseStarted'> & {
  responseStarted?: boolean | undefined;
  requestedCoding?: string;
  responseCoding?: string;
  headersSent?: boolean;
  configuredFraming?: string;
  controlFraming?: string | undefined;
  controlCoding?: string | undefined;
  controlBody?: string;
  controlOversizeLength?: boolean;
  configuredOversizeLength?: boolean;
  heldLengthEnd?: string;
  fixtureCut?: boolean;
};

function checkTiming(rows: EvidenceRow[], evidence: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'bunny-https-timing-'));
  const report = join(directory, 'app-results.txt');
  try {
    writeFileSync(
      report,
      ['PASS identity-json', `TIMING clock ${epoch} ${epoch + 200}`, ...evidence].join('\n'),
    );
    const check = spawnSync(
      process.execPath,
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        'qualification/verify-https-events.ts',
        'ios',
        report,
      ],
      { encoding: 'utf8', input: JSON.stringify([slow('/json', 100, 100), ...rows]) },
    );
    expect(check.stderr).toBe('');
    expect(check.stdout).toContain('PASS clock expected-loopback-interval observed-in-interval');
    return check.stdout;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function signal(id: string, time: number, latest = time) {
  return `TIMING ${id} ${epoch + time} ${epoch + latest}`;
}

function native(
  id: string,
  lane = 1,
  ending = 'cancel:400,complete-cancelled:401,resolve-network:402',
) {
  return [`INVOKE ${id} ${lane}`, `NATIVE ${id} ${lane} execute:0,resume:1,first-data:2,${ending}`];
}

it('rejects the 2 ms close and distinguishes a held connection from a premature native outcome', () => {
  const id = 'cancel-during-body';
  const evidence = [`PASS ${id}`, signal(id, 1400), ...native(id)];
  expect(checkTiming([slow('/slow/cancel', 1000, 1002)], evidence)).toContain(
    'FAIL cancel-during-body-close expected-body-held-and-interrupted observed-premature-close',
  );
  expect(checkTiming([slow('/slow/cancel', 1000, 1350)], evidence)).toContain(
    'FAIL cancel-during-body-close expected-body-held-and-interrupted observed-close-before-trigger',
  );
  expect(checkTiming([slow('/slow/cancel', 1000, 1399)], evidence)).toContain(
    'NOT_RUN cancel-during-body-close expected-body-held-and-interrupted observed-trigger-boundary',
  );
  expect(checkTiming([slow('/slow/cancel', 1000, 1420)], evidence)).toContain(
    'PASS cancel-during-body-close expected-body-held-and-interrupted observed-in-window',
  );
  expect(
    checkTiming([slow('/slow/cancel', 1000, 1420)], [`PASS ${id}`, signal(id, 1400)]),
  ).toContain(
    'NOT_RUN cancel-during-body-close expected-body-held-and-interrupted observed-missing-native-trace',
  );
  expect(checkTiming([slow('/slow/cancel', 1000, 1420)], [`PASS ${id}`])).toContain(
    'NOT_RUN cancel-during-body-close expected-body-held-and-interrupted observed-unconfirmed-trigger-or-outcome',
  );
  expect(
    checkTiming(
      [slow('/slow/cancel', 1000, 1420)],
      [`FAIL ${id} expected-cancelled observed-response`, signal(id, 1400)],
    ),
  ).toContain(
    'FAIL cancel-during-body-close expected-body-held-and-interrupted observed-app-outcome-mismatch',
  );
});

it('requires a native timeout result and a connection held until its deadline', () => {
  const id = 'native-deadline';
  expect(
    checkTiming([slow('/slow/timeout', 1000, 1001)], [`PASS ${id}`, signal(id, 1800, 1803)]),
  ).toContain(
    'FAIL native-deadline-close expected-body-held-and-interrupted observed-premature-close',
  );
  expect(
    checkTiming(
      [slow('/slow/timeout', 1000, 1802)],
      [
        `PASS ${id}`,
        signal(id, 1800, 1803),
        ...native(id, 1, 'deadline:800,complete-cancelled:801,resolve-timeout:802'),
      ],
    ),
  ).toContain('PASS native-deadline-close expected-body-held-and-interrupted observed-in-window');
});

it('requires sustained overlap followed by both slots becoming available', () => {
  const one = 'capacity-cancel-one';
  const two = 'capacity-cancel-two';
  const evidence = [
    `PASS ${one}`,
    `PASS ${two}`,
    signal(one, 2600),
    signal(two, 2600),
    ...native('capacity-overflow'),
    ...native('capacity-overflow', 2),
  ];
  const first = slow('/slow/concurrency-one', 1000, 2620);
  const second = slow('/slow/concurrency-two', 1100, 2620);
  const reused = ['/reuse/one', '/reuse/two'].map((path) => ({
    ...slow(path, 2700, 2702),
    finished: true,
  }));
  expect(checkTiming([first, slow('/slow/concurrency-two', 2200, 2620)], evidence)).toContain(
    'FAIL capacity-overlap expected-overlap-at-least-750ms observed-insufficient-overlap',
  );
  expect(checkTiming([first, second, ...reused], evidence)).toContain(
    'FAIL capacity-recovery-after-interruption expected-both-slots-reused-after-close observed-recovery-unconfirmed',
  );
  const recovered = checkTiming(
    [first, second, ...reused],
    [...evidence, 'PASS capacity-slots-recovered'],
  );
  expect(recovered).toContain(
    'PASS capacity-overlap expected-overlap-at-least-750ms observed-sustained-overlap',
  );
  expect(recovered).toContain(
    'PASS capacity-recovery-after-interruption expected-both-slots-reused-after-close observed-both-recovered',
  );
});

it('requires proof of the wire coding and discriminates stripped coding from unsafe identity acceptance', () => {
  const id = 'gzip-exact';
  const known = {
    ...slow('/gzip-exact', 1000, 1002),
    requestedCoding: 'identity',
    responseCoding: 'gzip',
    headersSent: true,
  };
  expect(
    checkTiming(
      [known],
      [
        `PASS ${id}`,
        `INVOKE ${id} 1`,
        `NATIVE ${id} 1 execute:0,headers:1,coding-absent:1,reject-coding:1,complete-cancelled:2,resolve-response:2`,
      ],
    ),
  ).toContain(
    'NOT_RUN gzip-exact-coding-native expected-visible-coding-refused-without-delivery observed-hidden-coding-refused',
  );
  expect(
    checkTiming(
      [known],
      [
        `PASS ${id}`,
        `INVOKE ${id} 1`,
        `NATIVE ${id} 1 execute:0,headers:1,coding-identity:1,allow:1,resolve-success:2`,
      ],
    ),
  ).toContain(
    'FAIL gzip-exact-coding-native expected-visible-coding-refused-without-delivery observed-unexpected-native-outcome',
  );
  expect(checkTiming([{ ...known, headersSent: false }], [])).toContain(
    'NOT_RUN gzip-exact-coding-wire expected-gzip observed-missing-headers',
  );
});

it('attributes three HTTP GET requests to a single application invocation', () => {
  const row = slow('/drop-before-headers', 1000, 1001);
  const output = checkTiming([row, row, row], ['START retry-drop-get', 'INVOKE retry-drop-get 1']);
  expect(output).toContain('FAIL retry-drop-get expected-count-1 observed-count-3');
  expect(output).toContain('PASS retry-drop-get-invocations expected-count-1 observed-count-1');
});

it('keeps the standard HTTP refusal blocking even when the artificial witness passes', () => {
  const standard = {
    ...slow('/coding-absent', 200, 201),
    requestedCoding: 'identity',
    responseCoding: 'absent',
    configuredFraming: 'length',
    headersSent: true,
    finished: true,
  };
  const gzip = { ...standard, path: prefix + '/coding-gzip', responseCoding: 'gzip' };
  const witness = {
    ...standard,
    path: prefix + '/identity-exact',
    responseCoding: 'identity',
  };
  const standardTrace = [
    'PASS standard-json',
    'INVOKE standard-json 1',
    'NATIVE standard-json 1 headers:1,coding-absent:1,reject-coding:1,resolve-response:2',
  ];
  const witnessTrace = [
    'PASS identity-exact',
    'INVOKE identity-exact 1',
    'NATIVE identity-exact 1 headers:1,coding-identity:1,allow:1,resolve-success:2',
  ];
  const gzipTrace = [
    'PASS forced-gzip-json',
    'INVOKE forced-gzip-json 1',
    'NATIVE forced-gzip-json 1 headers:1,coding-gzip:1,reject-coding:1,resolve-response:2',
  ];
  const evidence = [...standardTrace, ...witnessTrace, ...gzipTrace];
  const output = checkTiming([standard, gzip, witness], evidence);
  expect(output).toContain('PASS standard-json-coding-wire expected-absent observed-absent');
  expect(output).toContain(
    'PASS identity-exact-coding-native expected-identity-and-expected-outcome observed-confirmed',
  );
  expect(output).toContain(
    'FAIL standard-json-compatibility expected-usable-standard-http observed-profile-refused-standard-http',
  );
  expect(output).toContain(
    'PASS coding-distinguishability expected-distinct-standard-and-gzip observed-absent-vs-gzip',
  );

  const normalized = checkTiming(
    [standard, gzip],
    [
      ...standardTrace,
      ...gzipTrace.map((line) => line.replace('coding-gzip:1', 'coding-absent:1')),
    ],
  );
  expect(normalized).toContain(
    'FAIL coding-distinguishability expected-distinct-standard-and-gzip observed-same-delegate-coding',
  );
  expect(checkTiming([standard, gzip], standardTrace)).toContain(
    'NOT_RUN coding-distinguishability expected-distinct-standard-and-gzip observed-unconfirmed',
  );
  expect(checkTiming([standard, { ...gzip, headersSent: false }], evidence)).toContain(
    'NOT_RUN forced-gzip-json-coding-native expected-visible-coding-refused-without-delivery observed-wire-unconfirmed',
  );
});

it('preserves Swift event names through the app, shell and verifier while bounding the trace', () => {
  const swift = readFileSync('qualification/archive/urlsession/HttpsTransport.swift', 'utf8');
  const source = readFileSync('qualification/native-https-entry.tsx', 'utf8');
  const runner = readFileSync('qualification/archive/urlsession/run-ios-eas.sh', 'utf8');
  const pattern = new RegExp(/qualificationTracePattern =\s*\/([^/]+)\//.exec(source)![1]!);
  const filter = /sed -nE '([^']+)'/.exec(runner)![1]!;
  // Swift emits these finite categories as literals. The resolver adds the terminal category.
  const literals = [...swift.matchAll(/"([a-z][a-z0-9-]+)"/g)].map((match) => match[1]!);
  const categories = [
    ...new Set(
      literals.filter((tag) =>
        /^(allow$|body-|cancel$|coding-|complete-|deadline$|delegate-empty$|destroy$|execute$|expected-length-|first-data$|headers(?:$|-)|late-data$|length-|protocol-|redirect$|reject-|resume$|transactions-|transfer-)/.test(
          tag,
        ),
      ),
    ),
  ];
  expect(categories).toContain('reject-204-length');
  categories.push('map-coding-nonstring', 'map-length-ambiguous', 'map-transfer-unrecognized');
  for (const tag of categories) expect(pattern.test(`${tag}:1,resolve-response:2`)).toBe(true);
  const traces = Array.from({ length: Math.ceil(categories.length / 23) }, (_, index) =>
    [
      ...categories.slice(index * 23, (index + 1) * 23).map((tag) => `${tag}:1`),
      'resolve-response:2',
    ].join(','),
  );
  const missingSlotTrace = /qualificationTrace"\] = "([^"]+)"/.exec(swift)![1]!;
  traces.push(missingSlotTrace);
  for (const outcome of ['success', 'network', 'timeout', 'redirect', 'response', 'size']) {
    traces.push(`execute:0,resolve-${outcome}:1`);
  }
  for (const trace of traces) expect(pattern.test(trace)).toBe(true);
  const lines = traces.map((trace, index) => `NATIVE delete-204 ${index + 1} ${trace}`);
  const oversized = [...Array<string>(24).fill('headers:1'), 'resolve-response:2'].join(',');
  expect(pattern.test(oversized)).toBe(false);
  const filtered = execFileSync('sed', ['-nE', filter], {
    input: [
      ...lines,
      `NATIVE delete-204 99 ${oversized}`,
      'NATIVE delete-204 99 https://fixture.invalid',
    ]
      .map((line) => `log [BunnyHttpsQualification] ${line}\n`)
      .join(''),
    encoding: 'utf8',
  })
    .trimEnd()
    .split('\n');
  expect(filtered).toEqual(lines);
  expect(
    checkTiming([], [...lines.map((_, index) => `INVOKE delete-204 ${index + 1}`), ...filtered]),
  ).toContain('PASS native-traces expected-one-trace-per-invocation observed-complete');
});

it('requires independent framing and a phase-specific native size refusal', () => {
  const id = 'identity-oversize-length';
  const row = {
    ...slow('/' + id, 1000, 1010),
    headersSent: true,
    configuredFraming: 'length',
    controlFraming: 'length',
    controlOversizeLength: true,
    configuredOversizeLength: true,
    heldLengthEnd: 'peer-close',
  };
  const evidence = [
    'PASS ' + id,
    'INVOKE ' + id + ' 1',
    'NATIVE ' +
      id +
      ' 1 headers:1,length-valid:1,reject-size:1,delegate-empty:2,complete-cancelled:2,resolve-size:3',
    'PASS ' + id + '-recovery',
  ];
  const proof = checkTiming([row], evidence);
  for (const phase of ['decision', 'delegate', 'recovery'])
    expect(proof).toContain('PASS ' + id + '-' + phase);
  const closeCheck = id + '-close expected-peer-close-with-tail-held observed-';
  expect(proof).toContain('PASS ' + closeCheck + 'peer-close-after-prefix');
  for (const [change, observation] of [
    [{ responseStarted: false }, 'peer-close-without-prefix-evidence'],
    [{ responseStarted: undefined }, 'peer-close-without-prefix-evidence'],
    [{ heldLengthEnd: 'fixture-watchdog' }, 'fixture-watchdog'],
    [{ heldLengthEnd: 'socket-error' }, 'socket-error'],
  ] as const) {
    const unavailable = checkTiming([{ ...row, ...change }], evidence);
    expect(unavailable).toContain('NOT_RUN ' + closeCheck + observation);
    for (const phase of ['decision', 'delegate', 'recovery'])
      expect(unavailable).toContain('PASS ' + id + '-' + phase);
  }
  expect(checkTiming([{ ...row, finished: true, responseStarted: undefined }], [])).toContain(
    'FAIL ' + closeCheck + 'body-finished',
  );
  expect(
    checkTiming([{ ...row, heldLengthEnd: 'finished', responseStarted: false }], evidence),
  ).toContain('FAIL ' + closeCheck + 'body-finished');
  expect(checkTiming([row, { ...row, finished: true }], evidence)).toContain(
    'FAIL ' + closeCheck + 'body-finished',
  );
  const lateData = evidence.map((line) => line.replace('delegate-empty', 'late-data'));
  const data = checkTiming([row], lateData);
  expect(data).toContain('FAIL ' + id + '-delegate');
  expect(data).toContain('PASS ' + closeCheck + 'peer-close-after-prefix');
  const lostSocket = checkTiming(
    [{ ...row, responseStarted: false, heldLengthEnd: 'socket-error' }],
    lateData,
  );
  expect(lostSocket).toContain('FAIL ' + id + '-delegate');
  expect(lostSocket).toContain('NOT_RUN ' + closeCheck + 'socket-error');
  expect(
    checkTiming(
      [row],
      evidence.map((line) => line.replace('delegate-empty:2,', 'deadline:2,delegate-empty:2,')),
    ),
  ).toContain('NOT_RUN ' + id + '-close');
  expect(
    checkTiming(
      [row],
      evidence.map((line) => line.replace('delegate-empty:2,', '')),
    ),
  ).toContain('NOT_RUN ' + id + '-delegate');
  expect(checkTiming([{ ...row, controlFraming: undefined }], evidence)).toContain(
    'NOT_RUN ' + id + '-decision',
  );
  expect(
    checkTiming(
      [row],
      evidence.map((line) => line.replace('reject-size', 'body-size')),
    ),
  ).toContain('FAIL ' + id + '-decision');
  expect(
    checkTiming(
      [row],
      evidence.filter((line) => !line.startsWith('NATIVE ')),
    ),
  ).toContain('NOT_RUN ' + id + '-decision');
  const body = 'identity-oversize-error';
  const chunk = {
    ...row,
    path: prefix + '/' + body,
    configuredFraming: 'chunked',
    controlFraming: 'chunked',
  };
  const reading = [
    'PASS ' + body,
    'INVOKE ' + body + ' 1',
    'NATIVE ' +
      body +
      ' 1 allow:1,first-data:2,body-extra-one:3,body-size:3,complete-cancelled:4,resolve-size:5',
  ];
  expect(checkTiming([chunk], reading)).toContain('PASS ' + body + '-decision');
  expect(checkTiming([{ ...chunk, finished: true }], reading)).toContain(
    'FAIL ' + body + '-decision',
  );
});

it('requires the scripted interruption and rejects a pre-body transfer refusal as completeness evidence', () => {
  const id = 'chunked-incomplete-end';
  const row = {
    ...slow('/' + id, 1000, 1100),
    controlFraming: 'chunked',
    fixtureCut: true,
  };
  const trace = (sequence: string) => [
    'PASS ' + id,
    'INVOKE ' + id + ' 1',
    `NATIVE ${id} 1 ${sequence}`,
  ];
  const received = trace('allow:1,first-data:2,complete-error:100,resolve-response:101');
  expect(checkTiming([row], received)).toContain('PASS ' + id + '-decision');
  expect(checkTiming([{ ...row, fixtureCut: false }], received)).toContain(
    'FAIL ' + id + '-decision',
  );
  expect(
    checkTiming([row], trace('reject-transfer:1,complete-cancelled:2,resolve-response:3')),
  ).toContain('FAIL ' + id + '-decision');
});

it('correlates matrix headers and decisions without treating missing or divergent evidence as admission', () => {
  const id = 'chunked-complete';
  const row = {
    ...slow('/' + id, 1000, 1010),
    requestedCoding: 'identity',
    responseCoding: 'identity',
    headersSent: true,
    finished: true,
    configuredFraming: 'chunked',
    controlFraming: 'chunked',
    controlCoding: 'identity',
    controlBody: 'complete-match',
  };
  const tags =
    'headers:1,coding-identity:1,length-absent:1,transfer-chunked:1,' +
    'map-coding-identity:1,map-length-absent:1,map-transfer-chunked:1,headers-match:1,' +
    'expected-length-unknown:1,allow:1,first-data:2,transactions-one:3,protocol-http-one:3,' +
    'complete-ok:4,resolve-success:4';
  const evidence = (sequence = tags) => [
    'PASS ' + id,
    'INVOKE ' + id + ' 1',
    `NATIVE ${id} 1 ${sequence}`,
  ];
  expect(checkTiming([row], evidence())).toContain('PASS ' + id + '-matrix-native');
  expect(checkTiming([{ ...row, controlCoding: undefined }], evidence())).toContain(
    'NOT_RUN ' + id + '-matrix-native',
  );
  expect(checkTiming([{ ...row, controlBody: 'mismatch' }], evidence())).toContain(
    'FAIL ' + id + '-matrix-wire',
  );
  expect(checkTiming([row, row], evidence())).toContain('FAIL ' + id + '-matrix-wire');
  expect(checkTiming([row], evidence(tags.replace('headers-match', 'headers-diverge')))).toContain(
    'FAIL ' + id + '-matrix-native',
  );
  expect(
    checkTiming([row], evidence(tags.replace('map-transfer-chunked', 'map-transfer-identity'))),
  ).toContain('FAIL ' + id + '-matrix-native');
  expect(
    checkTiming([row], evidence(tags.replace('protocol-http-one', 'protocol-unconfirmed'))),
  ).toContain('NOT_RUN ' + id + '-matrix-native');
  expect(
    checkTiming([row], evidence(tags.replace('transactions-one', 'transactions-multiple'))),
  ).toContain('FAIL ' + id + '-matrix-native');
});
