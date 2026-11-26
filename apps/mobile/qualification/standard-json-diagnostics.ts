import { limit, requestTimeoutMs } from './standard-json-scenarios.ts';

const transportFailures = ['network', 'timeout', 'redirect', 'response', 'size'] as const;
const httpFailures = [
  ...transportFailures,
  'configuration',
  'request',
  'cancelled',
  'status',
] as const;
const nativeReasons = [
  'reservation',
  'request',
  'network',
  'tls',
  'deadline',
  'headers',
  'coding',
  'framing',
  'body',
  'redirect',
] as const;

function choice<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((item) => item === value);
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function integer(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

export const httpStatus = (value: unknown) => integer(value, 100, 599);
export const httpFailure = (value: unknown) => choice(value, httpFailures) ?? 'unexpected';

const reservations = ['not-called', 'refused', 'accepted', 'threw'] as const;
const nativeStates = ['not-called', 'pending', 'threw', 'invalid', 'rejected', 'success'] as const;
const adapterOutcomes = [...transportFailures, 'success'] as const;

export type CallDiagnostic = {
  reservation: (typeof reservations)[number];
  native: (typeof nativeStates)[number];
  nativeKind?: (typeof transportFailures)[number] | undefined;
  nativeReason?: (typeof nativeReasons)[number] | undefined;
  adapter?: (typeof adapterOutcomes)[number] | undefined;
  application?: ReturnType<typeof httpFailure> | undefined;
  status?: number | undefined;
  bytes?: number | undefined;
  nativeBytes?: number | undefined;
  nativeSettledAfterStartMs?: number | undefined;
};

export function describeNativeResult(raw: unknown): Omit<CallDiagnostic, 'reservation'> {
  const value = fields(raw);
  const data = value.bytes;
  const bytes =
    data instanceof Uint8Array || data instanceof ArrayBuffer ? data.byteLength : undefined;
  const status = httpStatus(value.status);
  if (value.ok === false && !('bytes' in value)) {
    return {
      native: 'rejected',
      nativeKind: choice(value.kind, transportFailures),
      nativeReason: choice(value.qualificationReason, nativeReasons),
      status: httpStatus(value.qualificationStatus),
      nativeBytes: integer(value.qualificationBytes, 0, limit + 1),
    };
  }
  return {
    native:
      value.ok === true &&
      bytes !== undefined &&
      status !== undefined &&
      (value.contentType === null || typeof value.contentType === 'string')
        ? 'success'
        : 'invalid',
    status,
    bytes: integer(bytes, 0, limit + 1),
  };
}

export function readDiagnostic(encoded: string | undefined) {
  if (!encoded || encoded.length > 2048) return undefined;
  try {
    const value = fields(JSON.parse(encoded));
    if (!Array.isArray(value.calls) || value.calls.length > 3) return undefined;
    const window = fields(value.retryWindow);
    const openedAtMs = integer(window.openedAtMs, 1, Number.MAX_SAFE_INTEGER);
    const settledAtMs = integer(window.settledAtMs, 1, Number.MAX_SAFE_INTEGER);
    return {
      failure: choice(value.failure, [...httpFailures, 'assertion', 'unexpected']),
      cancellationRequestedAfterStartMs: integer(
        value.cancellationRequestedAfterStartMs,
        0,
        requestTimeoutMs,
      ),
      retryWindow:
        openedAtMs !== undefined && settledAtMs !== undefined
          ? { openedAtMs, settledAtMs }
          : undefined,
      calls: value.calls.map((entry: unknown): CallDiagnostic => {
        const call = fields(entry);
        return {
          reservation: choice(call.reservation, reservations) ?? 'not-called',
          native: choice(call.native, nativeStates) ?? 'invalid',
          nativeKind: choice(call.nativeKind, transportFailures),
          nativeReason: choice(call.nativeReason, nativeReasons),
          adapter: choice(call.adapter, adapterOutcomes),
          application: choice(call.application, [...httpFailures, 'unexpected']),
          status: httpStatus(call.status),
          bytes: integer(call.bytes, 0, limit + 1),
          nativeBytes: integer(call.nativeBytes, 0, limit + 1),
          nativeSettledAfterStartMs: integer(call.nativeSettledAfterStartMs, 0, requestTimeoutMs),
        };
      }),
    };
  } catch {
    return undefined;
  }
}
