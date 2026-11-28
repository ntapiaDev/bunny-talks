import { sha256 } from '@noble/hashes/sha2.js';
import { MAX_REGISTRATION_ID, MIN_REGISTRATION_ID } from '@open-e2ee/signal-protocol-sdk';
import { createSignalProtocolClient } from '@open-e2ee/signal-protocol-sdk/client';
import { base64ToBytes, bytesToBase64 } from '@open-e2ee/signal-protocol-sdk/encoding';
import type { IdentityKeyPair } from '@open-e2ee/signal-protocol-sdk/keys';
import {
  generateIdentityKeyPair,
  generateRegistrationId,
} from '@open-e2ee/signal-protocol-sdk/keys';
import type {
  AccountVaultAccess,
  Argon2idProvider,
  CryptographicRandomSource,
  KeyEnvelopeContext,
} from '@bunny-talks/crypto-backup';
import {
  createAccountVault,
  encodeEnvelopePassword,
  openAccountVaultWithPassword,
  openAccountVaultWithRecoveryKey,
} from '@bunny-talks/crypto-backup';
import {
  decodeRecoveryPayloadV1,
  serializeRecoveryPayloadV1,
} from '@bunny-talks/crypto-backup/experimental';
import type { SqliteIdentityStore } from '@bunny-talks/crypto-engine';
import {
  importIdentity,
  isLocalIdentityAbsent,
  matchesLocalIdentity,
  prepareImportedIdentity,
  readLocalIdentity,
} from '@bunny-talks/crypto-engine';
import type {
  ExistingBootstrapAttempt,
  ExistingBootstrapMetadataStore,
} from './bootstrap-operation-metadata.ts';
import {
  createBootstrapOperationMetadataStore,
  validBootstrapStoreContext,
} from './bootstrap-operation-metadata.ts';
import {
  createRestrictedSignalStore,
  initialBootstrapOperationMetadataKey,
  initializationMetadataKey,
} from './restricted-signal-store.ts';

export interface LocalInitializationContext extends KeyEnvelopeContext {
  readonly device: string;
}

interface Dependencies {
  /** Takes exclusive custody of a provably new, reserved store for this context. */
  openFreshStore(context: LocalInitializationContext): Promise<SqliteIdentityStore>;
  /** Takes exclusive custody of the existing store. Must refuse missing files/keys. */
  openExistingStore(context: LocalInitializationContext): Promise<SqliteIdentityStore>;
  random: CryptographicRandomSource;
  argon2: Argon2idProvider;
}

type Request =
  | { mode: 'create'; password: string; recoveryKey: Uint8Array }
  | { mode: 'resume'; access: AccountVaultAccess };

interface Attempt {
  version: 1;
  account: string;
  device: string;
  vaultId: string;
  status: 'pending' | 'ready';
  registrationId: number;
  publication: string;
}

type Failure = 'CONTEXT' | 'STATE' | 'ACCESS' | 'OUTCOME_UNKNOWN' | 'UNAVAILABLE';

export class LocalCryptoInitializationError extends Error {
  readonly code: Failure;

  constructor(code: Failure) {
    super(`Local cryptographic initialization: ${code}`);
    this.name = 'LocalCryptoInitializationError';
    this.code = code;
  }
}

function snapshotContext(expected: LocalInitializationContext): LocalInitializationContext {
  if (!expected || typeof expected !== 'object') {
    throw new LocalCryptoInitializationError('CONTEXT');
  }
  const context = Object.freeze({
    account: expected.account,
    device: expected.device,
    vaultId: expected.vaultId,
  });
  if (!validBootstrapStoreContext(context)) throw new LocalCryptoInitializationError('CONTEXT');
  return context;
}

// Issuance is private to the store owner. Copies and recombinations have a different identity.
const issuedBootstrapCapabilities = new WeakSet<object>();

function issueBootstrapCapability<T extends object>(capability: T): Readonly<T> {
  issuedBootstrapCapabilities.add(capability);
  return Object.freeze(capability);
}

export function isOwnedBootstrapCapability(capability: object): boolean {
  return issuedBootstrapCapabilities.has(capability);
}

export type LocalBootstrapAttempt = Awaited<ReturnType<typeof initializeLocalCrypto>>['bootstrap'];

const ownedStores = new WeakSet<SqliteIdentityStore>();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const maxPublicationBytes = 131072;

