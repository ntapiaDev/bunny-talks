import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type {
  InitialVaultPublication,
  OrdinaryPasswordChange,
  VaultOperationError,
  VaultOperationIdentity,
  VaultOperationResult,
  VaultReadState,
} from '@bunny-talks/contracts';
import {
  evaluateInitialVaultPublication,
  evaluatePasswordVaultTransition,
  validateAccountVault,
} from '@bunny-talks/crypto-backup';
import {
  initialVaultPublicationSchema,
  ordinaryPasswordChangeSchema,
  publicationDigestSchema,
  vaultCryptoRevisionsSchema,
  vaultOperationResultSchema,
  vaultReadStateSchema,
} from '@bunny-talks/validation';
import type {
  Prisma,
  PrismaClient,
  VaultOperation,
  VaultPublication,
} from '../generated/prisma/client.js';
import { publicationDigest } from './publication-digest.js';
import { VaultRepositoryError } from './vault-repository-error.js';
import type { VaultFingerprintKeys } from './vault-request-fingerprint.js';
import {
  equalFingerprints,
  fingerprintRequest,
  requireFingerprintKey,
} from './vault-request-fingerprint.js';

export interface PreparedPasswordChange {
  /** Opaque verifier already computed by the future authentication service, never a password. */
  readonly verifier: string;
  readonly expectedPublicationDigest: string;
  readonly expectedGeneration: number;
  readonly candidateDigest: string;
}

export interface VaultTransactionOptions {
  readonly maxWaitMs: number;
  readonly timeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

const defaults: VaultTransactionOptions = {
  maxWaitMs: 2_000,
  timeoutMs: 5_000,
  lockTimeoutMs: 1_000,
  statementTimeoutMs: 3_000,
};
type PublicIdentity = Omit<VaultOperationIdentity, 'fingerprint'>;
type TerminalResult = Exclude<VaultOperationResult, { status: 'unknown' }>;
type Candidate = {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly digest: string;
  readonly revisions: VaultReadState['revisions'];
};
type Mutation = {
  readonly identity: PublicIdentity;
  readonly vaultId: string;
  readonly candidate: Candidate;
  readonly prepared: PreparedPasswordChange | null;
  readonly fields: readonly (string | number | null)[];
};

function identity(request: InitialVaultPublication | OrdinaryPasswordChange): PublicIdentity {
  const initial = 'expectedCredentialRevision' in request;
  return {
    account: request.account,
    operationId: request.operationId,
    kind: initial ? 'initial-publication' : 'ordinary-password-change',
    expectedStorageRevision: initial ? null : request.expected.storageRevision,
    expectedCredentialRevision: initial
      ? request.expectedCredentialRevision
      : request.expected.credentialRevision,
  };
}

function prepareCandidate(
  request: InitialVaultPublication | OrdinaryPasswordChange,
  suppliedDigest: unknown,
): Candidate {
  if (!publicationDigestSchema.safeParse(suppliedDigest).success)
    throw new VaultRepositoryError('INVALID_INPUT');
  const bytes = Buffer.from(request.publicationBase64Url, 'base64url');
  const digest = publicationDigest(bytes);
  if (digest !== suppliedDigest) throw new VaultRepositoryError('INVALID_PUBLICATION');
  const parsed = validateAccountVault(bytes, request);
  if (!parsed.ok) throw new VaultRepositoryError('INVALID_PUBLICATION');
  return { bytes, digest, revisions: parsed.revisions };
}

function mutation(
  request: InitialVaultPublication | OrdinaryPasswordChange,
  candidate: Candidate,
  prepared: PreparedPasswordChange | null,
): Mutation {
  const id = identity(request);
  return {
    identity: id,
    vaultId: request.vaultId,
    candidate,
    prepared,
    fields: [
      request.transportVersion,
      id.kind,
      id.account,
      id.operationId,
      request.vaultId,
      id.expectedStorageRevision,
      id.expectedCredentialRevision,
      request.publicationBase64Url,
      candidate.digest,
      prepared?.expectedPublicationDigest ?? null,
      prepared?.expectedGeneration ?? null,
      prepared?.verifier ?? null,
    ],
  };
}

function storedResult(receipt: VaultOperation): TerminalResult {
  if (receipt.status !== 'COMMITTED' && receipt.status !== 'REJECTED')
    throw new VaultRepositoryError('CORRUPT_STORAGE');
  const result = vaultOperationResultSchema.safeParse({
    transportVersion: 1,
    status: receipt.status === 'COMMITTED' ? 'committed' : 'rejected',
    identity: {
      account: receipt.accountId,
      operationId: receipt.operationId,
      kind: receipt.kind,
      expectedStorageRevision: receipt.expectedStorageRevision?.toString() ?? null,
      expectedCredentialRevision: receipt.expectedCredentialRevision.toString(),
    },
    ...(receipt.status === 'COMMITTED'
      ? {
          cas: {
            storageRevision: receipt.resultStorageRevision?.toString(),
            credentialRevision: receipt.resultCredentialRevision?.toString(),
          },
          publicationDigest: receipt.publicationDigest
            ? Buffer.from(receipt.publicationDigest).toString('base64url')
            : undefined,
        }
      : { code: receipt.rejectionCode }),
  });
  if (!result.success || result.data.status === 'unknown')
    throw new VaultRepositoryError('CORRUPT_STORAGE');
  return result.data;
}

function validateStoredPublication(
  publication: VaultPublication,
  account: string,
  vaultId: string,
  credentialRevision: bigint,
): VaultReadState['revisions'] {
  const parsed = validateAccountVault(publication.bytes, { account, vaultId });
  if (
    !parsed.ok ||
    publication.cryptographicFormatVersion !== 1 ||
    publication.accountId !== account ||
    publication.vaultId !== vaultId ||
    publicationDigest(publication.bytes) !==
      Buffer.from(publication.digest).toString('base64url') ||
    publication.envelopeCredentialRevision > credentialRevision ||
    Object.entries(parsed.revisions).some(
      ([name, value]) => BigInt(value) !== publication[name as keyof typeof parsed.revisions],
    )
  )
    throw new VaultRepositoryError('CORRUPT_STORAGE');
  return parsed.revisions;
}

/** Internal persistence only. Every caller must enforce authentication and authorization. */
export class PostgresVaultRepository {
  private readonly options: VaultTransactionOptions;

