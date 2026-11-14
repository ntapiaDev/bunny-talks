import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import canonicalize from 'canonicalize';
import { visit } from 'jsonc-parser';
import { decodeBase64Url, encodeBase64Url as encode } from './base64url.js';
import type { CryptographicRandomSource } from './random-source.js';

export type KeyEnvelopeErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_ENVELOPE'
  | 'UNSUPPORTED_FORMAT'
  | 'LIMIT_EXCEEDED'
  | 'CONTEXT_MISMATCH'
  | 'AUTHENTICATION_FAILED'
  | 'CRYPTO_UNAVAILABLE';

/** Sanitized failure: no provider exception or secret is retained. */
export class KeyEnvelopeError extends Error {
  public constructor(public readonly code: KeyEnvelopeErrorCode) {
    super(code);
    this.name = 'KeyEnvelopeError';
  }
}
export interface KeyEnvelopeContext {
  readonly account: string;
  readonly vaultId: string;
}
export interface KeyEnvelopeMetadata extends KeyEnvelopeContext {
  readonly revision: number;
}
type Access = 'password' | 'recovery';
type Header = Readonly<
  KeyEnvelopeMetadata & {
    format: string;
    version: 1;
    access: Access;
    profile: string;
    domain: string;
    salt: string;
    nonce: string;
    outputBytes: 32;
    memoryKiB?: number;
    passes?: number;
    parallelism?: number;
    kdfVersion?: number;
  }
>;
export interface StructuralKeyEnvelope {
  readonly status: 'structural-only-unauthenticated';
  readonly header: Header;
  readonly ciphertext: string;
}
export type KeyEnvelopeValidation =
  | { readonly ok: true; readonly envelope: StructuralKeyEnvelope }
  | { readonly ok: false; readonly code: KeyEnvelopeErrorCode };
export type OpenKeyEnvelopeResult =
  | { readonly ok: true; readonly masterKey: Uint8Array }
  | { readonly ok: false; readonly code: KeyEnvelopeErrorCode };

const encoder = new TextEncoder();
const maximumBytes = 2048;
const commonFields = [
  'account',
  'vaultId',
  'revision',
  'format',
  'version',
  'access',
  'profile',
  'domain',
  'salt',
  'nonce',
  'outputBytes',
];
const passwordFields = ['memoryKiB', 'passes', 'parallelism', 'kdfVersion'];
const domain = (access: Access) => `bunny-talks/key-envelope/${access}/v1/wrapping-key`;
const profile = (access: Access) =>
  access === 'password'
    ? 'argon2id-64m-t3-p4-hkdf-sha256-xchacha20poly1305-v1'
    : 'hkdf-sha256-xchacha20poly1305-v1';
const fail = (code: KeyEnvelopeErrorCode): never => {
  throw new KeyEnvelopeError(code);
};

function canonical(value: unknown): string {
  let result: string | undefined;
  try {
    result = canonicalize(value);
  } catch {
    return fail('CRYPTO_UNAVAILABLE');
  }
  if (typeof result !== 'string') return fail('CRYPTO_UNAVAILABLE');
  return result;
}
function decode(value: unknown, length: number): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length !== Math.ceil((length * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    return fail('INVALID_INPUT');
  const bytes = decodeBase64Url(value);
  if (encode(bytes) !== value) return fail('INVALID_INPUT');
  return bytes;
}
function copy(bytes: Uint8Array, length: number): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) return fail('INVALID_INPUT');
  return Uint8Array.from(bytes);
}
export function snapshotKeyEnvelopeContext(value: KeyEnvelopeContext): KeyEnvelopeContext {
  if (!value || typeof value !== 'object') return fail('INVALID_INPUT');
  const account = value.account;
  const vaultId = value.vaultId;
  // Account references are opaque printable ASCII, never trimmed or normalized.
  if (typeof account !== 'string' || !/^[!-~]{1,128}$/.test(account)) return fail('INVALID_INPUT');
  decode(vaultId, 16);
  return { account, vaultId };
}
export function encodeEnvelopePassword(password: string): Uint8Array {
  if (
    typeof password !== 'string' ||
    password.length === 0 ||
    password.length > 1024 ||
    /[\uD800-\uDFFF]/u.test(password)
  )
    return fail('INVALID_INPUT');
  const bytes = encoder.encode(password);
  if (bytes.length > 1024) {
    bytes.fill(0);
    return fail('LIMIT_EXCEEDED');
  }
  return bytes;
}
export async function fillRandomBytes(
  length: number,
  random: CryptographicRandomSource,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(length);
  try {
    if (!random || typeof random.fill !== 'function') return fail('CRYPTO_UNAVAILABLE');
    await random.fill(bytes);
    if (bytes.byteLength !== length) return fail('CRYPTO_UNAVAILABLE');
    return bytes.slice();
  } catch {
    return fail('CRYPTO_UNAVAILABLE');
  } finally {
    if (bytes.byteLength > 0) bytes.fill(0);
  }
}
export const generateMasterKey = (random: CryptographicRandomSource): Promise<Uint8Array> =>
  fillRandomBytes(32, random);
