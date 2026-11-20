import type { HttpTransport } from './application-http';

type TransportResult = Awaited<ReturnType<HttpTransport>>;
type TransportRequest = Parameters<HttpTransport>[0];

export interface ApplicationHttpsModule {
  reserve(timeoutMs: number): string | null;
  execute(
    id: string,
    url: string,
    method: TransportRequest['method'],
    headers: TransportRequest['headers'],
    body: string | null,
    limit: number,
  ): Promise<unknown>;
  cancel(id: string): void;
}

const network: TransportResult = { ok: false, kind: 'network' };
const timeout: TransportResult = { ok: false, kind: 'timeout' };
const invalidResponse: TransportResult = { ok: false, kind: 'response' };

function readNativeResult(value: unknown): TransportResult {
  if (value === null || typeof value !== 'object') return invalidResponse;
  if ('ok' in value && value.ok === false && 'kind' in value) {
    switch (value.kind) {
      case 'network':
      case 'timeout':
      case 'redirect':
      case 'response':
      case 'size':
        return { ok: false, kind: value.kind };
      default:
        return network;
    }
  }
  if (
    !('ok' in value) ||
    value.ok !== true ||
    !('bytes' in value) ||
    !('status' in value) ||
    typeof value.status !== 'number' ||
    !('contentType' in value) ||
    (value.contentType !== null && typeof value.contentType !== 'string')
  )
    return invalidResponse;

  const bytes = value.bytes;
  if (bytes instanceof Uint8Array)
    return { ok: true, status: value.status, contentType: value.contentType, body: bytes };
  if (bytes instanceof ArrayBuffer)
    return {
      ok: true,
      status: value.status,
      contentType: value.contentType,
      body: new Uint8Array(bytes),
    };
  return invalidResponse;
}

export function createNativeHttpsTransport(
  loadNative: () => ApplicationHttpsModule,
): HttpTransport {
  return async ({ url, method, headers, body, maxResponseBytes, timeoutMs, signal }) => {
    const deadline = performance.now() + timeoutMs;
    if (signal.aborted) return network;

    try {
      const native = loadNative();
      const remainingMs = Math.ceil(deadline - performance.now());
      if (remainingMs <= 0) return timeout;
      if (signal.aborted) return network;
      const id = native.reserve(remainingMs);
      if (id == null) return network;

      let abort: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (signal.aborted) return network;
        const remaining = deadline - performance.now();
        if (remaining <= 0) return timeout;
        const interrupted = new Promise<TransportResult>((resolve) => {
          abort = () => resolve(network);
          signal.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => resolve(timeout), Math.ceil(remaining));
        });
        if (signal.aborted) return network;
        const result = await Promise.race([
          interrupted,
          native
            .execute(id, url, method, headers, body ?? null, maxResponseBytes)
            .then(readNativeResult),
        ]);
        if (signal.aborted) return network;
        return performance.now() >= deadline ? timeout : result;
      } finally {
        if (abort) signal.removeEventListener('abort', abort);
        clearTimeout(timer);
        native.cancel(id);
      }
    } catch {
      if (signal.aborted) return network;
      return performance.now() >= deadline ? timeout : network;
    }
  };
}
