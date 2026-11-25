export const prefix = '/v1/https-qualification/curl/';
export const limit = 1_048_576;
export const fixturePort = 29_443;
export const runtimeProfile =
  'libcurl/8.23.0 OpenSSL/3.5.9 AppleSecTrust AsynchDNS HTTP/1.1 system-zlib';

export type Method = 'GET' | 'POST' | 'DELETE';

type Result =
  | 'json'
  | 'exact'
  | 'empty'
  | 'invalid-utf8'
  | 'network'
  | 'response'
  | 'size'
  | 'redirect'
  | 'status';
export type Destination = 'A' | 'B' | 'C' | 'unknown' | 'wrong' | 'stalled-tls';
type Wire = 'complete' | 'cut' | 'reject' | 'held' | 'none';

export type Probe = {
  id: string;
  route: string;
  outcome: Result;
  wire: Wire;
  method: Method;
  destination: Destination;
  framing?: 'length' | 'chunked';
  coding?: 'identity' | 'absent' | 'gzip' | 'other' | 'stacked';
  bearer?: true;
  cookie?: {
    client: 'fetch' | 'native';
    receives: 'none' | 'ambient';
    sets: 'none' | 'ambient' | 'native';
    needs?: string;
  };
};

function probe(
  id: string,
  route: string,
  outcome: Result,
  wire: Wire = 'complete',
  fields: Partial<Omit<Probe, 'id' | 'route' | 'outcome' | 'wire'>> = {},
): Probe {
  return { id, route, outcome, wire, method: 'GET', destination: 'A', ...fields };
}

function cookieProbe(id: string, step: string, cookie: NonNullable<Probe['cookie']>) {
  return probe(id, '/curl-cookies/' + step, 'json', 'complete', {
    framing: 'length',
    coding: 'identity',
    cookie,
  });
}

