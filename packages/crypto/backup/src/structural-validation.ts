import canonicalize from 'canonicalize';
import { visit } from 'jsonc-parser';

const MAX_ENVELOPE_BYTES = 131_072;
const MAX_CIPHERTEXT_BYTES = 65_552;
const MAX_CIPHERTEXT_CHARS = Math.ceil((MAX_CIPHERTEXT_BYTES * 4) / 3);
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const ROOT_FIELDS = new Set(['ciphertext', 'header']);
const HEADER_FIELDS = new Set([
  'account',
  'format',
  'generation',
  'nonce',
  'profile',
  'purpose',
  'salt',
  'version',
]);

export type StructuralValidationError =
  'INVALID_ENVELOPE' | 'UNSUPPORTED_FORMAT' | 'LIMIT_EXCEEDED';

export interface StructurallyValidEnvelopeV1 {
  readonly status: 'structural-only-unauthenticated';
  readonly header: Readonly<{
    account: string;
    format: 'bunny-recovery-vault-direct';
    generation: number;
    nonce: string;
    profile: 'hkdf-sha256-xchacha20poly1305-v1';
    purpose: 'identity-recovery';
    salt: string;
    version: 1;
  }>;
  readonly ciphertext: string;
}

export type StructuralValidationResult =
  | { readonly ok: true; readonly envelope: StructurallyValidEnvelopeV1 }
  | { readonly ok: false; readonly code: StructuralValidationError };

class RejectedInput extends Error {
  constructor(readonly code: StructuralValidationError) {
    super('Invalid envelope');
  }
}

function reject(code: StructuralValidationError = 'INVALID_ENVELOPE'): never {
  throw new RejectedInput(code);
}

function isCanonicalBase64Url(value: unknown, minBytes: number, maxBytes: number): value is string {
  if (typeof value !== 'string' || value.length > Math.ceil((maxBytes * 4) / 3)) return false;
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return false;
  const byteLength = Math.floor((value.length * 3) / 4);
  if (byteLength < minBytes || byteLength > maxBytes) return false;
  const remainder = value.length % 4;
  if (remainder === 0) return true;
  const last = ALPHABET.indexOf(value[value.length - 1]!);
  return remainder === 2 ? (last & 15) === 0 : (last & 3) === 0;
}

function inspectJson(text: string): void {
  const fieldsByObject: Set<string>[] = [];
  visit(
    text,
    {
      onObjectBegin: () => {
        if (fieldsByObject.length >= 2) reject('LIMIT_EXCEEDED');
        fieldsByObject.push(new Set());
      },
      onObjectProperty: (property) => {
        const fields = fieldsByObject[fieldsByObject.length - 1];
        const allowed = fieldsByObject.length === 1 ? ROOT_FIELDS : HEADER_FIELDS;
        if (!fields || !allowed.has(property) || fields.has(property)) reject();
        fields.add(property);
      },
      onObjectEnd: () => {
        fieldsByObject.pop();
      },
      onArrayBegin: () => reject(),
      onLiteralValue: (value: unknown) => {
        if (typeof value === 'string' && value.length > MAX_CIPHERTEXT_CHARS)
          reject('LIMIT_EXCEEDED');
      },
      onError: () => reject(),
    },
    { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false },
  );
}

/** Checks shape and encoding only; it does not authenticate the envelope or account. */
export function validateEnvelopeStructureV1(input: Uint8Array): StructuralValidationResult {
  if (input.byteLength > MAX_ENVELOPE_BYTES) return { ok: false, code: 'LIMIT_EXCEEDED' };
  const snapshot = Uint8Array.from(input);
  if (snapshot[0] === 0xef && snapshot[1] === 0xbb && snapshot[2] === 0xbf) {
    return { ok: false, code: 'INVALID_ENVELOPE' };
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let text: string;
  try {
    text = decoder.decode(snapshot);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { ok: false, code: 'INVALID_ENVELOPE' };
  }
  try {
    inspectJson(text);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError) reject();
      throw error;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
    const root = value as Record<string, unknown>;
    if (
      Object.keys(root).length !== 2 ||
      !root.header ||
      typeof root.header !== 'object' ||
      Array.isArray(root.header)
    )
      reject();
    const header = root.header as Record<string, unknown>;
    if (Object.keys(header).length !== 8) reject();
    if (
      header.format !== 'bunny-recovery-vault-direct' ||
      header.version !== 1 ||
      header.profile !== 'hkdf-sha256-xchacha20poly1305-v1'
    )
      reject('UNSUPPORTED_FORMAT');
    if (
      header.purpose !== 'identity-recovery' ||
      typeof header.generation !== 'number' ||
      !Number.isSafeInteger(header.generation) ||
      header.generation < 1
    )
      reject();
    if (
      !isCanonicalBase64Url(header.account, 16, 16) ||
      !isCanonicalBase64Url(header.salt, 16, 16) ||
      !isCanonicalBase64Url(header.nonce, 24, 24) ||
      !isCanonicalBase64Url(root.ciphertext, 16, MAX_CIPHERTEXT_BYTES)
    )
      reject();
    if (canonicalize(value) !== text) reject();
    return {
      ok: true,
      envelope: Object.freeze({
        status: 'structural-only-unauthenticated' as const,
        header: Object.freeze({
          account: header.account,
          format: 'bunny-recovery-vault-direct' as const,
          generation: header.generation,
          nonce: header.nonce,
          profile: 'hkdf-sha256-xchacha20poly1305-v1' as const,
          purpose: 'identity-recovery' as const,
          salt: header.salt,
          version: 1 as const,
        }),
        ciphertext: root.ciphertext,
      }),
    };
  } catch (error) {
    if (error instanceof RejectedInput) return { ok: false, code: error.code };
    throw error;
  }
}
