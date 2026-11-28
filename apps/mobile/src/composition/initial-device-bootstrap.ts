import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToBase64 } from '@open-e2ee/signal-protocol-sdk/encoding';
import { initialVaultPublicationSchema, vaultOperationResultSchema } from '@bunny-talks/validation';
import type {
  BootstrapOperationRecord,
  BootstrapRejectionCode,
} from './bootstrap-operation-record';

type InitialVaultPublication = ReturnType<typeof initialVaultPublicationSchema.parse>;
type VaultOperationResult = ReturnType<typeof vaultOperationResultSchema.parse>;

export interface PreparedInitialBootstrap {
  readonly request: InitialVaultPublication;
  /** SHA-256 of the exact bytes returned by the local initialization attempt. */
  readonly candidateDigest: string;
}

/** A verifier must produce this binding only after opening the recovery envelope locally. */
export interface RecoveryKeyVerification {
  readonly method: 'account-vault-v1-recovery-open';
  readonly account: string;
  readonly vaultId: string;
  readonly publicationDigest: string;
  readonly recoveryRevision: 1;
}

/** Capability boundary for a real local recovery-key open; a boolean is not sufficient. */
export interface RecoveryKeyVerificationCapability {
  verifyRecoveryKey(input: {
    readonly account: string;
    readonly vaultId: string;
    readonly publicationBytes: Uint8Array;
    readonly recoveryKey: Uint8Array;
  }): Promise<RecoveryKeyVerification>;
}

/** Evidence produced only after opening the exact local publication with the activation password. */
export interface ActivationPasswordVerification {
  readonly method: 'account-vault-v1-password-open';
  readonly account: string;
  readonly vaultId: string;
  readonly publicationDigest: string;
}

/** A UI capability may return this only after an explicit user confirmation step. */
export interface RecoveryBackupConfirmation {
  readonly kind: 'user-confirmed-independent-recovery-backup';
  readonly account: string;
  readonly vaultId: string;
  readonly publicationDigest: string;
}

export interface RecoveryBackupConfirmationCapability {
  confirmRecoveryBackup(input: {
    readonly account: string;
    readonly vaultId: string;
    readonly publicationDigest: string;
  }): Promise<RecoveryBackupConfirmation | null>;
}

export class InitialBootstrapProtocolError extends Error {
  public constructor(readonly code: 'INVALID_INPUT' | 'DIVERGENT_RESULT') {
    super(`Initial bootstrap protocol: ${code}`);
    this.name = 'InitialBootstrapProtocolError';
  }
}

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function assemblePreparedInitialBootstrap(input: {
  readonly account: string;
  readonly vaultId: string;
  readonly operationId: string;
  readonly expectedCredentialRevision: string;
  readonly publicationBytes: Uint8Array;
}): PreparedInitialBootstrap {
  const request = {
    transportVersion: 1,
    operationId: input.operationId,
    account: input.account,
    vaultId: input.vaultId,
    expectedCredentialRevision: input.expectedCredentialRevision,
    expectedStorageRevision: null,
    publicationBase64Url: toBase64Url(input.publicationBytes),
  } satisfies InitialVaultPublication;
  const parsed = initialVaultPublicationSchema.safeParse(request);
  if (!parsed.success) throw new InitialBootstrapProtocolError('INVALID_INPUT');
  return Object.freeze({
    request: Object.freeze(parsed.data),
    candidateDigest: toBase64Url(sha256(input.publicationBytes)),
  });
}

/** Rebuilds the HTTP envelope from a validated journal record and its original publication. */
export function restorePreparedInitialBootstrap(
  operation: BootstrapOperationRecord,
  publicationBytes: Uint8Array,
): PreparedInitialBootstrap {
  const prepared = assemblePreparedInitialBootstrap({ ...operation, publicationBytes });
  if (prepared.candidateDigest !== operation.candidateDigest) {
    throw new InitialBootstrapProtocolError('DIVERGENT_RESULT');
  }
  return prepared;
}

/**
 * Builds the immutable HTTP envelope from the publication produced by local initialization.
 * Callers must persist the returned envelope before sending it and reuse it verbatim on recovery.
 */
