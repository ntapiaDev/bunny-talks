import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToBase64 } from '@open-e2ee/signal-protocol-sdk/encoding';
import { describe, expect, it, vi } from 'vitest';
import type { BootstrapHttpClient } from '../src/composition/initial-device-bootstrap-workflow';
import { createInitialDeviceBootstrapWorkflow } from '../src/composition/initial-device-bootstrap-workflow';
import {
  createSessionService,
  createSessionWorkflow,
} from '../src/composition/session-composition';
import { createSessionPersistence } from '../src/composition/session-persistence';
import { ApplicationHttpError } from '../src/infrastructure/http/application-http';

// The SQLCipher suite exercises actual capability issuance and rejection of substitutions.
vi.mock('../src/infrastructure/crypto/local-crypto-initialization', () => ({
  isOwnedBootstrapCapability: () => true,
}));

const context = {
  account: 'account-fixture',
  device: 'd8c49125-e0fb-4a9e-bdc2-09c57ad4382a',
  vaultId: 'AQEBAQEBAQEBAQEBAQEBAQ',
  sessionId: 'cbbbf3b9-b6e3-41a2-8c6c-bbe37186625f',
};
const sessionToken = `s1.${context.sessionId}.${'A'.repeat(43)}`;
const session = {
  accountId: context.account,
  sessionId: context.sessionId,
  deviceId: context.device,
  deviceState: 'pending' as const,
  expiresAt: '2099-12-16T12:00:00.000Z',
  credentialRevision: '17',
};
const publication = new TextEncoder().encode('{"encrypted":"workflow candidate"}');
const base64url = (bytes: Uint8Array) =>
  bytesToBase64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const digest = base64url(sha256(publication));

async function fixture(
  handler: (input: { body: unknown; path: string; bearerToken: string }) => Promise<{
    status: number;
    body: unknown;
  }>,
  options: { failSuspension?: boolean } = {},
) {
  let raw: string | null = null;
  const storage = {
    assertAvailable() {},
    async read() {
      return raw;
    },
    async compareAndSet(expected: string | null, next: string) {
      if (raw !== expected) return { acquired: false, observed: raw };
      raw = next;
      return { acquired: true, observed: raw };
    },
  };
  const sent: { body: unknown; path: string; bearerToken: string }[] = [];
  let uuidCalls = 0;
  let passwordVerificationCalls = 0;
  let token: string | null = null;
  let metadata: string | null = null;
  let denySession = false;
  let credentialRevision = session.credentialRevision;
  const persistence = createSessionPersistence({
    secret: {
      async read() {
        return token;
      },
      async write(value) {
        token = value;
      },
    },
    metadata: {
      async read() {
        return metadata;
      },
      async write(value) {
        if (options.failSuspension && JSON.parse(value).state === 'invalid')
          throw new Error('fixture suspension failure');
        metadata = value;
      },
    },
  });
  const identity = {
    accountId: session.accountId,
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    deviceState: session.deviceState,
    expiresAt: session.expiresAt,
  };
  const request = vi.fn(async ({ path, bearerToken }: { path: string; bearerToken?: string }) => {
    if (path === '/v1/auth/login') return { sessionToken, session: identity };
    expect(path).toBe('/v1/session');
    expect(bearerToken).toBe(sessionToken);
    if (denySession) throw new ApplicationHttpError('status', 401);
    return { ...session, credentialRevision };
  });
  const service = createSessionService(request);
  const owner = createSessionWorkflow(service, persistence);
  await owner.login({ email: 'user@example.com', password: 'fixture-password' });
  await owner.validateCurrent();
  const dependencies = {
    randomUuid: () => {
      uuidCalls++;
      return '77c612cf-753d-455a-9862-69059bab610a';
    },
    session: owner.bootstrapSession,
    recoveryBackupConfirmation: {
      async confirmRecoveryBackup(input: {
        account: string;
        vaultId: string;
        publicationDigest: string;
      }) {
        return { kind: 'user-confirmed-independent-recovery-backup' as const, ...input };
      },
    },
    http: {
      async requestWithStatus(input: Parameters<BootstrapHttpClient['requestWithStatus']>[0]) {
        const event = { body: input.body, path: input.path, bearerToken: input.bearerToken };
        sent.push(event);
        return handler(event);
      },
    },
  };
  const workflow = createInitialDeviceBootstrapWorkflow(dependencies);
  const local = {
    context,
    publicationDigest: digest,
    get publication() {
      return Uint8Array.from(publication);
    },
    bootstrapOperationMetadata: storage,
    async verifyActivationPassword(input: {
      account: string;
      vaultId: string;
      publicationBytes: Uint8Array;
      password: string;
    }) {
      passwordVerificationCalls++;
      if (input.password !== 'fixture-password') throw new Error('fixture password mismatch');
      return {
        method: 'account-vault-v1-password-open' as const,
        account: input.account,
        vaultId: input.vaultId,
        publicationDigest: digest,
      };
    },
    async verifyRecoveryKey(input: { account: string; vaultId: string }) {
      return {
        method: 'account-vault-v1-recovery-open' as const,
        account: input.account,
        vaultId: input.vaultId,
        publicationDigest: digest,
        recoveryRevision: 1 as const,
      };
    },
  };
  return {
    workflow,
    owner,
    service,
    persistence,
    request,
    dependencies,
    denySession() {
      denySession = true;
    },
    replacePersistedBearer(value: string) {
      token = value;
    },
    setCredentialRevision(value: string) {
      credentialRevision = value;
    },
    local,
    sent,
    get raw() {
      return raw;
    },
    get uuidCalls() {
      return uuidCalls;
    },
    get passwordVerificationCalls() {
      return passwordVerificationCalls;
    },
  };
}

