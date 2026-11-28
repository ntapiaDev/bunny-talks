type HttpTransportFailure = 'network' | 'timeout' | 'redirect' | 'response' | 'size';

export type HttpFailure =
  'configuration' | 'request' | 'cancelled' | 'status' | HttpTransportFailure;

export class ApplicationHttpError extends Error {
  public constructor(
    public readonly kind: HttpFailure,
    public readonly status?: number,
  ) {
    super(`HTTP ${kind}`);
    this.name = 'ApplicationHttpError';
  }
}

type HttpMethod = 'GET' | 'POST' | 'DELETE';

type HttpTransportResult =
  | {
      ok: true;
      status: number;
      contentType: string | null;
      body: Uint8Array;
    }
  | { ok: false; kind: HttpTransportFailure };

export interface ApplicationHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * The adapter must use HTTPS with platform TLS and hostname verification, refuse redirects
 * before following them, omit ambient credentials (including cookie storage and authentication
 * challenges) and private caching. Authorization comes only from the supplied headers.
 * Never retry at the application layer. A qualified native profile may transparently resume
 * an explicitly authorized GET on a network or framing error before delivering a response.
 * Keep the same origin, path, Bearer, deadline and cancellation signal within that operation.
 * Sensitive writes require protection against replay after delivery may have reached the server.
 *
 * Enforce maxResponseBytes on decoded bytes in native code before any body crosses into JS.
 * A profile may require unencoded HTTP responses and reject unexpected content codings.
 * Return only a complete body with stable bytes, or a failure code without details or partial data.
 * The deadline covers the whole transport operation, including queueing and body delivery.
 * Timeout and AbortSignal must stop native work and release resources, including during reads.
 * Release resources on completion, and keep request and response data out of diagnostics.
 */
export type HttpTransport = (request: {
  url: string;
  method: HttpMethod;
  headers: Readonly<Record<string, string>>;
  body?: string;
  maxResponseBytes: number;
  timeoutMs: number;
  signal: AbortSignal;
  redirect: 'error';
  credentials: 'omit';
  retry: 'never';
}) => Promise<HttpTransportResult>;

function readResponse(
  result: HttpTransportResult,
  expectedStatuses: readonly number[],
  maxResponseBytes: number,
): ApplicationHttpResponse {
  if (!result || typeof result !== 'object') throw new ApplicationHttpError('response');
  if (result.ok === false) {
    const { kind } = result;
    switch (kind) {
      case 'network':
      case 'timeout':
      case 'redirect':
      case 'response':
      case 'size':
        throw new ApplicationHttpError(kind);
      default:
        throw new ApplicationHttpError('network');
    }
  }
  if (result.ok !== true) throw new ApplicationHttpError('response');
  const { status, contentType, body } = result;
  if (!Number.isInteger(status) || status < 100 || status > 599)
    throw new ApplicationHttpError('response');
  if (status >= 300 && status < 400) throw new ApplicationHttpError('redirect');
  if (!(body instanceof Uint8Array)) throw new ApplicationHttpError('response');
  if (body.byteLength > maxResponseBytes) throw new ApplicationHttpError('size');
  if (!expectedStatuses.includes(status)) throw new ApplicationHttpError('status', status);
  if (status === 204) {
    if (body.byteLength !== 0) throw new ApplicationHttpError('response');
    return { status, body: undefined };
  }
  if (
    typeof contentType !== 'string' ||
    !/^application\/json(?:[ \t]*;[ \t]*charset=utf-8)?[ \t]*$/i.test(contentType)
  )
    throw new ApplicationHttpError('response');
  try {
    return {
      status,
      body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown,
    };
  } catch {
    throw new ApplicationHttpError('response');
  }
}