function acquireStore(store: SqliteIdentityStore): SqliteIdentityStore {
  if (ownedStores.has(store)) throw new LocalCryptoInitializationError('UNAVAILABLE');
  ownedStores.add(store);
  return store;
}

async function releaseStore(store: SqliteIdentityStore): Promise<void> {
  try {
    await store.close();
  } catch {
    // A failed close leaves custody uncertain for this store object.
    throw new LocalCryptoInitializationError('UNAVAILABLE');
  }
  ownedStores.delete(store);
}

function requireProtectedStore(store: SqliteIdentityStore) {
  if (store.protection.atRest !== 'file-cipher') {
    throw new LocalCryptoInitializationError('UNAVAILABLE');
  }
}

async function withExistingBootstrapStore<T>(
  context: LocalInitializationContext,
  dependencies: Pick<Dependencies, 'openExistingStore'>,
  work: (store: SqliteIdentityStore, attempt: Attempt) => Promise<T>,
): Promise<T> {
  let owned: SqliteIdentityStore | undefined;
  try {
    owned = acquireStore(await dependencies.openExistingStore(context));
    requireProtectedStore(owned);
    const raw = await owned.getMetadata(initializationMetadataKey);
    if (raw === null) throw new LocalCryptoInitializationError('STATE');
    const attempt = readAttempt(raw, context);
    if (attempt.status !== 'ready') throw new LocalCryptoInitializationError('STATE');
    return await work(owned, attempt);
  } catch (error) {
    if (error instanceof LocalCryptoInitializationError) throw error;
    throw new LocalCryptoInitializationError('UNAVAILABLE');
  } finally {
    if (owned) await releaseStore(owned);
  }
}

/** Reads structurally ready metadata. This capability does not open the vault or construct a client. */
export async function readExistingBootstrapAttempt(
  expected: LocalInitializationContext,
  dependencies: Pick<Dependencies, 'openExistingStore'>,
): Promise<ExistingBootstrapAttempt> {
  return readBootstrapAttempt(snapshotContext(expected), dependencies);
}

function readBootstrapAttempt(
  context: LocalInitializationContext,
  dependencies: Pick<Dependencies, 'openExistingStore'>,
) {
  return withExistingBootstrapStore(context, dependencies, async (store, attempt) => ({
    publicationBytes: encoder.encode(attempt.publication),
    operationMetadata: await store.getMetadata(initialBootstrapOperationMetadataKey),
  }));
}

/** Opens SQLCipher only for a snapshot read or a journal CAS with readback. */
export function createExistingBootstrapMetadataCapability(
  expected: LocalInitializationContext,
  dependencies: Pick<Dependencies, 'openExistingStore'>,
): ExistingBootstrapMetadataStore {
  const context = snapshotContext(expected);
  return issueBootstrapCapability({
    context,
    ...createBootstrapOperationMetadataStore(
      (work, expectedDigest) =>
        withExistingBootstrapStore(context, dependencies, (store, attempt) => {
          if (
            expectedDigest !== undefined &&
            expectedDigest !== digestPublication(encoder.encode(attempt.publication))
          ) {
            throw new LocalCryptoInitializationError('STATE');
          }
          return work(store);
        }),
      () => undefined,
    ),
    readAttempt: () => readBootstrapAttempt(context, dependencies),
  });
}