export async function prepareInitialBootstrap(input: {
  readonly account: string;
  readonly vaultId: string;
  readonly operationId: string;
  readonly expectedCredentialRevision: string;
  readonly publicationBytes: Uint8Array;
  readonly recoveryKey: Uint8Array;
  readonly recoveryVerifier: RecoveryKeyVerificationCapability;
  readonly recoveryBackupConfirmation: RecoveryBackupConfirmationCapability;
}): Promise<PreparedInitialBootstrap> {
  if (
    !input ||
    typeof input !== 'object' ||
    !(input.publicationBytes instanceof Uint8Array) ||
    input.publicationBytes.byteLength === 0 ||
    input.publicationBytes.byteLength > 131_072 ||
    !(input.recoveryKey instanceof Uint8Array) ||
    input.recoveryKey.byteLength !== 32 ||
    typeof input.recoveryVerifier?.verifyRecoveryKey !== 'function' ||
    typeof input.recoveryBackupConfirmation?.confirmRecoveryBackup !== 'function'
  ) {
    throw new InitialBootstrapProtocolError('INVALID_INPUT');
  }
  const prepared = assemblePreparedInitialBootstrap(input);
  const confirmationCapability = input.recoveryBackupConfirmation;
  return verifyRecovery(
    prepared,
    Uint8Array.from(input.publicationBytes),
    input.recoveryKey,
    input.recoveryVerifier,
  ).then(() => confirmBackup(prepared, confirmationCapability));
}

async function verifyRecovery(
  prepared: PreparedInitialBootstrap,
  publicationBytes: Uint8Array,
  key: Uint8Array,
  verifier: RecoveryKeyVerificationCapability,
) {
  const recoveryKey = Uint8Array.from(key);
  try {
    const verification = await verifier.verifyRecoveryKey({
      account: prepared.request.account,
      vaultId: prepared.request.vaultId,
      publicationBytes: publicationBytes,
      recoveryKey,
    });
    if (
      !verification ||
      verification.method !== 'account-vault-v1-recovery-open' ||
      verification.account !== prepared.request.account ||
      verification.vaultId !== prepared.request.vaultId ||
      verification.publicationDigest !== prepared.candidateDigest ||
      verification.recoveryRevision !== 1
    ) {
      throw new InitialBootstrapProtocolError('INVALID_INPUT');
    }
  } catch (error) {
    if (error instanceof InitialBootstrapProtocolError) throw error;
    throw new InitialBootstrapProtocolError('INVALID_INPUT');
  } finally {
    recoveryKey.fill(0);
  }
}

async function confirmBackup(
  prepared: PreparedInitialBootstrap,
  confirmationCapability: RecoveryBackupConfirmationCapability,
) {
  try {
    const confirmation = await confirmationCapability.confirmRecoveryBackup({
      account: prepared.request.account,
      vaultId: prepared.request.vaultId,
      publicationDigest: prepared.candidateDigest,
    });
    if (
      !confirmation ||
      confirmation.kind !== 'user-confirmed-independent-recovery-backup' ||
      confirmation.account !== prepared.request.account ||
      confirmation.vaultId !== prepared.request.vaultId ||
      confirmation.publicationDigest !== prepared.candidateDigest
    ) {
      throw new InitialBootstrapProtocolError('INVALID_INPUT');
    }
  } catch (error) {
    if (error instanceof InitialBootstrapProtocolError) throw error;
    throw new InitialBootstrapProtocolError('INVALID_INPUT');
  }

  return prepared;
}

export type InitialBootstrapOutcome =
  | { readonly status: 'unknown' }
  | {
      readonly status: 'rejected';
      readonly result: Extract<VaultOperationResult, { status: 'rejected' }> & {
        readonly code: BootstrapRejectionCode;
      };
    }
  | {
      readonly status: 'conflict';
      readonly result: Extract<VaultOperationResult, { status: 'rejected' }>;
    }
  | {
      readonly status: 'committed';
      readonly result: Extract<VaultOperationResult, { status: 'committed' }>;
    };

/** Validates the real shared response contract and binds terminal results to the saved request. */
export function validateInitialBootstrapResult(
  value: unknown,
  prepared: PreparedInitialBootstrap,
): InitialBootstrapOutcome {
  const parsed = vaultOperationResultSchema.safeParse(value);
  if (!parsed.success) throw new InitialBootstrapProtocolError('DIVERGENT_RESULT');
  const result = parsed.data;
  if (result.status === 'unknown') return { status: 'unknown' };
  const identity = result.identity;
  if (
    identity.account !== prepared.request.account ||
    identity.operationId !== prepared.request.operationId ||
    identity.kind !== 'initial-publication' ||
    identity.expectedStorageRevision !== null ||
    identity.expectedCredentialRevision !== prepared.request.expectedCredentialRevision
  ) {
    throw new InitialBootstrapProtocolError('DIVERGENT_RESULT');
  }

  if (
    result.status === 'committed' &&
    (result.cas.storageRevision !== '1' ||
      result.publicationDigest !== prepared.candidateDigest ||
      result.cas.credentialRevision !== prepared.request.expectedCredentialRevision)
  ) {
    throw new InitialBootstrapProtocolError('DIVERGENT_RESULT');
  }
  if (result.status === 'rejected') {
    const { code } = result;
    if (code === 'IDEMPOTENCY_MISMATCH') return { status: 'conflict', result };
    return { status: 'rejected', result: { ...result, code } };
  }
  return { status: 'committed', result };
}
