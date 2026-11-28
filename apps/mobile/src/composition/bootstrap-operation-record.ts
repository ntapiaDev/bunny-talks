import {
  databaseRevisionSchema,
  publicationDigestSchema,
  vaultOperationErrorCodeSchema,
} from '@bunny-talks/validation';
import type { BootstrapStoreContext } from '../infrastructure/crypto/bootstrap-operation-metadata';
import { validBootstrapStoreContext } from '../infrastructure/crypto/bootstrap-operation-metadata';

export interface InitialBootstrapContext extends BootstrapStoreContext {
  readonly sessionId: string;
}

const statuses = [
  'prepared',
  'emission-uncertain',
  'unknown',
  'rejected',
  'conflict',
  'committed',
] as const;
export type BootstrapOperationStatus = (typeof statuses)[number];

const rejectionCodeSchema = vaultOperationErrorCodeSchema.exclude(['IDEMPOTENCY_MISMATCH']);
export type BootstrapRejectionCode = ReturnType<typeof rejectionCodeSchema.parse>;

type RecordFields = InitialBootstrapContext & {
  readonly operationId: string;
  readonly expectedCredentialRevision: string;
  readonly candidateDigest: string;
};

export type BootstrapOperationRecord = RecordFields &
  (
    | { readonly version: 1; readonly status: BootstrapOperationStatus }
    | { readonly version: 2; readonly status: 'rejected'; readonly code: BootstrapRejectionCode }
  );

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validBootstrapContext(context: InitialBootstrapContext): boolean {
  return (
    validBootstrapStoreContext(context) &&
    typeof context.sessionId === 'string' &&
    uuidV4.test(context.sessionId)
  );
}

export function parseBootstrapOperationRecord(
  raw: string,
  context: InitialBootstrapContext,
): BootstrapOperationRecord | undefined {
  if (typeof raw !== 'string' || raw.length > 4096 || !validBootstrapContext(context)) return;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;

  const fields = value as Record<string, unknown>;
  const status = statuses.find((status) => status === fields.status);
  const revision = databaseRevisionSchema.safeParse(fields.expectedCredentialRevision);
  const digest = publicationDigestSchema.safeParse(fields.candidateDigest);
  if (
    fields.account !== context.account ||
    fields.device !== context.device ||
    fields.sessionId !== context.sessionId ||
    fields.vaultId !== context.vaultId ||
    typeof fields.operationId !== 'string' ||
    !uuidV4.test(fields.operationId) ||
    !status ||
    !revision.success ||
    !digest.success
  )
    return;

  const binding = {
    account: context.account,
    device: context.device,
    sessionId: context.sessionId,
    vaultId: context.vaultId,
    operationId: fields.operationId,
    expectedCredentialRevision: revision.data,
    candidateDigest: digest.data,
  };
  let record: BootstrapOperationRecord;
  if (fields.version === 1) {
    record = { version: 1, ...binding, status };
  } else {
    const code = rejectionCodeSchema.safeParse(fields.code);
    if (fields.version !== 2 || status !== 'rejected' || !code.success) return;
    record = { version: 2, ...binding, status, code: code.data };
  }
  // Accept only the exact representation written by the journal, including legacy V1 records.
  return JSON.stringify(record) === raw ? Object.freeze(record) : undefined;
}