export const probes: readonly Probe[] = [
  probe('identity-json', '/json', 'json', 'complete', { framing: 'length', coding: 'identity' }),
  probe('post-body', '/request-body', 'json', 'complete', {
    method: 'POST',
    bearer: true,
    framing: 'length',
    coding: 'identity',
  }),
  probe('standard-json', '/coding-absent', 'json', 'complete', {
    framing: 'length',
    coding: 'absent',
  }),
  probe('gzip-json', '/coding-gzip', 'json', 'complete', { framing: 'length', coding: 'gzip' }),
  probe('chunked-json', '/chunked-complete', 'json', 'complete', {
    framing: 'chunked',
    coding: 'identity',
  }),
  probe('chunked-gzip', '/chunked-coding-gzip', 'json', 'complete', {
    framing: 'chunked',
    coding: 'gzip',
  }),
  probe('identity-exact', '/identity-exact', 'exact', 'complete', {
    framing: 'length',
    coding: 'identity',
  }),
  probe('gzip-exact', '/gzip-exact', 'exact', 'complete', { framing: 'length', coding: 'gzip' }),
  probe('chunked-exact', '/curl-chunked-exact', 'exact', 'complete', {
    framing: 'chunked',
    coding: 'identity',
  }),
  probe('identity-oversize', '/identity-oversize', 'size', 'held', {
    framing: 'chunked',
    coding: 'identity',
  }),
  probe('length-oversize', '/identity-oversize-length', 'size', 'held', {
    framing: 'length',
    coding: 'identity',
  }),
  probe('gzip-oversize', '/oversize', 'size', 'complete', { coding: 'gzip' }),
  probe('gzip-truncated', '/gzip-truncated', 'response', 'complete', {
    framing: 'length',
    coding: 'gzip',
  }),
  probe('gzip-crc', '/gzip-bad-crc', 'response', 'complete', { framing: 'length', coding: 'gzip' }),
  probe('gzip-concatenated', '/curl-gzip-concatenated', 'response', 'complete', {
    framing: 'length',
    coding: 'gzip',
  }),
  probe('chunked-incomplete', '/chunked-incomplete-end', 'response', 'cut'),
  probe('chunked-trailer', '/curl-chunked-trailer', 'response', 'complete', { framing: 'chunked' }),
  probe('length-short', '/length', 'response', 'cut', { framing: 'length' }),
  probe('length-conflict', '/curl-length-conflict', 'response', 'cut'),
  probe('length-and-chunked', '/curl-length-and-chunked', 'response', 'cut'),
  probe('unframed', '/unframed', 'response', 'complete'),
  probe('invalid-utf8', '/invalid-utf8', 'invalid-utf8', 'complete', {
    framing: 'length',
    coding: 'identity',
  }),
  probe('coding-other', '/coding-other', 'response', 'complete', {
    framing: 'length',
    coding: 'other',
  }),
  probe('coding-stacked', '/coding-stacked', 'response', 'complete', {
    framing: 'length',
    coding: 'stacked',
  }),
  probe('no-content', '/no-content', 'empty', 'complete', { method: 'DELETE' }),
  probe('tls-trusted-other-port', '/coding-absent', 'json', 'complete', { destination: 'B' }),
  probe('tls-unknown-ca', '/json', 'network', 'reject', { destination: 'unknown' }),
  probe('tls-wrong-host', '/json', 'network', 'reject', { destination: 'wrong' }),
  cookieProbe('cookie-fetch-baseline', 'baseline', {
    client: 'fetch',
    receives: 'none',
    sets: 'none',
  }),
  cookieProbe('cookie-fetch-seed', 'seed', {
    client: 'fetch',
    receives: 'none',
    sets: 'ambient',
    needs: 'cookie-fetch-baseline',
  }),
  cookieProbe('cookie-fetch-probe', 'expo-probe', {
    client: 'fetch',
    receives: 'ambient',
    sets: 'none',
    needs: 'cookie-fetch-seed',
  }),
  cookieProbe('cookie-native-probe', 'native-probe', {
    client: 'native',
    receives: 'none',
    sets: 'none',
    needs: 'cookie-fetch-probe',
  }),
  cookieProbe('cookie-native-set', 'native-set', {
    client: 'native',
    receives: 'none',
    sets: 'native',
    needs: 'cookie-fetch-probe',
  }),
  cookieProbe('cookie-native-probe-again', 'native-probe', {
    client: 'native',
    receives: 'none',
    sets: 'none',
    needs: 'cookie-native-set',
  }),
  cookieProbe('cookie-fetch-after', 'expo-after', {
    client: 'fetch',
    receives: 'ambient',
    sets: 'none',
    needs: 'cookie-native-set',
  }),
  probe('auth-challenge', '/challenge', 'status'),
  ...(['GET', 'POST', 'DELETE'] as const).flatMap((method) => {
    const name = method.toLowerCase();
    return [
      ...[301, 302, 303, 307, 308].flatMap((status) =>
        ['same', 'host', 'http'].map((target) =>
          probe(
            `redirect-${name}-${status}-${target}`,
            `/redirect/${status}/${target}`,
            'redirect',
            'complete',
            { method, bearer: true },
          ),
        ),
      ),
      probe('cut-' + name + '-before', '/curl-cut-before', 'network', 'cut', { method }),
      probe('cut-' + name + '-after', '/curl-cut-after', 'response', 'cut', {
        method,
        framing: 'length',
      }),
      probe('retry-' + name + '-503', '/retry-status-length', 'status', 'complete', {
        method,
        framing: 'length',
      }),
    ];
  }),
];

export const interruptions = [
  { id: 'cancel-tls', destination: 'stalled-tls', route: '/json', budgetMs: 400 },
  { id: 'cancel-reading', destination: 'A', route: '/slow/cancel-length', budgetMs: 400 },
  { id: 'client-abort', destination: 'A', route: '/slow/cancel', budgetMs: 400 },
  { id: 'deadline', destination: 'A', route: '/slow/timeout', budgetMs: 850 },
  { id: 'capacity', destination: 'A', route: '/slow/concurrency-one', budgetMs: 400 },
] as const;

export const localCases = ['cancel-before', 'expired-before', 'invalid-request'] as const;
export const memoryCases = ['memory-zero', 'memory-one', 'memory-two'] as const;
export const memoryPhases = ['baseline', 'active', 'retained', 'released', 'end'] as const;

