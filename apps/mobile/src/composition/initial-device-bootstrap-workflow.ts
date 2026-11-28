import type { SessionDto } from '@bunny-talks/contracts';
import { loginSchema } from '@bunny-talks/validation';
import type {
  BootstrapOperationMetadataStore,
  ExistingBootstrapMetadataStore,
} from '../infrastructure/crypto/bootstrap-operation-metadata';
import type { LocalBootstrapAttempt } from '../infrastructure/crypto/local-crypto-initialization';
import { isOwnedBootstrapCapability } from '../infrastructure/crypto/local-crypto-initialization';
import type { ApplicationHttpResponse } from '../infrastructure/http/application-http';
import { createBootstrapOperationPersistence } from './bootstrap-operation-persistence';
import type { BootstrapRejectionCode, InitialBootstrapContext } from './bootstrap-operation-record';
import { validBootstrapContext } from './bootstrap-operation-record';
import type {
  ActivationPasswordVerification,
  PreparedInitialBootstrap,
  RecoveryBackupConfirmationCapability,
} from './initial-device-bootstrap';
import {
  InitialBootstrapProtocolError,
  prepareInitialBootstrap,
  validateInitialBootstrapResult,
} from './initial-device-bootstrap';
import type { BootstrapSessionAccess } from './session-composition';
import { isHttpRequestNotSent, isHttpStatus } from './session-composition';

export interface BootstrapHttpClient {
  requestWithStatus(input: {
    readonly path: string;
    readonly method: 'POST';
    readonly bearerToken: string;
    readonly body: unknown;
    readonly expectedStatuses: readonly number[];
  }): Promise<ApplicationHttpResponse>;
}

type Outcome =
  | { readonly status: 'not-sent' }
  | { readonly status: 'emission-uncertain' }
  | { readonly status: 'activation-auth-refused' }
  | { readonly status: 'receipt-unavailable' }
  | { readonly status: 'receipt-unknown' }
  | {
      readonly status: 'rejected';
      readonly source: 'server';
      readonly code: BootstrapRejectionCode;
    }
  | {
      readonly status: 'rejected';
      readonly source: 'local-journal';
      readonly code?: BootstrapRejectionCode;
    }
  | { readonly status: 'committed'; readonly source: 'server' | 'local-journal' }
  | { readonly status: 'conflict' }
  | { readonly status: 'divergent' };

export class InitialBootstrapWorkflowError extends Error {
  public constructor(
    readonly code: 'INVALID_INPUT' | 'OPERATION_NOT_FOUND' | 'INVALID_STATE' | 'OPERATION_BUSY',
  ) {
    super(`Initial bootstrap workflow: ${code}`);
    this.name = 'InitialBootstrapWorkflowError';
  }
}

type ReceiptMetadata = LocalBootstrapAttempt | ExistingBootstrapMetadataStore;

type BootstrapInput<Local = LocalBootstrapAttempt> = {
  readonly context: InitialBootstrapContext;
  readonly local: Local;
};

function snapshotWarmAttempt(local: LocalBootstrapAttempt) {
  const publication = local.publication;
  if (
    !(publication instanceof Uint8Array) ||
    publication.length === 0 ||
    publication.length > 131_072
  ) {
    throw new InitialBootstrapWorkflowError('INVALID_INPUT');
  }
  return { local, publication };
}

function snapshotReceiptSource(local: ReceiptMetadata) {
  if ('readAttempt' in local) return { readAttempt: local.readAttempt.bind(local) };
  return snapshotWarmAttempt(local);
}

type Journal = ReturnType<typeof createBootstrapOperationPersistence>;
type ActiveOperation = {
  readonly journal: Journal;
  readonly metadata: BootstrapOperationMetadataStore;
  readonly bearerToken: string;
  readonly expiresAt: number;
  readonly requireRevalidation: () => void;
};
const activeMetadata = new WeakSet<BootstrapOperationMetadataStore>();

function requirePasswordProof(
  proof: ActivationPasswordVerification,
  prepared: PreparedInitialBootstrap,
) {
  if (
    proof?.method !== 'account-vault-v1-password-open' ||
    proof.account !== prepared.request.account ||
    proof.vaultId !== prepared.request.vaultId ||
    proof.publicationDigest !== prepared.candidateDigest
  ) {
    throw new InitialBootstrapWorkflowError('INVALID_INPUT');
  }
}

