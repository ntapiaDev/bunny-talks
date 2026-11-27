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
import {
  createRestrictedSignalStore,
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

const ownedStores = new WeakSet<SqliteIdentityStore>();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const maxPublicationBytes = 131072;

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
    const decoded = decodeRecoveryPayloadV1(opened.plaintext);
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
        attempt.registrationId,
      );
    } finally {
      for (const key of Object.values(identity)) key.fill(0);
      for (const entry of archiveKeys) entry.key.fill(0);
    }
  } finally {
    opened.plaintext.fill(0);
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
  return encoder.encode(attempt.publication);
}

export async function initializeLocalCrypto(
  expected: LocalInitializationContext,
  input: Request,
  dependencies: Dependencies,
) {
  const context = Object.freeze({
    account: expected.account,
    device: expected.device,
    vaultId: expected.vaultId,
  });
  const vaultIdentifier = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
  if (
    !/^[!-~]{1,128}$/u.test(context.account) ||
    !vaultIdentifier.test(context.vaultId) ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(context.device)
  ) {
    throw new LocalCryptoInitializationError('CONTEXT');
  }
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
    const store =
      request.mode === 'create'
        ? await dependencies.openFreshStore(context)
        : await dependencies.openExistingStore(context);
    if (ownedStores.has(store)) throw new LocalCryptoInitializationError('UNAVAILABLE');
    ownedStores.add(store);
    owned = store;
    if (store.protection.atRest !== 'file-cipher') {
      throw new LocalCryptoInitializationError('UNAVAILABLE');
    }
    const publication = await completeInitialization(store, context, request, dependencies);
    const storage = createRestrictedSignalStore(store);
    const client = await createSignalProtocolClient({
      identity: { userId: context.account, enablePniKeys: false },
      adapters: { storage },
    });
    let closing: Promise<void> | undefined;
    return {
      status: 'ready' as const,
      publication,
      storage,
      client,
      close() {
        closing ??= (async () => {
          try {
            await client.stop();
          } finally {
            await store.close();
            ownedStores.delete(store);
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    if (owned) {
      try {
        await owned.close();
        ownedStores.delete(owned);
      } catch {
        throw new LocalCryptoInitializationError('UNAVAILABLE');
      }
    }
    if (error instanceof LocalCryptoInitializationError) throw error;
    throw new LocalCryptoInitializationError('UNAVAILABLE');
  } finally {
    recoveryKey?.fill(0);
  }
}
