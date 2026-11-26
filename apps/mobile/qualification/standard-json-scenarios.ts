export const prefix = '/v1/https-qualification/standard-json';
export const port = 29_443;
export const limit = 1_048_576;
export const requestTimeoutMs = 4500;
export const cancelNeighbour = {
  abortAfterMs: 1000,
  firstHoldMs: 3000,
  neighbourHoldMs: 1800,
  maxCancellationLatencyMs: 700,
} as const;
export const marker = '[BunnyHttpsStandardJson] ';
export const message = 'Bonjour 🐰 — 日本語 — العربية';
export const postBody = { message: 'fixture 🐰' };
export const firstBearer = 'fixture-only';
export const secondBearer = 'fixture-second';

export const retryFramingFaults: ReadonlyMap<string, string> = new Map([
  ['/length', 'incomplete-length'],
  ['/chunked-coding-absent', 'unsupported-chunked'],
  ['/truncated', 'missing-final-chunk'],
  ['/chunked-incomplete-end', 'incomplete-chunk-terminator'],
  ['/unframed', 'close-delimited'],
  ['/length-conflict', 'conflicting-lengths'],
  ['/length-and-chunked', 'length-and-transfer'],
]);

type Scenario = {
  id: string;
  path: string;
  result:
    | 'json'
    | 'empty'
    | 'exact'
    | 'reject'
    | 'size'
    | 'lost-get'
    | 'status-503'
    | 'redirect'
    | 'auth'
    | 'network'
    | 'timeout';
  method?: 'POST';
  destination?: 'B' | 'unknown' | 'wrong';
  bearer?: string;
};

export const probes: readonly Scenario[] = [
  { id: 'standard-json', path: '/coding-absent', result: 'json' },
  { id: 'gzip', path: '/coding-gzip', result: 'reject' },
  { id: 'gzip-missing-isize', path: '/gzip-truncated', result: 'reject' },
  { id: 'gzip-chunked', path: '/chunked-coding-gzip', result: 'reject' },
  { id: 'other-coding', path: '/coding-other', result: 'reject' },
  { id: 'stacked-coding', path: '/coding-stacked', result: 'reject' },
  { id: 'length-incomplete', path: '/length', result: 'reject' },
  { id: 'chunked-valid-rejected', path: '/chunked-coding-absent', result: 'reject' },
  { id: 'chunked-incomplete', path: '/truncated', result: 'reject' },
  { id: 'chunk-end-incomplete', path: '/chunked-incomplete-end', result: 'reject' },
  { id: 'close-delimited', path: '/unframed', result: 'reject' },
  { id: 'conflicting-lengths', path: '/length-conflict', result: 'reject' },
  { id: 'length-and-transfer', path: '/length-and-chunked', result: 'reject' },
  { id: 'limit-exact', path: '/identity-exact', result: 'exact' },
  { id: 'limit-declared', path: '/identity-oversize-length', result: 'size' },
  { id: 'get-loss', path: '/loss-get', result: 'lost-get', bearer: firstBearer },
  { id: 'get-loss-repeated', path: '/loss-get-always', result: 'lost-get', bearer: firstBearer },
  { id: 'post-complete', path: '/request-body', result: 'json', method: 'POST' },
  { id: 'post-loss', path: '/loss-post', result: 'reject', method: 'POST' },
  { id: 'post-loss-prefix', path: '/loss-post-prefix', result: 'reject', method: 'POST' },
  { id: 'post-retry-status', path: '/retry-status-length', result: 'status-503', method: 'POST' },
  { id: 'tls-other-origin', path: '/json', result: 'json', destination: 'B' },
  { id: 'tls-untrusted', path: '/json', result: 'network', destination: 'unknown' },
  { id: 'tls-wrong-name', path: '/json', result: 'network', destination: 'wrong' },
  { id: 'redirect', path: '/redirect/307/host', result: 'redirect', bearer: firstBearer },
  { id: 'auth-challenge', path: '/challenge', result: 'auth' },
  { id: 'empty-204', path: '/no-content', result: 'empty' },
  { id: 'timeout', path: '/slow/timeout', result: 'timeout' },
];

export const supplementalCases = [
  'reuse',
  'identity-isolation',
  'cancel-neighbour',
  'session-delete',
  'framing-recovery',
  'cancel-retried-get',
] as const;
export const plan = [...probes.map(({ id }) => id), ...supplementalCases];
export const androidPlan = plan.filter((id) => id !== 'cancel-retried-get');

export const fixturePost = '{"message":"fixture 🐰"}';
export const fixtureText = '{"message":"Bonjour 🐰 — 日本語 — العربية"}';
// A quoted value that would parse as JSON if a decoder silently inserted a replacement character.
export const invalidUtf8ByteValues = [0x22, 0xc0, 0x22] as const;
// UTF-8 oracle independent of the Hermes text decoder used by the application client.
export const fixtureByteValues = [
  123, 34, 109, 101, 115, 115, 97, 103, 101, 34, 58, 34, 66, 111, 110, 106, 111, 117, 114, 32, 240,
  159, 144, 176, 32, 226, 128, 148, 32, 230, 151, 165, 230, 156, 172, 232, 170, 158, 32, 226, 128,
  148, 32, 216, 167, 217, 132, 216, 185, 216, 177, 216, 168, 217, 138, 216, 169, 34, 125,
] as const;
