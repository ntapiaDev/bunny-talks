export const prefix = '/v1/https-qualification/standard-json';
export const port = 29_443;
export const limit = 1_048_576;
export const requestTimeoutMs = 4500;
export const marker = '[BunnyHttpsStandardJson] ';
export const message = 'Bonjour 🐰 — 日本語 — العربية';
export const postBody = { message: 'fixture 🐰' };
export const firstBearer = 'fixture-only';
export const secondBearer = 'fixture-second';

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
  { id: 'chunked-valid', path: '/chunked-coding-absent', result: 'json' },
  { id: 'chunked-incomplete', path: '/truncated', result: 'reject' },
  { id: 'chunk-end-incomplete', path: '/chunked-incomplete-end', result: 'reject' },
  { id: 'close-delimited', path: '/unframed', result: 'reject' },
  { id: 'conflicting-lengths', path: '/length-conflict', result: 'reject' },
  { id: 'length-and-transfer', path: '/length-and-chunked', result: 'reject' },
  { id: 'limit-exact', path: '/identity-exact', result: 'exact' },
  { id: 'limit-progressive', path: '/identity-oversize', result: 'size' },
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

export const supplementalCases = ['reuse', 'identity-isolation', 'cancel-neighbour'] as const;
export const plan = [...probes.map(({ id }) => id), ...supplementalCases];
