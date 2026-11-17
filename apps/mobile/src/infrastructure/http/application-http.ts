export type HttpFailure =
  'configuration' | 'request' | 'network' | 'timeout' | 'redirect' | 'status' | 'response' | 'size';

export class ApplicationHttpError extends Error {
  public constructor(
    public readonly kind: HttpFailure,
    public readonly status?: number,
  ) {
    super(`HTTP ${kind}`);
    this.name = 'ApplicationHttpError';
  }
}

// The injected transport must refuse redirects before following them, omit ambient credentials,
// validate TLS normally, and yield decoded response bytes incrementally without buffering the body.
export type HttpTransport = (request: {
  url: string;
  method: 'GET' | 'POST' | 'DELETE';
  headers: Readonly<Record<string, string>>;
  body?: string;
  signal: AbortSignal;
  redirect: 'error';
  credentials: 'omit';
}) => Promise<{
  status: number;
  contentType: string | null;
  body: AsyncIterable<Uint8Array>;
}>;

export function createApplicationHttpClient(config: {
  origin: string;
  timeoutMs: number;
  maxResponseBytes: number;
  transport: HttpTransport;
}) {
  let origin: URL;
  try {
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

  return {
    async request(options: {
      path: string;
      method: 'GET' | 'POST' | 'DELETE';
      body?: unknown;
      bearerToken?: string;
      expectedStatuses: readonly number[];
    }): Promise<unknown> {
      if (
        !/^\/v1\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(options.path) ||
        !['GET', 'POST', 'DELETE'].includes(options.method) ||
        (options.method !== 'POST' && options.body !== undefined) ||
        !Array.isArray(options.expectedStatuses) ||
        options.expectedStatuses.length === 0 ||
        options.expectedStatuses.some(
          (status) => !Number.isInteger(status) || status < 200 || status > 299,
        ) ||
        (options.bearerToken !== undefined && !/^[A-Za-z0-9._~-]{1,512}$/.test(options.bearerToken))
      )
        throw new ApplicationHttpError('request');
      const headers: Record<string, string> = { Accept: 'application/json' };
      let body: string | undefined;
      if (options.body !== undefined) {
        try {
          body = JSON.stringify(options.body);
          if (body === undefined) throw new Error();
        } catch {
          throw new ApplicationHttpError('request');
        }
        headers['Content-Type'] = 'application/json';
      }
      if (options.bearerToken !== undefined)
        headers.Authorization = `Bearer ${options.bearerToken}`;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ApplicationHttpError('timeout'));
          controller.abort();
        }, timeoutMs);
      });
      const run = async (): Promise<unknown> => {
        const response = await transport({
          url: base + options.path,
          method: options.method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
        });
        if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599)
          throw new ApplicationHttpError('response');
        if (response.status >= 300 && response.status < 400)
          throw new ApplicationHttpError('redirect');
        if (!options.expectedStatuses.includes(response.status))
          throw new ApplicationHttpError('status', response.status);
        if (
          response.status !== 204 &&
          !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(response.contentType ?? '')
        )
          throw new ApplicationHttpError('response');
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of response.body) {
          if (!(chunk instanceof Uint8Array)) throw new ApplicationHttpError('response');
          size += chunk.byteLength;
          if (size > maxResponseBytes) throw new ApplicationHttpError('size');
          chunks.push(new Uint8Array(chunk));
        }
        if (response.status === 204) {
          if (size !== 0) throw new ApplicationHttpError('response');
          return undefined;
        }
        try {
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
        } catch {
          throw new ApplicationHttpError('response');
        }
      };
      try {
        return await Promise.race([run(), timeout]);
      } catch (error) {
        if (error instanceof ApplicationHttpError) throw error;
        throw new ApplicationHttpError('network');
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
      }
    },
  };
}