export const generateRecoveryKey = (random: CryptographicRandomSource): Promise<Uint8Array> =>
  fillRandomBytes(32, random);
export async function generateVaultId(random: CryptographicRandomSource): Promise<string> {
  return encode(await fillRandomBytes(16, random));
}
async function passwordKey(bytes: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  let root: Uint8Array | undefined;
  try {
    root = await argon2idAsync(bytes, salt, {
      m: 65536,
      t: 3,
      p: 4,
      version: 0x13,
      dkLen: 32,
      maxmem: 64 * 1024 * 1024,
      asyncTick: 10,
    });
    return hkdf(sha256, root, salt, encoder.encode(domain('password')), 32);
  } catch {
    return fail('CRYPTO_UNAVAILABLE');
  } finally {
    root?.fill(0);
  }
}
/** Returned key is sensitive and belongs to the caller. No input buffer is mutated. */
export async function derivePasswordWrappingKey(
  password: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const bytes = encodeEnvelopePassword(password);
  let snapshot: Uint8Array | undefined;
  try {
    snapshot = copy(salt, 16);
    return await passwordKey(bytes, snapshot);
  } finally {
    bytes.fill(0);
    snapshot?.fill(0);
  }
}
export function deriveRecoveryWrappingKey(recoveryKey: Uint8Array, salt: Uint8Array): Uint8Array {
  const key = copy(recoveryKey, 32);
  let snapshot: Uint8Array | undefined;
  try {
    snapshot = copy(salt, 16);
    return hkdf(sha256, key, snapshot, encoder.encode(domain('recovery')), 32);
  } catch (error) {
    if (error instanceof KeyEnvelopeError) throw error;
    return fail('CRYPTO_UNAVAILABLE');
  } finally {
    key.fill(0);
    snapshot?.fill(0);
  }
}
function aad(header: Header): Uint8Array {
  return encoder.encode(`bunny-talks/key-envelope/${header.access}/v1/aad\n${canonical(header)}`);
}
async function create(
  access: Access,
  masterKey: Uint8Array,
  secret: string | Uint8Array,
  metadata: KeyEnvelopeMetadata,
  random: CryptographicRandomSource,
): Promise<Uint8Array> {
  const master = copy(masterKey, 32);
  let secretBytes: Uint8Array | undefined;
  let key: Uint8Array | undefined;
  try {
    const expected = snapshotKeyEnvelopeContext(metadata);
    const revision = metadata.revision;
    if (!Number.isSafeInteger(revision) || revision < 1) return fail('INVALID_INPUT');
    secretBytes =
      access === 'password'
        ? encodeEnvelopePassword(secret as string)
        : copy(secret as Uint8Array, 32);
    const salt = await fillRandomBytes(16, random);
    const nonce = await fillRandomBytes(24, random);
    const header: Header = {
      ...expected,
      revision,
      format: `bunny-${access}-key-envelope`,
      version: 1,
      access,
      profile: profile(access),
      domain: domain(access),
      salt: encode(salt),
      nonce: encode(nonce),
      outputBytes: 32,
      ...(access === 'password'
        ? { memoryKiB: 65536, passes: 3, parallelism: 4, kdfVersion: 19 }
        : {}),
    };
    key =
      access === 'password'
        ? await passwordKey(secretBytes, salt)
        : deriveRecoveryWrappingKey(secretBytes, salt);
    const ciphertext = xchacha20poly1305(key, nonce, aad(header)).encrypt(master);
    return encoder.encode(canonical({ ciphertext: encode(ciphertext), header }));
  } catch (error) {
    if (error instanceof KeyEnvelopeError) throw error;
    return fail('CRYPTO_UNAVAILABLE');
  } finally {
    master.fill(0);
    secretBytes?.fill(0);
    key?.fill(0);
  }
}
export function createPasswordKeyEnvelope(
  masterKey: Uint8Array,
  password: string,
  metadata: KeyEnvelopeMetadata,
  random: CryptographicRandomSource,
): Promise<Uint8Array> {
  return create('password', masterKey, password, metadata, random);
}
export function createRecoveryKeyEnvelope(
  masterKey: Uint8Array,
  recoveryKey: Uint8Array,
  metadata: KeyEnvelopeMetadata,
  random: CryptographicRandomSource,
): Promise<Uint8Array> {
  return create('recovery', masterKey, recoveryKey, metadata, random);
}
function validate(input: Uint8Array, access: Access): KeyEnvelopeValidation {
  try {
    if (!(input instanceof Uint8Array)) return fail('INVALID_ENVELOPE');
    if (input.length > maximumBytes) return fail('LIMIT_EXCEEDED');
    const snapshot = input.slice();
    if (snapshot[0] === 239 && snapshot[1] === 187 && snapshot[2] === 191)
      return fail('INVALID_ENVELOPE');
    if (typeof TextDecoder !== 'function') return fail('CRYPTO_UNAVAILABLE');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(snapshot);
    const stack: Set<string>[] = [];
    const allowedHeader = new Set([
      ...commonFields,
      ...(access === 'password' ? passwordFields : []),
    ]);
    visit(
      text,
      {
        onObjectBegin: () => {
          if (stack.length >= 2) fail('LIMIT_EXCEEDED');
          stack.push(new Set());
        },
        onObjectEnd: () => {
          stack.pop();
        },
        onObjectProperty: (name) => {
          const names = stack[stack.length - 1];
          if (
            !names ||
            names.has(name) ||
            !(stack.length === 1
              ? ['header', 'ciphertext'].includes(name)
              : allowedHeader.has(name))
          )
            fail('INVALID_ENVELOPE');
          names!.add(name);
        },
        onArrayBegin: () => fail('INVALID_ENVELOPE'),
        onError: () => fail('INVALID_ENVELOPE'),
      },
      { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false },
    );
    const value = JSON.parse(text) as { header?: Header; ciphertext?: unknown };
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).length !== 2 ||
      !value.header ||
      typeof value.header !== 'object' ||
      Array.isArray(value.header)
    )
      return fail('INVALID_ENVELOPE');
    const header = value.header;
    if (Object.keys(header).length !== allowedHeader.size) return fail('INVALID_ENVELOPE');
    if (
      header.version !== 1 ||
      header.format !== `bunny-${access}-key-envelope` ||
      header.access !== access ||
      header.profile !== profile(access) ||
      header.domain !== domain(access)
    )
      return fail('UNSUPPORTED_FORMAT');
    snapshotKeyEnvelopeContext(header);
    if (!Number.isSafeInteger(header.revision) || header.revision < 1 || header.outputBytes !== 32)
      return fail('INVALID_ENVELOPE');
    if (
      access === 'password' &&
      (header.memoryKiB !== 65536 ||
        header.passes !== 3 ||
        header.parallelism !== 4 ||
        header.kdfVersion !== 19)
    )
      return fail('INVALID_ENVELOPE');
    decode(header.salt, 16);
    decode(header.nonce, 24);
    decode(value.ciphertext, 48);
    if (canonical(value) !== text) return fail('INVALID_ENVELOPE');
    return {
      ok: true,
      envelope: Object.freeze({
        status: 'structural-only-unauthenticated',
        header: Object.freeze({ ...header }),
        ciphertext: value.ciphertext as string,
      }),
    };
  } catch (error) {
    if (error instanceof KeyEnvelopeError)
      return { ok: false, code: error.code === 'INVALID_INPUT' ? 'INVALID_ENVELOPE' : error.code };
    if (error instanceof SyntaxError || error instanceof TypeError)
      return { ok: false, code: 'INVALID_ENVELOPE' };
    return { ok: false, code: 'CRYPTO_UNAVAILABLE' };
  }
}
export const validatePasswordKeyEnvelope = (input: Uint8Array): KeyEnvelopeValidation =>
  validate(input, 'password');
