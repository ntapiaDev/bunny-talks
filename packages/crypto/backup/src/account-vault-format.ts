import canonicalize from 'canonicalize';
import { visit } from 'jsonc-parser';
import { decodeBase64Url, encodeBase64Url } from './base64url.js';
import type { KeyEnvelopeContext, KeyEnvelopeErrorCode } from './key-envelopes.js';
import {
  KeyEnvelopeError,
  snapshotKeyEnvelopeContext,
  validatePasswordKeyEnvelope,
  validateRecoveryKeyEnvelope,
} from './key-envelopes.js';

export type AccountVaultErrorCode = KeyEnvelopeErrorCode | 'INVALID_VAULT';
export class AccountVaultError extends Error {
  public constructor(public readonly code: AccountVaultErrorCode) {
    super(code);
    this.name = 'AccountVaultError';
  }
}
export function rejectVault(code: AccountVaultErrorCode): never {
  throw new AccountVaultError(code);
}
export function vaultFailure(error: unknown): AccountVaultErrorCode {
  return error instanceof AccountVaultError || error instanceof KeyEnvelopeError
    ? error.code
    : 'CRYPTO_UNAVAILABLE';
}
export const vaultEncoder = new TextEncoder();
export const VAULT_SUITE = 'hkdf-sha256-xchacha20poly1305-hmac-sha256-v1';
export interface VaultHeader extends KeyEnvelopeContext {
  readonly format: 'bunny-account-vault';
  readonly version: 1;
  readonly suite: typeof VAULT_SUITE;
}
export interface VaultContent {
  readonly version: 1;
  readonly revision: number;
  readonly nonce: string;
  readonly ciphertext: string;
}
export interface VaultPublication {
  readonly header: VaultHeader;
  readonly content: string;
  readonly passwordEnvelope: string;
  readonly recoveryEnvelope: string;
  readonly manifest: { readonly version: 1; readonly generation: number; readonly mac: string };
}
export interface ParsedVault {
  readonly publication: VaultPublication;
  readonly content: VaultContent;
  readonly passwordRevision: number;
  readonly recoveryRevision: number;
}
export interface AccountVaultRevisions {
  readonly generation: number;
  readonly contentRevision: number;
  readonly passwordRevision: number;
  readonly recoveryRevision: number;
}
export function revisions(parsed: ParsedVault): AccountVaultRevisions {
  return {
    generation: parsed.publication.manifest.generation,
    contentRevision: parsed.content.revision,
    passwordRevision: parsed.passwordRevision,
    recoveryRevision: parsed.recoveryRevision,
  };
}
export function vaultCanonical(value: unknown): string {
  try {
    const text = canonicalize(value);
    if (typeof text === 'string') return text;
  } catch {
    return rejectVault('CRYPTO_UNAVAILABLE');
  }
  return rejectVault('CRYPTO_UNAVAILABLE');
}
export function vaultBase64(value: unknown, min: number, max = min): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil((max * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length % 4 === 1
  )
    return rejectVault('INVALID_VAULT');
  const bytes = decodeBase64Url(value);
  if (bytes.length < min || bytes.length > max || encodeBase64Url(bytes) !== value)
    return rejectVault('INVALID_VAULT');
  return bytes;
}
export function vaultObject(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return rejectVault('INVALID_VAULT');
  const keys = Object.keys(value);
  if (keys.length !== names.length || keys.some((key) => !names.includes(key)))
    return rejectVault('INVALID_VAULT');
  return value as Record<string, unknown>;
}
export function vaultCounter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    return rejectVault('INVALID_VAULT');
  return value;
}
function parseCanonical(input: Uint8Array, maximum: number): unknown {
  if (!(input instanceof Uint8Array)) return rejectVault('INVALID_VAULT');
  if (input.length > maximum) return rejectVault('LIMIT_EXCEEDED');
  const snapshot = Uint8Array.from(input);
  if (snapshot[0] === 239 && snapshot[1] === 187 && snapshot[2] === 191)
    return rejectVault('INVALID_VAULT');
  if (typeof TextDecoder !== 'function') return rejectVault('CRYPTO_UNAVAILABLE');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(snapshot);
  } catch {
    return rejectVault('INVALID_VAULT');
  }
  const stack: Set<string>[] = [];
  visit(
    text,
    {
      onObjectBegin: () => {
        if (stack.length >= 2) rejectVault('LIMIT_EXCEEDED');
        stack.push(new Set());
      },
      onObjectEnd: () => {
        stack.pop();
      },
      onObjectProperty: (name) => {
        const fields = stack[stack.length - 1];
        if (!fields || fields.has(name) || fields.size >= 6) return rejectVault('INVALID_VAULT');
        fields.add(name);
      },
      onArrayBegin: () => rejectVault('INVALID_VAULT'),
      onError: () => rejectVault('INVALID_VAULT'),
    },
    { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false },
  );
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return rejectVault('INVALID_VAULT');
  }
  if (vaultCanonical(value) !== text) return rejectVault('INVALID_VAULT');
  return value;
}
export function parseVault(input: Uint8Array, expectedContext: KeyEnvelopeContext): ParsedVault {
  const expected = snapshotKeyEnvelopeContext(expectedContext);
  const root = vaultObject(parseCanonical(input, 131072), [
    'header',
    'content',
    'passwordEnvelope',
    'recoveryEnvelope',
    'manifest',
  ]);
  const header = vaultObject(root.header, ['format', 'version', 'suite', 'account', 'vaultId']);
  const manifest = vaultObject(root.manifest, ['version', 'generation', 'mac']);
  if (
    header.format !== 'bunny-account-vault' ||
    header.version !== 1 ||
    header.suite !== VAULT_SUITE ||
    manifest.version !== 1
  )
    return rejectVault('UNSUPPORTED_FORMAT');
  if (header.account !== expected.account || header.vaultId !== expected.vaultId)
    return rejectVault('CONTEXT_MISMATCH');
  const generation = vaultCounter(manifest.generation);
  vaultBase64(manifest.mac, 32);
  if (
    typeof root.content !== 'string' ||
    typeof root.passwordEnvelope !== 'string' ||
    typeof root.recoveryEnvelope !== 'string'
  )
    return rejectVault('INVALID_VAULT');
  const content = vaultObject(parseCanonical(vaultEncoder.encode(root.content), 88000), [
    'version',
    'revision',
    'nonce',
    'ciphertext',
  ]);
  if (content.version !== 1) return rejectVault('UNSUPPORTED_FORMAT');
  const contentRevision = vaultCounter(content.revision);
  vaultBase64(content.nonce, 24);
  vaultBase64(content.ciphertext, 16, 65552);
  const password = validatePasswordKeyEnvelope(vaultEncoder.encode(root.passwordEnvelope));
  const recovery = validateRecoveryKeyEnvelope(vaultEncoder.encode(root.recoveryEnvelope));
  if (!password.ok) return rejectVault(password.code);
  if (!recovery.ok) return rejectVault(recovery.code);
  for (const envelope of [password.envelope, recovery.envelope]) {
    if (
      envelope.header.account !== expected.account ||
      envelope.header.vaultId !== expected.vaultId
    )
      return rejectVault('CONTEXT_MISMATCH');
    if (envelope.header.revision > generation) return rejectVault('INVALID_VAULT');
  }
  if (contentRevision > generation) return rejectVault('INVALID_VAULT');
  // All values originate in bounded JSON and have now passed the exact schema.
  return {
    publication: root as unknown as VaultPublication,
    content: content as unknown as VaultContent,
    passwordRevision: password.envelope.header.revision,
    recoveryRevision: recovery.envelope.header.revision,
  };
}
export type ValidateAccountVaultResult =
  | {
      readonly ok: true;
      readonly status: 'structural-only-unauthenticated';
      readonly revisions: AccountVaultRevisions;
    }
  | { readonly ok: false; readonly code: AccountVaultErrorCode };
export function validateAccountVault(
  input: Uint8Array,
  expectedContext: KeyEnvelopeContext,
): ValidateAccountVaultResult {
  try {
    return {
      ok: true,
      status: 'structural-only-unauthenticated',
      revisions: revisions(parseVault(input, expectedContext)),
    };
  } catch (error) {
    return { ok: false, code: vaultFailure(error) };
  }
}
