import { parseVault, revisions } from './account-vault-format.js';
import type { KeyEnvelopeContext } from './key-envelopes.js';

type Cas = Readonly<{ storageRevision: string; credentialRevision: string }>;
type Failure =
  | 'INVALID_INPUT'
  | 'INVALID_PUBLICATION'
  | 'ALREADY_EXISTS'
  | 'VERSION_CONFLICT'
  | 'INVALID_TRANSITION';
type Result =
  | { readonly ok: true; readonly status: 'structural-only-unauthenticated' }
  | { readonly ok: false; readonly code: Failure };
const fail = (code: Failure): Result => ({ ok: false, code });
const validRevision = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const validCas = (cas: Cas) =>
  cas && validRevision(cas.storageRevision) && validRevision(cas.credentialRevision);
const success: Result = Object.freeze({ ok: true, status: 'structural-only-unauthenticated' });
/** Evaluates only structure; caller must enforce authorization and commit CAS atomically. */
export function evaluateInitialVaultPublication(
  input: Uint8Array,
  context: KeyEnvelopeContext,
  activeVaultExists: boolean,
  expectedStorageRevision: null,
  expectedCredentialRevision: string,
  currentCredentialRevision: string,
): Result {
  if (
    typeof activeVaultExists !== 'boolean' ||
    expectedStorageRevision !== null ||
    !validRevision(expectedCredentialRevision) ||
    !validRevision(currentCredentialRevision)
  )
    return fail('INVALID_INPUT');
  if (activeVaultExists) return fail('ALREADY_EXISTS');
  if (expectedCredentialRevision !== currentCredentialRevision) return fail('VERSION_CONFLICT');
  try {
    const r = revisions(parseVault(input, context));
    if (
      r.generation !== 1 ||
      r.contentRevision !== 1 ||
      r.passwordRevision !== 1 ||
      r.recoveryRevision !== 1
    )
      return fail('INVALID_TRANSITION');
    return success;
  } catch {
    return fail('INVALID_PUBLICATION');
  }
}
/** Validates structural invariants only; no MAC verification or persistence. */
export function evaluatePasswordVaultTransition(
  previous: Uint8Array,
  candidate: Uint8Array,
  context: KeyEnvelopeContext,
  expected: Cas,
  current: Cas,
): Result {
  if (!validCas(expected) || !validCas(current)) return fail('INVALID_INPUT');
  if (
    expected.storageRevision !== current.storageRevision ||
    expected.credentialRevision !== current.credentialRevision
  )
    return fail('VERSION_CONFLICT');
  if (
    BigInt(current.storageRevision) === 9223372036854775807n ||
    BigInt(current.credentialRevision) === 9223372036854775807n
  )
    return fail('INVALID_TRANSITION');
  try {
    const old = parseVault(previous, context);
    const next = parseVault(candidate, context);
    const a = revisions(old);
    const b = revisions(next);
    if (
      a.generation === Number.MAX_SAFE_INTEGER ||
      a.passwordRevision === Number.MAX_SAFE_INTEGER ||
      b.generation !== a.generation + 1 ||
      b.passwordRevision !== a.passwordRevision + 1 ||
      b.contentRevision !== a.contentRevision ||
      b.recoveryRevision !== a.recoveryRevision ||
      old.publication.content !== next.publication.content ||
      old.publication.recoveryEnvelope !== next.publication.recoveryEnvelope ||
      old.publication.header.format !== next.publication.header.format ||
      old.publication.header.suite !== next.publication.header.suite ||
      old.publication.header.version !== next.publication.header.version
    )
      return fail('INVALID_TRANSITION');
    return success;
  } catch {
    return fail('INVALID_PUBLICATION');
  }
}

type OperationIdentity = Readonly<{
  account: string;
  operationId: string;
  kind: 'initial-publication' | 'ordinary-password-change';
  expectedStorageRevision: string | null;
  expectedCredentialRevision: string;
  fingerprint: string;
}>;
type OperationReceipt =
  | Readonly<{ identity: OperationIdentity; status: 'committed' }>
  | Readonly<{ identity: OperationIdentity; status: 'rejected'; code: Failure }>;
/** Pure replay classification; authorization and protected fingerprint computation are external. */
export function classifyVaultOperationReplay(
  request: OperationIdentity,
  receipt: OperationReceipt | null,
): 'unknown' | 'committed' | 'rejected' | 'mismatch' {
  if (!receipt) return 'unknown';
  return request.account === receipt.identity.account &&
    request.operationId === receipt.identity.operationId &&
    request.kind === receipt.identity.kind &&
    request.expectedStorageRevision === receipt.identity.expectedStorageRevision &&
    request.expectedCredentialRevision === receipt.identity.expectedCredentialRevision &&
    request.fingerprint === receipt.identity.fingerprint
    ? receipt.status
    : 'mismatch';
}