function committed(body: unknown) {
  const request = body as {
    request: {
      account: string;
      operationId: string;
      expectedCredentialRevision: string;
    };
    candidateDigest: string;
  };
  return {
    transportVersion: 1,
    status: 'committed',
    identity: {
      account: request.request.account,
      operationId: request.request.operationId,
      kind: 'initial-publication',
      expectedStorageRevision: null,
      expectedCredentialRevision: request.request.expectedCredentialRevision,
    },
    cas: { storageRevision: '1', credentialRevision: request.request.expectedCredentialRevision },
    publicationDigest: request.candidateDigest,
  };
}

describe('first-device bootstrap workflow', () => {
  it('persists before activation, keeps secrets out of the journal and validates a correlated commit', async () => {
    const run = await fixture(async ({ body, path }) => {
      expect(path).toBe('/v1/vault/bootstrap');
      expect(run.raw).toContain('emission-uncertain');
      expect(run.raw).not.toContain(sessionToken);
      expect(run.raw).not.toContain('fixture-password');
      expect(run.raw).not.toContain('recovery');
      return { status: 200, body: committed(body) };
    });
    await expect(
      run.workflow.activate({
        context,
        local: run.local,
        password: 'fixture-password',
        recoveryKey: new Uint8Array(32).fill(2),
      }),
    ).resolves.toEqual({ status: 'committed', source: 'server' });
    expect(run.sent).toHaveLength(1);
    expect(run.uuidCalls).toBe(1);
    expect(run.raw).toContain('committed');
    await expect(run.workflow.recoverReceipt({ context, local: run.local })).resolves.toEqual({
      status: 'committed',
      source: 'local-journal',
    });
    expect(run.sent).toHaveLength(1);
    await expect(
      run.workflow.activate({
        context,
        local: run.local,
        password: 'fixture-password',
        recoveryKey: new Uint8Array(32).fill(2),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(run.uuidCalls).toBe(1);
  });

  it('recovers a lost emission through the exact receipt and only replays activation explicitly', async () => {
    let mode: 'lost' | 'unknown' | 'committed' = 'lost';
    const run = await fixture(async ({ body, path }) => {
      if (mode === 'lost') throw new ApplicationHttpError('timeout');
      if (path.endsWith('/receipt') && mode === 'unknown') {
        return { status: 202, body: { transportVersion: 1, status: 'unknown' } };
      }
      return { status: 200, body: committed(body) };
    });
    const activation = await run.workflow.activate({
      context,
      local: run.local,
      password: 'fixture-password',
      recoveryKey: new Uint8Array(32).fill(2),
    });
    expect(activation).toEqual({ status: 'emission-uncertain' });
    const original = JSON.parse(run.raw!) as { operationId: string; candidateDigest: string };
    mode = 'unknown';
    run.setCredentialRevision('18');
    await run.owner.validateCurrent();
    expect(
      await run.workflow.recoverReceipt({
        context,
        local: run.local,
      }),
    ).toEqual({ status: 'receipt-unknown' });
    const receiptBody = run.sent[1]!.body as {
      request: { operationId: string; expectedCredentialRevision: string };
      candidateDigest: string;
    };
    expect(receiptBody.request.operationId).toBe(original.operationId);
    expect(receiptBody.request.expectedCredentialRevision).toBe('17');
    expect(receiptBody.candidateDigest).toBe(original.candidateDigest);
    expect(Object.hasOwn(receiptBody, 'password')).toBe(false);
    expect(run.passwordVerificationCalls).toBe(1);

    mode = 'committed';
    await expect(
      run.workflow.replayActivation({
        context,
        local: run.local,
        password: 'incorrect-password',
      }),
    ).rejects.toThrow();
    expect(run.sent).toHaveLength(2);
    expect(
      await run.workflow.replayActivation({
        context,
        local: run.local,
        password: 'fixture-password',
      }),
    ).toEqual({ status: 'committed', source: 'server' });
    const replay = run.sent[2]!.body as {
      request: {
        operationId: string;
        publicationBase64Url: string;
        expectedCredentialRevision: string;
      };
    };
    expect(replay.request.operationId).toBe(original.operationId);
    expect(replay.request.expectedCredentialRevision).toBe('17');
    expect(replay.request.publicationBase64Url).toBe(
      (run.sent[0]!.body as { request: { publicationBase64Url: string } }).request
        .publicationBase64Url,
    );
    expect(run.uuidCalls).toBe(1);
    expect(run.passwordVerificationCalls).toBe(3);
  });

  it('requires explicit validation of the original bearer after activation 401 and preserves the journal', async () => {
    const run = await fixture(async ({ path }) => {
      if (path.endsWith('/receipt'))
        return { status: 202, body: { transportVersion: 1, status: 'unknown' } };
      throw new ApplicationHttpError('status', 401);
    });
    const input = {
      context,
      local: run.local,
      password: 'fixture-password',
      recoveryKey: new Uint8Array(32).fill(2),
    };
    await expect(run.workflow.activate(input)).resolves.toEqual({
      status: 'activation-auth-refused',
    });
    expect(run.raw).toContain('emission-uncertain');
    const previousRaw = run.raw;
    await expect(run.workflow.recoverReceipt(input)).rejects.toMatchObject({
      code: 'SESSION_VALIDATION_REQUIRED',
    });
    expect(run.sent).toHaveLength(1);
    expect(run.request).toHaveBeenCalledTimes(2);

    await expect(run.owner.validateCurrent()).resolves.toMatchObject({ status: 'active' });
    expect(run.raw).toBe(previousRaw);
    expect(run.sent).toHaveLength(1);
    await expect(run.workflow.activate(input)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(run.workflow.recoverReceipt(input)).resolves.toEqual({
      status: 'receipt-unknown',
    });
    const original = run.sent[0]!.body as { request: unknown; candidateDigest: string };
    expect(run.sent[1]!.body).toEqual({
      request: original.request,
      candidateDigest: original.candidateDigest,
    });
    expect(run.request.mock.calls.map(([request]) => request.path)).toEqual([
      '/v1/auth/login',
      '/v1/session',
      '/v1/session',
    ]);
  });

  it('refuses to revalidate a substituted bearer after activation 401', async () => {
    const run = await fixture(async () => {
      throw new ApplicationHttpError('status', 401);
    });
    const input = {
      context,
      local: run.local,
      password: 'fixture-password',
      recoveryKey: new Uint8Array(32),
    };
    await expect(run.workflow.activate(input)).resolves.toEqual({
      status: 'activation-auth-refused',
    });
    run.replacePersistedBearer(`s1.${context.sessionId}.${'B'.repeat(42)}A`);
    await expect(run.owner.validateCurrent()).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
    expect(run.request).toHaveBeenCalledTimes(2);
    await expect(run.workflow.replayActivation(input)).rejects.toMatchObject({
      code: 'SESSION_VALIDATION_REQUIRED',
    });
    expect(run.sent).toHaveLength(1);
  });

  it('shares the invalid guard with both workflows when session GET confirms 401 and suspension fails', async () => {
    const run = await fixture(
      async () => {
        throw new ApplicationHttpError('status', 401);
      },
      { failSuspension: true },
    );
    const second = createInitialDeviceBootstrapWorkflow(run.dependencies);
    const input = {
      context,
      local: run.local,
      password: 'fixture-password',
      recoveryKey: new Uint8Array(32).fill(2),
    };
    await expect(run.workflow.activate(input)).resolves.toEqual({
      status: 'activation-auth-refused',
    });
    run.denySession();
    await expect(run.owner.validateCurrent()).resolves.toMatchObject({ status: 'invalid' });
    await expect(run.persistence.read()).resolves.toMatchObject({ status: 'active' });
    await expect(run.workflow.replayActivation(input)).rejects.toMatchObject({
      code: 'SESSION_INVALID',
    });
    await expect(second.recoverReceipt(input)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    await expect(run.owner.validateCurrent()).resolves.toMatchObject({ status: 'invalid' });
    expect(() => createSessionWorkflow(run.service, run.persistence)).toThrow(
      'SESSION_OWNER_EXISTS',
    );
    expect(run.sent).toHaveLength(1);
    expect(run.request).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 503])(
    'keeps receipt HTTP %i separate from activation uncertainty',
    async (status) => {
      const run = await fixture(async ({ path }) => {
        if (!path.endsWith('/receipt')) throw new ApplicationHttpError('timeout');
        throw new ApplicationHttpError('status', status);
      });
      const input = {
        context,
        local: run.local,
        password: 'fixture-password',
        recoveryKey: new Uint8Array(32).fill(2),
      };
      await expect(run.workflow.activate(input)).resolves.toEqual({ status: 'emission-uncertain' });
      const previousRaw = run.raw;
      await expect(run.workflow.recoverReceipt(input)).resolves.toEqual({
        status: 'receipt-unavailable',
      });
      expect(run.raw).toBe(previousRaw);
      if (status === 401) {
        await expect(run.workflow.recoverReceipt(input)).rejects.toMatchObject({
          code: 'SESSION_VALIDATION_REQUIRED',
        });
        expect(run.sent).toHaveLength(2);
      }
    },
  );

  it('keeps cancellation after the HTTP boundary uncertain', async () => {
    const run = await fixture(async () => {
      throw new ApplicationHttpError('cancelled');
    });
    await expect(
      run.workflow.activate({
        context,
        local: run.local,
        password: 'fixture-password',
        recoveryKey: new Uint8Array(32).fill(2),
      }),
    ).resolves.toEqual({ status: 'emission-uncertain' });
    expect(run.sent).toHaveLength(1);
  });

  it('refuses concurrent activation, receipt and replay for equal or different inputs', async () => {
    let release!: () => void;
    const run = await fixture(async ({ body }) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 200, body: committed(body) };
    });
    const input = {
      context,
      local: run.local,
      password: 'fixture-password',
      recoveryKey: new Uint8Array(32).fill(2),
    };
    const first = run.workflow.activate(input);
    await vi.waitFor(() => expect(run.sent).toHaveLength(1));
    const secondWorkflow = createInitialDeviceBootstrapWorkflow(run.dependencies);
    const busy = { code: 'OPERATION_BUSY' };
    await expect(run.workflow.activate(input)).rejects.toMatchObject(busy);
    await expect(
      run.workflow.activate({ ...input, context: { ...context, account: 'other' } }),
    ).rejects.toMatchObject(busy);
    await expect(
      run.workflow.activate({
        ...input,
        password: 'other-password',
        recoveryKey: new Uint8Array(32).fill(3),
      }),
    ).rejects.toMatchObject(busy);
    await expect(secondWorkflow.activate(input)).rejects.toMatchObject(busy);
    const differentMetadata = { ...run.local.bootstrapOperationMetadata };
    await expect(
      secondWorkflow.recoverReceipt({
        ...input,
        local: { ...input.local, bootstrapOperationMetadata: differentMetadata },
      }),
    ).rejects.toMatchObject(busy);
    await expect(secondWorkflow.recoverReceipt(input)).rejects.toMatchObject(busy);
    await expect(run.workflow.replayActivation(input)).rejects.toMatchObject(busy);
    release();
    await expect(first).resolves.toEqual({ status: 'committed', source: 'server' });
    await expect(run.workflow.replayActivation(input)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(run.sent).toHaveLength(1);
    expect(run.uuidCalls).toBe(1);
  });

  it('refuses concurrent receipt reads within the owning workflow', async () => {
    let release!: () => void;
    const run = await fixture(async ({ path }) => {
      if (path.endsWith('/receipt')) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { status: 202, body: { transportVersion: 1, status: 'unknown' } };
      }
      throw new ApplicationHttpError('timeout');
    });
    await run.workflow.activate({
      context,
      local: run.local,
      password: 'fixture-password',
      recoveryKey: new Uint8Array(32).fill(2),
    });
    const input = { context, local: run.local };
    const first = run.workflow.recoverReceipt(input);
    await expect(run.workflow.recoverReceipt(input)).rejects.toMatchObject({
      code: 'OPERATION_BUSY',
    });
    await vi.waitFor(() => expect(run.sent).toHaveLength(2));
    release();
    await expect(first).resolves.toEqual({ status: 'receipt-unknown' });
    expect(run.sent).toHaveLength(2);
  });

  it('uses only the snapshots and clears its recovery key copy before backup confirmation', async () => {
    const run = await fixture(async ({ body }) => ({ status: 200, body: committed(body) }));
    let releasePassword!: () => void;
    const passwordGate = new Promise<void>((resolve) => {
      releasePassword = resolve;
    });
    let releaseConfirmation!: () => void;
    const confirmationGate = new Promise<void>((resolve) => {
      releaseConfirmation = resolve;
    });
    const verifyActivationPassword = vi.fn(
      async (input: Parameters<typeof run.local.verifyActivationPassword>[0]) => {
        await passwordGate;
        expect(input.password).toBe('fixture-password');
        expect(input.publicationBytes).toEqual(publication);
        input.publicationBytes.fill(0);
        return run.local.verifyActivationPassword(input);
      },
    );
    let verifierKey: Uint8Array | undefined;
    const confirmRecoveryBackup = vi.fn(
      async (
        input: Parameters<
          typeof run.dependencies.recoveryBackupConfirmation.confirmRecoveryBackup
        >[0],
      ) => {
        expect(verifierKey).toEqual(new Uint8Array(32));
        await confirmationGate;
        return run.dependencies.recoveryBackupConfirmation.confirmRecoveryBackup(input);
      },
    );
    const workflow = createInitialDeviceBootstrapWorkflow({
      ...run.dependencies,
      recoveryBackupConfirmation: { confirmRecoveryBackup },
    });
    const key = new Uint8Array(32).fill(2);
    const mutablePublication = Uint8Array.from(publication);
    const input = {
      context: { ...context },
      local: {
        ...run.local,
        get publication() {
          return Uint8Array.from(mutablePublication);
        },
        verifyActivationPassword,
        async verifyRecoveryKey(input: {
          account: string;
          vaultId: string;
          recoveryKey: Uint8Array;
          publicationBytes: Uint8Array;
        }) {
          expect(input.recoveryKey).toEqual(new Uint8Array(32).fill(2));
          expect(input.publicationBytes).toEqual(publication);
          verifierKey = input.recoveryKey;
          return run.local.verifyRecoveryKey(input);
        },
      },
      password: 'fixture-password',
      recoveryKey: key,
    };
    const activation = workflow.activate(input);
    await vi.waitFor(() => expect(verifyActivationPassword).toHaveBeenCalledOnce());
    input.password = 'other-password';
    input.context.account = 'other-account';
    key.fill(7);
    mutablePublication.fill(0);
    releasePassword();
    await vi.waitFor(() => expect(confirmRecoveryBackup).toHaveBeenCalledOnce());
    expect(key).toEqual(new Uint8Array(32).fill(7));
    releaseConfirmation();
    await expect(activation).resolves.toEqual({ status: 'committed', source: 'server' });
    expect(run.sent[0]).toMatchObject({
      bearerToken: sessionToken,
      body: {
        password: 'fixture-password',
        candidateDigest: digest,
        request: { account: context.account, publicationBase64Url: base64url(publication) },
      },
    });
  });

  it('restores a terminal rejection and its code without a new request or replay', async () => {
    const run = await fixture(async ({ body }) => ({
      status: 200,
      body: {
        transportVersion: 1,
        status: 'rejected',
        identity: committed(body).identity,
        code: 'VERSION_CONFLICT',
      },
    }));
    const input = {
      context,
      local: run.local,
      password: 'fixture-password',
      recoveryKey: new Uint8Array(32).fill(2),
    };
    await expect(run.workflow.activate(input)).resolves.toEqual({
      status: 'rejected',
      code: 'VERSION_CONFLICT',
      source: 'server',
    });
    expect(JSON.parse(run.raw!)).toMatchObject({
      version: 2,
      status: 'rejected',
      code: 'VERSION_CONFLICT',
    });
    const original = run.raw;
    const resumed = createInitialDeviceBootstrapWorkflow(run.dependencies);
    await expect(resumed.recoverReceipt(input)).resolves.toEqual({
      status: 'rejected',
      code: 'VERSION_CONFLICT',
      source: 'local-journal',
    });
    await expect(resumed.replayActivation(input)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(run.raw).toBe(original);
    expect(run.sent).toHaveLength(1);
    expect(run.passwordVerificationCalls).toBe(1);
  });

  it('classifies a correlated idempotency mismatch as conflict', async () => {
    const run = await fixture(async ({ body }) => {
      const result = committed(body);
      return {
        status: 200,
        body: {
          transportVersion: 1,
          status: 'rejected',
          identity: result.identity,
          code: 'IDEMPOTENCY_MISMATCH',
        },
      };
    });
    const activation = {
      context,
      local: run.local,
      password: 'fixture-password',
      recoveryKey: new Uint8Array(32).fill(2),
    };
    expect(await run.workflow.activate(activation)).toEqual({ status: 'conflict' });
    await expect(run.workflow.activate(activation)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(run.uuidCalls).toBe(1);
    expect(run.sent).toHaveLength(1);
  });

  it('does not report a server commit until its terminal journal transition is confirmed', async () => {
    const run = await fixture(async ({ body }) => ({ status: 200, body: committed(body) }));
    const compare = run.local.bootstrapOperationMetadata.compareAndSet.bind(
      run.local.bootstrapOperationMetadata,
    );
    run.local.bootstrapOperationMetadata.compareAndSet = async (expected, next) => {
      const current = await run.local.bootstrapOperationMetadata.read();
      if (
        current &&
        JSON.parse(current).status === 'emission-uncertain' &&
        JSON.parse(next).status === 'committed'
      ) {
        return { acquired: false, observed: current };
      }
      return compare(expected, next);
    };
    await expect(
      run.workflow.activate({
        context,
        local: run.local,
        password: 'fixture-password',
        recoveryKey: new Uint8Array(32).fill(2),
      }),
    ).resolves.toEqual({ status: 'emission-uncertain' });
    expect(run.raw).toContain('emission-uncertain');
    expect(run.sent).toHaveLength(1);
  });

  it('rejects an initial publication commit with a storage revision other than one', async () => {
    const run = await fixture(async ({ body }) => {
      const result = committed(body);
      return { status: 200, body: { ...result, cas: { ...result.cas, storageRevision: '2' } } };
    });
    expect(
      await run.workflow.activate({
        context,
        local: run.local,
        password: 'fixture-password',
        recoveryKey: new Uint8Array(32).fill(2),
      }),
    ).toEqual({ status: 'divergent' });
  });
});
