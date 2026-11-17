import type { ApiDiagnosticResult } from '../../features/diagnostics/api-diagnostics';

const localAndroidUrl = 'http://10.0.2.2:3000/health/live';
const timeoutMs = 5000;

type Transport = (url: string, init: RequestInit) => Promise<Response>;

export function createLocalApiHealthCheck(options: {
  development: boolean;
  platform: string;
  fingerprint: string;
  transport: Transport;
}): () => Promise<ApiDiagnosticResult> {
  return async () => {
    if (
      !options.development ||
      options.platform !== 'android' ||
      !/^(?:google|generic)\/sdk_gphone[^/]*\//.test(options.fingerprint)
    )
      return 'unavailable';

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
        controller.abort();
      }, timeoutMs);
    });
    const request = async (): Promise<ApiDiagnosticResult> => {
      let response: Response;
      try {
        response = await options.transport(localAndroidUrl, {
          method: 'GET',
          credentials: 'omit',
          signal: controller.signal,
        });
      } catch {
        return 'network';
      }
      if (response.status !== 200 || (response.url && response.url !== localAndroidUrl))
        return 'http';
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return 'invalid';
      }
      if (
        typeof body !== 'object' ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !('status' in body) ||
        body.status !== 'ok'
      )
        return 'invalid';
      return 'success';
    };
    try {
      return await Promise.race([request(), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}