  public constructor(
    private readonly client: PrismaClient,
    private readonly keys: VaultFingerprintKeys,
    options: Partial<VaultTransactionOptions> = {},
  ) {
    this.options = { ...defaults, ...options };
    if (
      Object.values(this.options).some((value) => !Number.isSafeInteger(value) || value < 1) ||
      this.options.lockTimeoutMs >= this.options.statementTimeoutMs ||
      this.options.statementTimeoutMs >= this.options.timeoutMs
    )
      throw new VaultRepositoryError('INVALID_INPUT');
    requireFingerprintKey(keys, keys.activeKeyId);
  }

  public async publishInitial(request: unknown, candidateDigest: unknown): Promise<TerminalResult> {
    const parsed = initialVaultPublicationSchema.safeParse(request);
    if (!parsed.success) throw new VaultRepositoryError('INVALID_INPUT');
    return this.execute(
      mutation(parsed.data, prepareCandidate(parsed.data, candidateDigest), null),
    );
  }

  public async rewrapPassword(
    request: unknown,
    prepared: PreparedPasswordChange,
  ): Promise<TerminalResult> {
    return this.execute(this.preparePasswordChange(request, prepared));
  }

  /** Trusted composition only; does not authenticate or acquire a lock. */
  public preparePasswordChange(request: unknown, prepared: PreparedPasswordChange): Mutation {
    const parsed = ordinaryPasswordChangeSchema.safeParse(request);
    if (
      !parsed.success ||
      !prepared ||
      typeof prepared.verifier !== 'string' ||
      prepared.verifier.length < 1 ||
      prepared.verifier.length > 4096 ||
      !publicationDigestSchema.safeParse(prepared.expectedPublicationDigest).success ||
      !vaultCryptoRevisionsSchema.shape.generation.safeParse(prepared.expectedGeneration).success
    )
      throw new VaultRepositoryError('INVALID_INPUT');
    // Snapshot caller-owned preparation before the first asynchronous boundary.
    const snapshot: PreparedPasswordChange = {
      verifier: prepared.verifier,
      expectedPublicationDigest: prepared.expectedPublicationDigest,
      expectedGeneration: prepared.expectedGeneration,
      candidateDigest: prepared.candidateDigest,
    };
    return mutation(parsed.data, prepareCandidate(parsed.data, snapshot.candidateDigest), snapshot);
  }