export const validateRecoveryKeyEnvelope = (input: Uint8Array): KeyEnvelopeValidation =>
  validate(input, 'recovery');
async function open(
  access: Access,
  input: Uint8Array,
  secret: string | Uint8Array,
  expectedContext: KeyEnvelopeContext,
): Promise<OpenKeyEnvelopeResult> {
  let secretBytes: Uint8Array | undefined;
  let key: Uint8Array | undefined;
  try {
    const validation = validate(input, access);
    if (!validation.ok) return validation;
    const expected = snapshotKeyEnvelopeContext(expectedContext);
    const { header, ciphertext } = validation.envelope;
    if (expected.account !== header.account || expected.vaultId !== header.vaultId)
      return fail('CONTEXT_MISMATCH');
    secretBytes =
      access === 'password'
        ? encodeEnvelopePassword(secret as string)
        : copy(secret as Uint8Array, 32);
    const salt = decode(header.salt, 16);
    key =
      access === 'password'
        ? await passwordKey(secretBytes, salt)
        : deriveRecoveryWrappingKey(secretBytes, salt);
    try {
      return {
        ok: true,
        masterKey: xchacha20poly1305(key, decode(header.nonce, 24), aad(header)).decrypt(
          decode(ciphertext, 48),
        ),
      };
    } catch (error) {
      // Version-pinned Noble 2.4.0 exposes no typed authentication failure.
      if (error instanceof Error && error.message === 'invalid tag')
        return fail('AUTHENTICATION_FAILED');
      return fail('CRYPTO_UNAVAILABLE');
    }
  } catch (error) {
    return {
      ok: false,
      code: error instanceof KeyEnvelopeError ? error.code : 'CRYPTO_UNAVAILABLE',
    };
  } finally {
    key?.fill(0);
    secretBytes?.fill(0);
  }
}
export function openPasswordKeyEnvelope(
  input: Uint8Array,
  password: string,
  expectedContext: KeyEnvelopeContext,
): Promise<OpenKeyEnvelopeResult> {
  return open('password', input, password, expectedContext);
}
export function openRecoveryKeyEnvelope(
  input: Uint8Array,
  recoveryKey: Uint8Array,
  expectedContext: KeyEnvelopeContext,
): Promise<OpenKeyEnvelopeResult> {
  return open('recovery', input, recoveryKey, expectedContext);
}
