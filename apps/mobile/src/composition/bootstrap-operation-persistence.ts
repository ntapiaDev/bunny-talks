import type { SessionDto } from '@bunny-talks/contracts';
import { sessionDtoSchema } from '@bunny-talks/validation';
import type { BootstrapOperationMetadataStore } from '../infrastructure/crypto/bootstrap-operation-metadata';
import type {
  BootstrapOperationRecord,
  BootstrapOperationStatus,
  BootstrapRejectionCode,
  InitialBootstrapContext,
} from './bootstrap-operation-record';
import { parseBootstrapOperationRecord } from './bootstrap-operation-record';
import type { PreparedInitialBootstrap } from './initial-device-bootstrap';
import { restorePreparedInitialBootstrap } from './initial-device-bootstrap';

export class BootstrapOperationPersistenceError extends Error {
  public constructor(readonly code: 'INVALID_INPUT' | 'OUTCOME_UNKNOWN' | 'STATE') {
    super(`Bootstrap operation persistence: ${code}`);
    this.name = 'BootstrapOperationPersistenceError';
  }
}

type Transition =
  | { status: Exclude<BootstrapOperationStatus, 'prepared' | 'rejected'> }
  | { status: 'rejected'; code: BootstrapRejectionCode };

function canTransition(from: BootstrapOperationStatus, to: BootstrapOperationStatus): boolean {
  if (from === 'committed' || from === 'rejected') return false;
  if (from === 'prepared') return to === 'emission-uncertain';
  return to !== 'prepared';
}

export function createBootstrapOperationPersistence(
  storage: BootstrapOperationMetadataStore,
  expectedContext: InitialBootstrapContext,
) {
  const context = { ...expectedContext };
  function requireContext(session: SessionDto) {
    if (
      !sessionDtoSchema.safeParse(session).success ||
      session.accountId !== context.account ||
      session.sessionId !== context.sessionId ||
      session.deviceId !== context.device
    ) {
      throw new BootstrapOperationPersistenceError('INVALID_INPUT');
    }
  }

  function parse(raw: string) {
    const record = parseBootstrapOperationRecord(raw, context);
    if (!record) throw new BootstrapOperationPersistenceError('STATE');
    return record;
  }

  async function write(previous: string | null, record: BootstrapOperationRecord) {
    const raw = JSON.stringify(record);
    parse(raw);
    const { acquired, observed } = await storage.compareAndSet(
      previous,
      raw,
      record.candidateDigest,
    );
    if (observed === raw) {
      return { status: acquired ? ('saved' as const) : ('found' as const), raw };
    }
    if (acquired === false && observed === previous) return { status: 'not-written' as const };
    throw new BootstrapOperationPersistenceError('OUTCOME_UNKNOWN');
  }

  function restore(raw: string | null, session: SessionDto, publicationBytes: Uint8Array) {
    requireContext(session);
    if (raw === null) return null;
    const record = parse(raw);
    const prepared = restorePreparedInitialBootstrap(record, publicationBytes);
    return { record, prepared, raw };
  }

  return {
    async create(prepared: PreparedInitialBootstrap, session: SessionDto) {
      requireContext(session);
      if (
        prepared.request.account !== context.account ||
        prepared.request.vaultId !== context.vaultId ||
        prepared.request.expectedCredentialRevision !== session.credentialRevision
      ) {
        throw new BootstrapOperationPersistenceError('INVALID_INPUT');
      }
      const record = {
        version: 1,
        account: context.account,
        device: context.device,
        sessionId: context.sessionId,
        vaultId: context.vaultId,
        operationId: prepared.request.operationId,
        expectedCredentialRevision: prepared.request.expectedCredentialRevision,
        candidateDigest: prepared.candidateDigest,
        status: 'prepared',
      } satisfies BootstrapOperationRecord;
      const result = await write(null, record);
      return { ...result, record };
    },
    async read(session: SessionDto, publicationBytes: Uint8Array) {
      return restore(await storage.read(), session, publicationBytes);
    },
    restore,
    async transition(
      expectedRaw: string,
      prepared: PreparedInitialBootstrap,
      transition: Transition,
    ) {
      const current = parse(expectedRaw);
      const { request, candidateDigest } = prepared;
      if (
        request.account !== current.account ||
        request.vaultId !== current.vaultId ||
        request.operationId !== current.operationId ||
        request.expectedCredentialRevision !== current.expectedCredentialRevision ||
        candidateDigest !== current.candidateDigest
      )
        throw new BootstrapOperationPersistenceError('STATE');
      if (!canTransition(current.status, transition.status)) {
        throw new BootstrapOperationPersistenceError('STATE');
      }
      if (current.status === transition.status) {
        if ((await storage.read(current.candidateDigest)) === expectedRaw) {
          return { status: 'found' as const, raw: expectedRaw };
        }
        throw new BootstrapOperationPersistenceError('OUTCOME_UNKNOWN');
      }
      const next: BootstrapOperationRecord =
        transition.status === 'rejected'
          ? { ...current, version: 2, status: transition.status, code: transition.code }
          : { ...current, version: 1, status: transition.status };
      return write(expectedRaw, next);
    },
  };
}