export function createApplicationHttpClient(config: {
  origin: string;
  timeoutMs: number;
  maxResponseBytes: number;
  transport: HttpTransport;
}) {
  let origin: URL;
  try {
    if (
      typeof config.origin !== 'string' ||
      !/^https:\/\/(?:\[[a-f0-9:.]+\]|[^:/?#\\%[\]\s@]+)(?::[0-9]+)?\/?$/i.test(config.origin)
    )
      throw new Error();
    origin = new URL(config.origin);
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash ||
      !origin.hostname ||
      !Number.isSafeInteger(config.timeoutMs) ||
      config.timeoutMs < 1 ||
      config.timeoutMs > 120_000 ||
      !Number.isSafeInteger(config.maxResponseBytes) ||
      config.maxResponseBytes < 1 ||
      config.maxResponseBytes > 1_048_576 ||
      typeof config.transport !== 'function'
    )
      throw new Error();
  } catch {
    throw new ApplicationHttpError('configuration');
  }
  const base = origin.origin;
  const { timeoutMs, maxResponseBytes, transport } = config;

  const execute = async (options: {
    path: string;
    method: HttpMethod;
    body?: unknown;
    bearerToken?: string;
    expectedStatuses: readonly number[];
    signal?: AbortSignal;
  }): Promise<ApplicationHttpResponse> => {
    const deadline = performance.now() + timeoutMs;
    if (!options || typeof options !== 'object') throw new ApplicationHttpError('request');
    const { path, method, body: input, expectedStatuses, signal } = options;
    const bearerToken = Object.hasOwn(options, 'bearerToken') ? options.bearerToken : undefined;
    if (
      typeof path !== 'string' ||
      !/^\/v1\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(path) ||
      !['GET', 'POST', 'DELETE'].includes(method) ||
      (method !== 'POST' && input !== undefined) ||
      !Array.isArray(expectedStatuses) ||
      (bearerToken !== undefined &&
        (typeof bearerToken !== 'string' || !/^[A-Za-z0-9._~-]{1,512}$/.test(bearerToken))) ||
      (signal !== undefined &&
        (typeof signal?.aborted !== 'boolean' ||
          typeof signal.addEventListener !== 'function' ||
          typeof signal.removeEventListener !== 'function'))
    )
      throw new ApplicationHttpError('request');
    const statuses = [...expectedStatuses];
    if (
      statuses.length === 0 ||
      statuses.some((status) => !Number.isInteger(status) || status < 200 || status > 299)
    )
      throw new ApplicationHttpError('request');
    if (signal?.aborted) throw new ApplicationHttpError('cancelled');

    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: string | undefined;
    if (input !== undefined) {
      try {
        body = JSON.stringify(input);
        if (body === undefined) throw new Error();
      } catch {
        throw new ApplicationHttpError('request');
      }
      headers['Content-Type'] = 'application/json';
    }
    if (bearerToken !== undefined) headers.Authorization = `Bearer ${bearerToken}`;
    if (signal?.aborted) throw new ApplicationHttpError('cancelled');
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) throw new ApplicationHttpError('timeout');

    const controller = new AbortController();
    const send = async (): Promise<HttpTransportResult> => {
      try {
        return await transport({
          url: base + path,
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          maxResponseBytes,
          timeoutMs: Math.ceil(remainingMs),
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          retry: 'never',
        });
      } catch {
        return { ok: false, kind: 'network' };
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      const interrupt = (kind: 'timeout' | 'cancelled') => {
        reject(new ApplicationHttpError(kind));
        controller.abort();
      };
      cancel = () => interrupt('cancelled');
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => interrupt('timeout'), Math.ceil(remainingMs));
    });
    try {
      const result = await Promise.race([interrupted, send()]);
      if (performance.now() >= deadline) throw new ApplicationHttpError('timeout');
      const response = readResponse(result, statuses, maxResponseBytes);
      if (performance.now() >= deadline) throw new ApplicationHttpError('timeout');
      return response;
    } finally {
      clearTimeout(timer);
      if (cancel) signal?.removeEventListener('abort', cancel);
      controller.abort();
    }
  };
  return {
    async request(options: Parameters<typeof execute>[0]): Promise<unknown> {
      return (await execute(options)).body;
    },
    requestWithStatus(options: Parameters<typeof execute>[0]): Promise<ApplicationHttpResponse> {
      return execute(options);
    },
  };
}