export function createInitialDeviceBootstrapWorkflow(dependencies: {
  readonly http: BootstrapHttpClient;
  readonly randomUuid: () => string;
  readonly session: BootstrapSessionAccess;
  readonly recoveryBackupConfirmation: RecoveryBackupConfirmationCapability;
}) {
  const { http, randomUuid, session, recoveryBackupConfirmation } = dependencies;
  let busy = false;
  async function run<Local extends ReceiptMetadata, Source>(
    input: BootstrapInput<Local>,
    snapshot: (local: Local) => Source,
    work: (
      operation: ActiveOperation,
      context: InitialBootstrapContext,
      source: Source,
      sessionDto: SessionDto,
    ) => Promise<Outcome>,
  ): Promise<Outcome> {
    if (busy) throw new InitialBootstrapWorkflowError('OPERATION_BUSY');
    const { local } = input;
    if (!isOwnedBootstrapCapability(local)) {
      throw new InitialBootstrapWorkflowError('INVALID_INPUT');
    }
    const metadata: BootstrapOperationMetadataStore =
      'bootstrapOperationMetadata' in local ? local.bootstrapOperationMetadata : local;
    if (activeMetadata.has(metadata)) throw new InitialBootstrapWorkflowError('OPERATION_BUSY');
    busy = true;
    activeMetadata.add(metadata);
    try {
      const context = { ...input.context };
      if (
        !validBootstrapContext(context) ||
        context.account !== local.context.account ||
        context.device !== local.context.device ||
        context.vaultId !== local.context.vaultId
      ) {
        throw new InitialBootstrapWorkflowError('INVALID_INPUT');
      }
      const source = snapshot(local);
      return await session.withValidatedSession(async (current, requireRevalidation) => {
        const dto = current.session;
        if (
          dto.accountId !== context.account ||
          dto.deviceId !== context.device ||
          dto.sessionId !== context.sessionId
        )
          throw new InitialBootstrapWorkflowError('INVALID_INPUT');
        const operation = {
          journal: createBootstrapOperationPersistence(metadata, context),
          metadata,
          bearerToken: current.sessionToken,
          expiresAt: Date.parse(dto.expiresAt),
          requireRevalidation,
        };
        metadata.assertAvailable();
        return work(operation, context, source, dto);
      });
    } finally {
      activeMetadata.delete(metadata);
      busy = false;
    }
  }

  async function emit(
    operation: ActiveOperation,
    prepared: PreparedInitialBootstrap,
    raw: string,
    action: { password: string } | { receipt: true },
  ): Promise<Outcome> {
    operation.metadata.assertAvailable();
    const receipt = 'receipt' in action;
    if (operation.expiresAt <= Date.now()) {
      return { status: receipt ? 'receipt-unavailable' : 'not-sent' };
    }
    const body = {
      ...(receipt ? {} : { password: action.password }),
      request: prepared.request,
      candidateDigest: prepared.candidateDigest,
    };
    let response: ApplicationHttpResponse;
    try {
      response = await http.requestWithStatus({
        path: receipt ? '/v1/vault/bootstrap/receipt' : '/v1/vault/bootstrap',
        method: 'POST',
        bearerToken: operation.bearerToken,
        body,
        expectedStatuses: receipt ? [200, 202] : [200],
      });
    } catch (error) {
      if (isHttpStatus(error, 401)) {
        operation.requireRevalidation();
        return { status: receipt ? 'receipt-unavailable' : 'activation-auth-refused' };
      }
      if (receipt) return { status: 'receipt-unavailable' };
      return { status: isHttpRequestNotSent(error) ? 'not-sent' : 'emission-uncertain' };
    }
    let result: ReturnType<typeof validateInitialBootstrapResult>;
    try {
      result = validateInitialBootstrapResult(response.body, prepared);
    } catch (error) {
      if (error instanceof InitialBootstrapProtocolError) return { status: 'divergent' };
      throw error;
    }
    if (
      response.status !== (result.status === 'unknown' ? 202 : 200) ||
      (!receipt && result.status === 'unknown')
    )
      return { status: 'divergent' };

    const status = result.status;
    try {
      const saved = await operation.journal.transition(
        raw,
        prepared,
        status === 'rejected' ? { status, code: result.result.code } : { status },
      );
      operation.metadata.assertAvailable();
      if (saved.status === 'not-written') return { status: 'emission-uncertain' };
    } catch {
      return { status: 'emission-uncertain' };
    }
    switch (status) {
      case 'rejected':
        return { status, source: 'server', code: result.result.code };
      case 'committed':
        return { status, source: 'server' };
      case 'unknown':
        return { status: 'receipt-unknown' };
      case 'conflict':
        return { status };
    }
  }

  return {
    async activate(
      input: BootstrapInput & {
        readonly password: string;
        readonly recoveryKey: Uint8Array;
      },
    ): Promise<Outcome> {
      const password = input.password;
      if (!loginSchema.shape.password.safeParse(password).success) {
        throw new InitialBootstrapWorkflowError('INVALID_INPUT');
      }
      if (!(input.recoveryKey instanceof Uint8Array) || input.recoveryKey.length !== 32) {
        throw new InitialBootstrapWorkflowError('INVALID_INPUT');
      }
      let recoveryKey: Uint8Array | undefined = Uint8Array.from(input.recoveryKey);
      try {
        return await run(
          input,
          snapshotWarmAttempt,
          async (operation, context, { local, publication }, dto) => {
            if (dto.deviceState !== 'pending') {
              throw new InitialBootstrapWorkflowError('INVALID_STATE');
            }
            const { journal, metadata } = operation;
            if (await journal.read(dto, publication)) {
              throw new InitialBootstrapWorkflowError('INVALID_STATE');
            }
            const { account, vaultId } = context;
            const proof = {
              ...(await local.verifyActivationPassword({
                account,
                vaultId,
                publicationBytes: Uint8Array.from(publication),
                password,
              })),
            };
            metadata.assertAvailable();
            if (!recoveryKey) throw new InitialBootstrapWorkflowError('INVALID_STATE');
            let operationId: string;
            try {
              operationId = randomUuid();
            } catch {
              throw new InitialBootstrapWorkflowError('INVALID_INPUT');
            }
            const preparing = prepareInitialBootstrap({
              account,
              vaultId,
              operationId,
              expectedCredentialRevision: dto.credentialRevision,
              publicationBytes: publication,
              recoveryKey,
              recoveryVerifier: local,
              recoveryBackupConfirmation,
            });
            recoveryKey.fill(0);
            recoveryKey = undefined;
            const prepared = await preparing;
            requirePasswordProof(proof, prepared);
            if (prepared.candidateDigest !== local.publicationDigest) {
              throw new InitialBootstrapWorkflowError('INVALID_INPUT');
            }
            let raw: string;
            try {
              const saved = await journal.create(prepared, dto);
              if (saved.status !== 'saved') return { status: 'not-sent' };
              const emitting = await journal.transition(saved.raw, prepared, {
                status: 'emission-uncertain',
              });
              if (emitting.status !== 'saved') return { status: 'not-sent' };
              raw = emitting.raw;
            } catch {
              return { status: 'not-sent' };
            }
            return emit(operation, prepared, raw, { password });
          },
        );
      } finally {
        recoveryKey?.fill(0);
      }
    },

    recoverReceipt(input: BootstrapInput<ReceiptMetadata>): Promise<Outcome> {
      return run(input, snapshotReceiptSource, async (operation, _context, source, dto) => {
        const { journal } = operation;
        let saved: Awaited<ReturnType<Journal['read']>>;
        if ('readAttempt' in source) {
          const existing = await source.readAttempt();
          saved = journal.restore(existing.operationMetadata, dto, existing.publicationBytes);
        } else {
          saved = await journal.read(dto, source.publication);
        }
        if (!saved) throw new InitialBootstrapWorkflowError('OPERATION_NOT_FOUND');
        operation.metadata.assertAvailable();
        const { record } = saved;
        if (record.status === 'committed') return { status: 'committed', source: 'local-journal' };
        if (record.status === 'rejected') {
          return {
            status: 'rejected',
            source: 'local-journal',
            ...(record.version === 2 ? { code: record.code } : {}),
          };
        }
        if (record.status === 'prepared') return { status: 'not-sent' };
        return emit(operation, saved.prepared, saved.raw, { receipt: true });
      });
    },

    async replayActivation(
      input: BootstrapInput & {
        readonly password: string;
      },
    ): Promise<Outcome> {
      const password = input.password;
      if (!loginSchema.shape.password.safeParse(password).success) {
        throw new InitialBootstrapWorkflowError('INVALID_INPUT');
      }
      return run(
        input,
        snapshotWarmAttempt,
        async (operation, context, { local, publication }, dto) => {
          const { journal } = operation;
          const saved = await journal.read(dto, publication);
          if (!saved || saved.record.status === 'committed' || saved.record.status === 'rejected') {
            throw new InitialBootstrapWorkflowError('INVALID_STATE');
          }
          const proof = await local.verifyActivationPassword({
            account: context.account,
            vaultId: context.vaultId,
            publicationBytes: Uint8Array.from(publication),
            password,
          });
          requirePasswordProof(proof, saved.prepared);
          let raw: string;
          try {
            const emitting = await journal.transition(saved.raw, saved.prepared, {
              status: 'emission-uncertain',
            });
            if (
              emitting.status !== 'saved' &&
              !(emitting.status === 'found' && saved.record.status === 'emission-uncertain')
            )
              return { status: 'not-sent' };
            raw = emitting.raw;
          } catch {
            return { status: 'not-sent' };
          }
          return emit(operation, saved.prepared, raw, { password });
        },
      );
    },
  };
}