  public async readActive(account: string): Promise<VaultReadState | null> {
    this.validateLookup(account);
    // The lock keeps the active publication and credential revision in the same snapshot.
    return this.withAccountLock(account, async (tx) => {
      const state = await tx.vaultState.findUnique({
        where: { accountId: account },
        include: { activePublication: true, account: { include: { credential: true } } },
      });
      if (!state) return null;
      const credential = state.account.credential;
      const p = state.activePublication;
      if (!credential) throw new VaultRepositoryError('CORRUPT_STORAGE');
      const revisions = validateStoredPublication(p, account, state.vaultId, credential.revision);
      const result = vaultReadStateSchema.safeParse({
        transportVersion: 1,
        account,
        vaultId: state.vaultId,
        cryptographicFormatVersion: p.cryptographicFormatVersion,
        publicationBase64Url: Buffer.from(p.bytes).toString('base64url'),
        publicationDigest: publicationDigest(p.bytes),
        cas: {
          storageRevision: state.storageRevision.toString(),
          credentialRevision: credential.revision.toString(),
        },
        revisions,
        envelopeCredentialRevision: p.envelopeCredentialRevision.toString(),
      });
      if (!result.success) throw new VaultRepositoryError('CORRUPT_STORAGE');
      return result.data;
    });
  }

  public async getOperation(account: string, operationId: string): Promise<VaultOperationResult> {
    this.validateLookup(account);
    if (!initialVaultPublicationSchema.shape.operationId.safeParse(operationId).success)
      throw new VaultRepositoryError('INVALID_INPUT');
    return this.withAccountLock(account, async (tx) => {
      const receipt = await tx.vaultOperation.findUnique({
        where: { accountId_operationId: { accountId: account, operationId } },
      });
      if (!receipt) return { transportVersion: 1, status: 'unknown' };
      requireFingerprintKey(this.keys, receipt.fingerprintKeyId);
      return storedResult(receipt);
    });
  }

  private validateLookup(account: string): void {
    if (!initialVaultPublicationSchema.shape.account.safeParse(account).success)
      throw new VaultRepositoryError('INVALID_INPUT');
  }

  private async execute(input: Mutation): Promise<TerminalResult> {
    return this.withAccountLock(input.identity.account, (tx) =>
      this.executeInTransaction(tx, input),
    );
  }

  /** Caller must hold Account FOR UPDATE in this transaction. No nested transaction. */
  public async executeInTransaction(
    tx: Prisma.TransactionClient,
    input: Mutation,
    replayOnly = false,
  ): Promise<TerminalResult> {
    const keyId = this.keys.activeKeyId;
    // Fingerprint exact prepared data; the caller already owns the account lock.
    const fingerprint = fingerprintRequest(this.keys, keyId, input.fields);

    const existing = await tx.vaultOperation.findUnique({
      where: {
        accountId_operationId: {
          accountId: input.identity.account,
          operationId: input.identity.operationId,
        },
      },
    });
    if (existing) {
      const previous = storedResult(existing);
      const supplied = fingerprintRequest(this.keys, existing.fingerprintKeyId, input.fields);
      // HMAC covers every identity field; compare its bytes rather than the pure helper's strings.
      const sameIdentity = Object.entries(input.identity).every(
        ([name, value]) => previous.identity[name as keyof PublicIdentity] === value,
      );
      const sameFingerprint = equalFingerprints(supplied, existing.fingerprint);
      return !sameIdentity || !sameFingerprint
        ? this.rejected(input, 'IDEMPOTENCY_MISMATCH')
        : previous;
    }
    if (replayOnly) throw new VaultRepositoryError('INVALID_INPUT');
    const result = await this.apply(tx, input);
    await tx.vaultOperation.create({
      data: {
        accountId: input.identity.account,
        operationId: input.identity.operationId,
        kind: input.identity.kind,
        expectedStorageRevision:
          input.identity.expectedStorageRevision === null
            ? null
            : BigInt(input.identity.expectedStorageRevision),
        expectedCredentialRevision: BigInt(input.identity.expectedCredentialRevision),
        fingerprintKeyId: keyId,
        fingerprint,
        status: result.status === 'committed' ? 'COMMITTED' : 'REJECTED',
        ...(result.status === 'committed'
          ? {
              resultStorageRevision: BigInt(result.cas.storageRevision),
              resultCredentialRevision: BigInt(result.cas.credentialRevision),
              publicationDigest: Buffer.from(result.publicationDigest, 'base64url'),
            }
          : { rejectionCode: result.code }),
      },
    });
    // Returning a rejection commits its receipt; throwing would roll it back.
    return result;
  }