function createBootstrapStoreLifetime() {
  let closed = false;
  const pending = new Set<Promise<void>>();
  function assertAvailable() {
    if (closed) throw new LocalCryptoInitializationError('UNAVAILABLE');
  }
  return {
    assertAvailable,
    async run<T>(work: () => Promise<T>): Promise<T> {
      assertAvailable();
      let finish!: () => void;
      const operation = new Promise<void>((resolve) => {
        finish = resolve;
      });
      pending.add(operation);
      try {
        const value = await work();
        assertAvailable();
        return value;
      } finally {
        pending.delete(operation);
        finish();
      }
    },
    async drain() {
      closed = true;
      await Promise.all(pending);
    },
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function digestPublication(bytes: Uint8Array): string {
  return bytesToBase64(sha256(bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function validRegistrationId(id: unknown): id is number {
  return (
    typeof id === 'number' &&
    Number.isSafeInteger(id) &&
    id >= MIN_REGISTRATION_ID &&
    id <= MAX_REGISTRATION_ID
  );
}

function readAttempt(raw: string, context: LocalInitializationContext): Attempt {
  if (raw.length > 6 * maxPublicationBytes + 512) {
    throw new LocalCryptoInitializationError('STATE');
  }
  let value: Partial<Attempt> | null;
  try {
    value = JSON.parse(raw) as Partial<Attempt> | null;
  } catch {
    throw new LocalCryptoInitializationError('STATE');
  }
  if (
    !value ||
    value.version !== 1 ||
    (value.status !== 'pending' && value.status !== 'ready') ||
    !validRegistrationId(value.registrationId) ||
    typeof value.publication !== 'string' ||
    value.publication.length === 0 ||
    value.publication.length > maxPublicationBytes ||
    typeof value.account !== 'string' ||
    typeof value.device !== 'string' ||
    typeof value.vaultId !== 'string'
  ) {
    throw new LocalCryptoInitializationError('STATE');
  }
  const attempt: Attempt = {
    version: 1,
    account: value.account,
    device: value.device,
    vaultId: value.vaultId,
    status: value.status,
    registrationId: value.registrationId,
    publication: value.publication,
  };
  // Exact canonical bytes reject duplicate, missing and additional properties.
  if (JSON.stringify(attempt) !== raw) throw new LocalCryptoInitializationError('STATE');
  if (
    attempt.account !== context.account ||
    attempt.device !== context.device ||
    attempt.vaultId !== context.vaultId
  ) {
    throw new LocalCryptoInitializationError('CONTEXT');
  }
  return attempt;
}

async function persistAttempt(store: SqliteIdentityStore, prior: string | null, next: string) {
  try {
    await store.compareAndSetMetadata(initializationMetadataKey, prior, next);
  } catch {
    // The durable read decides whether a reported failure followed a commit.
  }
  try {
    if ((await store.getMetadata(initializationMetadataKey)) === next) return;
  } catch {
    // Report an uncertain write while the store cannot be read.
  }
  throw new LocalCryptoInitializationError('OUTCOME_UNKNOWN');
}

async function prepareAttempt(
  context: LocalInitializationContext,
  request: Extract<Request, { mode: 'create' }>,
  { random, argon2 }: Dependencies,
) {
  const generated = await generateIdentityKeyPair();
  let registrationId = generated.registrationId;
  while (!validRegistrationId(registrationId)) registrationId = await generateRegistrationId();
  const identity = prepareImportedIdentity(generated, registrationId);
  const keys = {
    dhPublicKey: base64ToBytes(identity.dhKey.publicKey),
    dhPrivateKey: base64ToBytes(identity.dhKey.privateKey),
    signingPublicKey: base64ToBytes(identity.signingKey.publicKey),
    signingPrivateKey: base64ToBytes(identity.signingKey.privateKey),
  };
  try {
    const payload = serializeRecoveryPayloadV1({ identity: keys, archiveKeys: [] });
    if (!payload.ok) throw new LocalCryptoInitializationError('STATE');
    try {
      const bytes = await createAccountVault(
        context,
        request.password,
        request.recoveryKey,
        payload.bytes,
        random,
        argon2,
      );
      const attempt: Attempt = {
        version: 1,
        ...context,
        status: 'pending',
        registrationId,
        publication: decoder.decode(bytes),
      };
      return { attempt, identity };
    } finally {
      payload.bytes.fill(0);
    }
  } finally {
    for (const bytes of Object.values(keys)) bytes.fill(0);
  }
}

async function recoverIdentity(
  attempt: Attempt,
  context: LocalInitializationContext,
  access: AccountVaultAccess,
  argon2: Argon2idProvider,
): Promise<IdentityKeyPair> {
  const bytes = encoder.encode(attempt.publication);
  const opened =
    access.type === 'password'
      ? await openAccountVaultWithPassword(bytes, access.password, context, argon2)
      : await openAccountVaultWithRecoveryKey(bytes, access.recoveryKey, context);
  return decodeInitialVaultIdentity(opened, attempt.registrationId);
}

function decodeInitialVaultIdentity(
  opened: Awaited<ReturnType<typeof openAccountVaultWithPassword>>,
  registrationId: number,
): IdentityKeyPair {
  if (!opened.ok) throw new LocalCryptoInitializationError('ACCESS');
  try {
    const revisions = opened.revisions;
    if (
      revisions.generation !== 1 ||
      revisions.contentRevision !== 1 ||
      revisions.passwordRevision !== 1 ||
      revisions.recoveryRevision !== 1
    ) {
      throw new LocalCryptoInitializationError('STATE');
    }
    return decodeRecoveryIdentity(opened.plaintext, registrationId);
  } finally {
    opened.plaintext.fill(0);
  }
}

function decodeRecoveryIdentity(plaintext: Uint8Array, registrationId: number): IdentityKeyPair {
  const decoded = decodeRecoveryPayloadV1(plaintext);
  if (!decoded.ok) throw new LocalCryptoInitializationError('STATE');
  const { identity, archiveKeys } = decoded.payload;
  try {
    if (archiveKeys.length !== 0) throw new LocalCryptoInitializationError('STATE');
    return prepareImportedIdentity(
      {
        dhKey: {
          publicKey: bytesToBase64(identity.dhPublicKey),
          privateKey: bytesToBase64(identity.dhPrivateKey),
        },
        signingKey: {
          publicKey: bytesToBase64(identity.signingPublicKey),
          privateKey: bytesToBase64(identity.signingPrivateKey),
        },
      },
      registrationId,
    );
  } finally {
    for (const key of Object.values(identity)) key.fill(0);
    for (const entry of archiveKeys) entry.key.fill(0);
  }
}

async function completeInitialization(
  store: SqliteIdentityStore,
  context: LocalInitializationContext,
  request: Request,
  dependencies: Dependencies,
) {
  const existing = await store.getMetadata(initializationMetadataKey);
  const local = await readLocalIdentity(store);
  let pending: string;
  let attempt: Attempt;
  let identity: IdentityKeyPair;
  if (request.mode === 'create') {
    if (existing !== null || !isLocalIdentityAbsent(local)) {
      throw new LocalCryptoInitializationError('STATE');
    }
    ({ attempt, identity } = await prepareAttempt(context, request, dependencies));
    pending = JSON.stringify(attempt);
    await persistAttempt(store, null, pending);
  } else {
    if (existing === null) throw new LocalCryptoInitializationError('STATE');
    pending = existing;
    attempt = readAttempt(existing, context);
    identity = await recoverIdentity(attempt, context, request.access, dependencies.argon2);
  }
  // Absence here relies on exclusive custody and the SDK's joint write of the keys and ID.
  // Its public reads also look empty if a raw writer removed only the ID.
  if (attempt.status === 'pending' && isLocalIdentityAbsent(local)) {
    try {
      await importIdentity(store, identity, attempt.registrationId);
    } catch {
      // Only a subsequent exact read can establish success after an uncertain import.
    }
    const observed = await readLocalIdentity(store).catch(() => undefined);
    if (!observed || !matchesLocalIdentity(observed, identity)) {
      throw new LocalCryptoInitializationError('OUTCOME_UNKNOWN');
    }
  } else if (!matchesLocalIdentity(local, identity)) {
    throw new LocalCryptoInitializationError('STATE');
  }
  const ready = JSON.stringify({ ...attempt, status: 'ready' });
  if (attempt.status === 'pending') await persistAttempt(store, pending, ready);
  if (
    (await store.getMetadata(initializationMetadataKey)) !== ready ||
    !matchesLocalIdentity(await readLocalIdentity(store), identity)
  ) {
    throw new LocalCryptoInitializationError('STATE');
  }
  return { publication: encoder.encode(attempt.publication), identity };
}

export async function initializeLocalCrypto(
  expected: LocalInitializationContext,
  input: Request,
  dependencies: Dependencies,
) {
  const context = snapshotContext(expected);
  if (input.mode === 'create') {
    try {
      encodeEnvelopePassword(input.password).fill(0);
      if (input.recoveryKey.length !== 32) throw new Error();
    } catch {
      throw new LocalCryptoInitializationError('ACCESS');
    }
  }
  const request: Request =
    input.mode === 'create'
      ? {
          mode: 'create',
          password: input.password,
          recoveryKey: Uint8Array.from(input.recoveryKey),
        }
      : {
          mode: 'resume',
          access:
            input.access.type === 'password'
              ? { type: 'password', password: input.access.password }
              : { type: 'recovery', recoveryKey: Uint8Array.from(input.access.recoveryKey) },
        };
  const recoveryKey =
    request.mode === 'create'
      ? request.recoveryKey
      : request.access.type === 'recovery'
        ? request.access.recoveryKey
        : undefined;
  let owned: SqliteIdentityStore | undefined;
  try {
    const store = acquireStore(
      request.mode === 'create'
        ? await dependencies.openFreshStore(context)
        : await dependencies.openExistingStore(context),
    );
    owned = store;
    requireProtectedStore(store);
    const initialized = await completeInitialization(store, context, request, dependencies);
    const publication = initialized.publication;
    const localRegistrationId = initialized.identity.registrationId;
    const verificationPublication = Uint8Array.from(publication);
    const lifetime = createBootstrapStoreLifetime();
    const publicationDigest = digestPublication(verificationPublication);
    const storage = createRestrictedSignalStore(store);
    const client = await createSignalProtocolClient({
      identity: { userId: context.account, enablePniKeys: false },
      adapters: { storage },
    });
    async function verifyOpenedIdentity(
      opened: Awaited<ReturnType<typeof openAccountVaultWithPassword>>,
    ) {
      const recovered = decodeInitialVaultIdentity(opened, localRegistrationId);
      lifetime.assertAvailable();
      if (!matchesLocalIdentity(await readLocalIdentity(store), recovered)) {
        throw new LocalCryptoInitializationError('STATE');
      }
    }

    function requirePublication(input: {
      account: string;
      vaultId: string;
      publicationBytes: Uint8Array;
    }) {
      if (
        input.account !== context.account ||
        input.vaultId !== context.vaultId ||
        !(input.publicationBytes instanceof Uint8Array) ||
        !bytesEqual(input.publicationBytes, verificationPublication)
      )
        throw new LocalCryptoInitializationError('ACCESS');
    }

    const bootstrap = issueBootstrapCapability({
      context,
      publicationDigest,
      get publication() {
        lifetime.assertAvailable();
        return Uint8Array.from(verificationPublication);
      },
      bootstrapOperationMetadata: Object.freeze(
        createBootstrapOperationMetadataStore(
          (work, expectedDigest) =>
            lifetime.run(() => {
              if (expectedDigest !== undefined && expectedDigest !== publicationDigest) {
                throw new LocalCryptoInitializationError('STATE');
              }
              return work(store);
            }),
          lifetime.assertAvailable,
        ),
      ),
      async verifyRecoveryKey(input: {
        readonly account: string;
        readonly vaultId: string;
        readonly publicationBytes: Uint8Array;
        readonly recoveryKey: Uint8Array;
      }) {
        return lifetime.run(async () => {
          requirePublication(input);
          const key = input.recoveryKey;
          if (!(key instanceof Uint8Array) || key.length !== 32) {
            throw new LocalCryptoInitializationError('ACCESS');
          }
          const recoveryKey = Uint8Array.from(key);
          try {
            await verifyOpenedIdentity(
              await openAccountVaultWithRecoveryKey(verificationPublication, recoveryKey, context),
            );
            return {
              method: 'account-vault-v1-recovery-open' as const,
              account: context.account,
              vaultId: context.vaultId,
              publicationDigest,
              recoveryRevision: 1 as const,
            };
          } finally {
            recoveryKey.fill(0);
          }
        });
      },
      async verifyActivationPassword(input: {
        readonly account: string;
        readonly vaultId: string;
        readonly publicationBytes: Uint8Array;
        readonly password: string;
      }) {
        return lifetime.run(async () => {
          requirePublication(input);
          const password = input.password;
          try {
            encodeEnvelopePassword(password).fill(0);
          } catch {
            throw new LocalCryptoInitializationError('ACCESS');
          }
          await verifyOpenedIdentity(
            await openAccountVaultWithPassword(
              verificationPublication,
              password,
              context,
              dependencies.argon2,
            ),
          );
          return {
            method: 'account-vault-v1-password-open' as const,
            account: context.account,
            vaultId: context.vaultId,
            publicationDigest,
          };
        });
      },
    });

    let closing: Promise<void> | undefined;
    return {
      status: 'ready' as const,
      publication,
      storage,
      client,
      bootstrap,
      close() {
        closing ??= (async () => {
          await lifetime.drain();
          verificationPublication.fill(0);
          try {
            await client.stop();
          } finally {
            await releaseStore(store);
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    if (owned) await releaseStore(owned);
    if (error instanceof LocalCryptoInitializationError) throw error;
    throw new LocalCryptoInitializationError('UNAVAILABLE');
  } finally {
    recoveryKey?.fill(0);
  }
}