export const plan: readonly string[] = [
  ...probes.map(({ id }) => id),
  ...localCases,
  ...interruptions.map(({ id }) => id),
  ...memoryCases,
];

export const runtimeRoutes = new Map([
  ...probes.map(({ id, route }) => [prefix + id, route] as const),
  ...localCases.map((id) => [prefix + id, '/json'] as const),
  ...interruptions.map(({ id, route }) => [prefix + id, route] as const),
  [prefix + 'capacity-two', '/slow/concurrency-two'],
  [prefix + 'capacity-refused', '/json'],
  [prefix + 'memory-one', '/curl-memory'],
  [prefix + 'memory-two', '/curl-memory'],
  [prefix + 'memory-two-peer', '/curl-memory'],
]);

const standardProbeIds = [
  'identity-json',
  'tls-trusted-other-port',
  'tls-unknown-ca',
  'tls-wrong-host',
  'post-body',
  'redirect-get-302-same',
  'redirect-post-307-host',
  'redirect-post-308-http',
  'cut-post-before',
  'cut-post-after',
  'retry-post-503',
  'gzip-exact',
  'gzip-oversize',
  'length-short',
  'chunked-incomplete',
  'gzip-truncated',
  'gzip-crc',
  'coding-other',
  'auth-challenge',
  'cookie-fetch-baseline',
  'cookie-fetch-seed',
  'cookie-fetch-probe',
  'cookie-native-probe',
  'cookie-native-set',
  'cookie-native-probe-again',
  'cookie-fetch-after',
  'standard-json',
] as const;

export const standardHttpsMarker = '[BunnyIosStandardHttps] ';
export const standardHttpsStartupMarker = '[BunnyIosCandidateStartup] ';

export function parseStandardHttpsLaunch(value: unknown) {
  if (typeof value !== 'string') return null;
  const match = /^(before|after):([a-f0-9]{32}):([a-f0-9]{32})$/.exec(value);
  return match && match[0] === value ? match : null;
}
export const standardHttpsReady = 'READY ApplicationHttps Release Hermes';
export const standardHttpsLocalCases = ['direct-http', 'expired-before'] as const;
export const standardHttpsProbes = standardProbeIds.map((id) => {
  const spec = probes.find((item) => item.id === id);
  if (!spec) throw new Error('Missing standard HTTPS scenario');
  return spec;
});
export const standardHttpsBefore = {
  ...standardHttpsProbes[0]!,
  outcome: 'network',
  wire: 'reject',
} satisfies Probe;
export const standardHttpsPlan = [
  ...standardHttpsProbes.slice(0, -1).map(({ id }) => id),
  ...standardHttpsLocalCases,
  ...interruptions.map(({ id }) => id),
  'standard-json',
];
export const standardHttpsRoutes = new Map(
  [...runtimeRoutes].filter(
    ([path]) =>
      standardHttpsPlan.some((id) => path === prefix + id) ||
      [prefix + 'capacity-two', prefix + 'capacity-refused'].includes(path),
  ),
);
standardHttpsRoutes.set(prefix + 'direct-http', '/json');
standardHttpsRoutes.set(prefix + 'gzip-oversize', '/standard-gzip-limit-plus-one');

export const fixturePost = '{"message":"fixture 🐰"}';
export const incompletePost = 'x'.repeat(256 * 1024);
export const fixtureText = '{"message":"Bonjour 🐰 — 日本語 — العربية"}';
// A quoted value that would parse as JSON if a decoder silently inserted a replacement character.
export const invalidUtf8ByteValues = [0x22, 0xc0, 0x22] as const;
// UTF-8 oracle independent of the Hermes text decoder used by the application client.
export const fixtureByteValues = [
  123, 34, 109, 101, 115, 115, 97, 103, 101, 34, 58, 34, 66, 111, 110, 106, 111, 117, 114, 32, 240,
  159, 144, 176, 32, 226, 128, 148, 32, 230, 151, 165, 230, 156, 172, 232, 170, 158, 32, 226, 128,
  148, 32, 216, 167, 217, 132, 216, 185, 216, 177, 216, 168, 217, 138, 216, 169, 34, 125,
] as const;