  private rejected(input: Mutation, code: VaultOperationError): TerminalResult {
    return { transportVersion: 1, status: 'rejected', identity: input.identity, code };
  }

  private async apply(tx: Prisma.TransactionClient, input: Mutation): Promise<TerminalResult> {
    const accountId = input.identity.account;
    const credential = await tx.passwordCredential.findUnique({ where: { accountId } });
    if (!credential) throw new VaultRepositoryError('CREDENTIAL_NOT_FOUND');
    const state = await tx.vaultState.findUnique({
      where: { accountId },
      include: { activePublication: true },
    });
    const context = { account: accountId, vaultId: input.vaultId };
    let storageRevision = 1n;
    let credentialRevision = credential.revision;
    if (input.prepared === null) {
      const evaluation = evaluateInitialVaultPublication(
        input.candidate.bytes,
        context,
        state !== null,
        null,
        input.identity.expectedCredentialRevision,
        credential.revision.toString(),
      );
      if (!evaluation.ok) return this.rejected(input, evaluation.code);
    } else {
      if (!state) return this.rejected(input, 'VERSION_CONFLICT');
      const previous = state.activePublication;
      validateStoredPublication(previous, accountId, state.vaultId, credential.revision);
      if (
        state.vaultId !== input.vaultId ||
        previous.envelopeCredentialRevision !== credential.revision ||
        previous.generation !== BigInt(input.prepared.expectedGeneration) ||
        input.prepared.expectedPublicationDigest !== publicationDigest(previous.bytes)
      )
        return this.rejected(input, 'VERSION_CONFLICT');
      const evaluation = evaluatePasswordVaultTransition(
        previous.bytes,
        input.candidate.bytes,
        context,
        {
          storageRevision: input.identity.expectedStorageRevision!,
          credentialRevision: input.identity.expectedCredentialRevision,
        },
        {
          storageRevision: state.storageRevision.toString(),
          credentialRevision: credential.revision.toString(),
        },
      );
      if (!evaluation.ok) return this.rejected(input, evaluation.code);
      storageRevision = state.storageRevision + 1n;
      credentialRevision = credential.revision + 1n;
      await tx.passwordCredential.update({
        where: { accountId },
        data: { verifier: input.prepared.verifier, revision: credentialRevision },
      });
    }
    const r = input.candidate.revisions;
    const publication = await tx.vaultPublication.create({
      data: {
        id: randomUUID(),
        accountId,
        vaultId: input.vaultId,
        cryptographicFormatVersion: 1,
        generation: BigInt(r.generation),
        contentRevision: BigInt(r.contentRevision),
        passwordRevision: BigInt(r.passwordRevision),
        recoveryRevision: BigInt(r.recoveryRevision),
        envelopeCredentialRevision: credentialRevision,
        bytes: input.candidate.bytes,
        digest: Buffer.from(input.candidate.digest, 'base64url'),
      },
    });
    const activation = {
      vaultId: input.vaultId,
      storageRevision,
      activePublicationId: publication.id,
    };
    if (state) await tx.vaultState.update({ where: { accountId }, data: activation });
    else await tx.vaultState.create({ data: { accountId, ...activation } });
    return {
      transportVersion: 1,
      status: 'committed',
      identity: input.identity,
      cas: {
        storageRevision: storageRevision.toString(),
        credentialRevision: credentialRevision.toString(),
      },
      publicationDigest: input.candidate.digest,
    };
  }

  private async withAccountLock<T>(
    account: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${this.options.lockTimeoutMs}ms`}, true), set_config('statement_timeout', ${`${this.options.statementTimeoutMs}ms`}, true)`;
          const rows = await tx.$queryRaw<
            { id: string }[]
          >`SELECT "id" FROM "Account" WHERE "id" = ${account} FOR UPDATE`;
          if (rows.length !== 1) throw new VaultRepositoryError('ACCOUNT_NOT_FOUND');
          return work(tx);
        },
        {
          isolationLevel: 'ReadCommitted',
          maxWait: this.options.maxWaitMs,
          timeout: this.options.timeoutMs,
        },
      );
    } catch (error) {
      if (error instanceof VaultRepositoryError) throw error;
      // No automatic retry: even a commit/transport failure can leave a durable receipt.
      throw new VaultRepositoryError('TRANSACTION_OUTCOME_UNKNOWN');
    }
  }
}
