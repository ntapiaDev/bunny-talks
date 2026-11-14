import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { equalBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type {
  AccountVaultErrorCode,
  AccountVaultRevisions,
  ParsedVault,
  VaultContent,
  VaultPublication,
} from './account-vault-format.js';
import {
  AccountVaultError,
  parseVault,
  rejectVault,
  revisions,
  VAULT_SUITE,
  vaultBase64,
  vaultCanonical,
  vaultEncoder,
  vaultFailure,
} from './account-vault-format.js';
import { encodeBase64Url } from './base64url.js';
import type { KeyEnvelopeContext } from './key-envelopes.js';
import {
  createPasswordKeyEnvelope,
  createRecoveryKeyEnvelope,
  encodeEnvelopePassword,
  fillRandomBytes,
  generateMasterKey,
  openPasswordKeyEnvelope,
  openRecoveryKeyEnvelope,
  snapshotKeyEnvelopeContext,
} from './key-envelopes.js';
import type { CryptographicRandomSource } from './random-source.js';

export type AccountVaultAccess =
  | { readonly type: 'password'; readonly password: string }
  | { readonly type: 'recovery'; readonly recoveryKey: Uint8Array };
export type OpenAccountVaultResult =
  | { readonly ok: true; readonly plaintext: Uint8Array; readonly revisions: AccountVaultRevisions }
  | { readonly ok: false; readonly code: AccountVaultErrorCode };
function snapshotAccess(access: AccountVaultAccess): AccountVaultAccess {
  if (!access || typeof access !== 'object') return rejectVault('INVALID_INPUT');
  if (access.type === 'password') {
    const password = access.password;
    encodeEnvelopePassword(password).fill(0);
    return { type: 'password', password };
  }
  if (
    access.type === 'recovery' &&
    access.recoveryKey instanceof Uint8Array &&
    access.recoveryKey.length === 32
  )
    return { type: 'recovery', recoveryKey: Uint8Array.from(access.recoveryKey) };
  return rejectVault('INVALID_INPUT');
}
function releaseAccess(access: AccountVaultAccess | undefined): void {
  if (access?.type === 'recovery') access.recoveryKey.fill(0);
}
function subkey(
  master: Uint8Array,
  publication: VaultPublication,
  usage: 'content-key' | 'manifest-key',
): Uint8Array {
  return hkdf(
    sha256,
    master,
    vaultBase64(publication.header.vaultId, 16),
    vaultEncoder.encode(`bunny-talks/account-vault/v1/${usage}`),
    32,
  );
}
function macInput(publication: VaultPublication): Uint8Array {
  const body = {
    ...publication,
    manifest: {
      version: publication.manifest.version,
      generation: publication.manifest.generation,
    },
  };
  return vaultEncoder.encode(`bunny-talks/account-vault/v1/manifest\n${vaultCanonical(body)}`);
}
function manifestMac(publication: VaultPublication, master: Uint8Array): Uint8Array {
  const key = subkey(master, publication, 'manifest-key');
  try {
    return hmac(sha256, key, macInput(publication));
  } finally {
    key.fill(0);
  }
}
function sign(publication: VaultPublication, master: Uint8Array): VaultPublication {
  const mac = manifestMac(publication, master);
  try {
    return {
      ...publication,
      manifest: { ...publication.manifest, mac: encodeBase64Url(mac) },
    };
  } finally {
    mac.fill(0);
  }
}
function contentAad(publication: VaultPublication, content: VaultContent): Uint8Array {
  return vaultEncoder.encode(
    `bunny-talks/account-vault/v1/content\n${vaultCanonical({
      header: publication.header,
      content: { version: content.version, revision: content.revision, nonce: content.nonce },
    })}`,
  );
}
function authenticate(parsed: ParsedVault, master: Uint8Array): Uint8Array {
  const { publication, content } = parsed;
  const mac = manifestMac(publication, master);
  try {
    if (!equalBytes(mac, vaultBase64(publication.manifest.mac, 32)))
      return rejectVault('AUTHENTICATION_FAILED');
  } finally {
    mac.fill(0);
  }
  const key = subkey(master, publication, 'content-key');
  try {
    return xchacha20poly1305(
      key,
      vaultBase64(content.nonce, 24),
      contentAad(publication, content),
    ).decrypt(vaultBase64(content.ciphertext, 16, 65552));
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid tag')
      return rejectVault('AUTHENTICATION_FAILED');
    return rejectVault('CRYPTO_UNAVAILABLE');
  } finally {
    key.fill(0);
  }
}
async function unlock(
  parsed: ParsedVault,
  access: AccountVaultAccess,
  context: KeyEnvelopeContext,
): Promise<Uint8Array> {
  const { publication } = parsed;
  const result =
    access.type === 'password'
      ? await openPasswordKeyEnvelope(
          vaultEncoder.encode(publication.passwordEnvelope),
          access.password,
          context,
        )
      : await openRecoveryKeyEnvelope(
          vaultEncoder.encode(publication.recoveryEnvelope),
          access.recoveryKey,
          context,
        );
  if (!result.ok) return rejectVault(result.code);
  return result.masterKey;
}
function increment(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) return rejectVault('LIMIT_EXCEEDED');
  return value + 1;
}
/** Returns a complete candidate publication; no persistence or account activation is performed. */
export async function createAccountVault(
  context: KeyEnvelopeContext,
  password: string,
  recoveryKey: Uint8Array,
  plaintext: Uint8Array,
  random: CryptographicRandomSource,
): Promise<Uint8Array> {
  let master: Uint8Array | undefined;
  let recovery: AccountVaultAccess | undefined;
  let payload: Uint8Array | undefined;
  let contentKey: Uint8Array | undefined;
  try {
    const expected = snapshotKeyEnvelopeContext(context);
    encodeEnvelopePassword(password).fill(0);
    recovery = snapshotAccess({ type: 'recovery', recoveryKey });
    if (recovery.type !== 'recovery') return rejectVault('INVALID_INPUT');
    if (!(plaintext instanceof Uint8Array)) return rejectVault('INVALID_INPUT');
    if (plaintext.length > 65536) return rejectVault('LIMIT_EXCEEDED');
    payload = Uint8Array.from(plaintext);
    master = await generateMasterKey(random);
    const metadata = { ...expected, revision: 1 };
    const passwordEnvelope = await createPasswordKeyEnvelope(master, password, metadata, random);
    const recoveryEnvelope = await createRecoveryKeyEnvelope(
      master,
      recovery.recoveryKey,
      metadata,
      random,
    );
    // Verify both actual access paths; authenticated inclusion alone is insufficient.
    const checks: Awaited<ReturnType<typeof openPasswordKeyEnvelope>>[] = [];
    try {
      checks.push(await openPasswordKeyEnvelope(passwordEnvelope, password, expected));
      checks.push(await openRecoveryKeyEnvelope(recoveryEnvelope, recovery.recoveryKey, expected));
      for (const check of checks) {
        if (!check.ok) return rejectVault(check.code);
        if (!equalBytes(check.masterKey, master)) return rejectVault('AUTHENTICATION_FAILED');
      }
    } finally {
      for (const check of checks) if (check.ok) check.masterKey.fill(0);
    }
    const nonce = await fillRandomBytes(24, random);
    let content: VaultContent = {
      version: 1,
      revision: 1,
      nonce: encodeBase64Url(nonce),
      ciphertext: '',
    };
    let publication: VaultPublication = {
      header: { ...expected, format: 'bunny-account-vault', version: 1, suite: VAULT_SUITE },
      content: '',
      passwordEnvelope: new TextDecoder().decode(passwordEnvelope),
      recoveryEnvelope: new TextDecoder().decode(recoveryEnvelope),
      manifest: { version: 1, generation: 1, mac: '' },
    };
    contentKey = subkey(master, publication, 'content-key');
    content = {
      ...content,
      ciphertext: encodeBase64Url(
        xchacha20poly1305(contentKey, nonce, contentAad(publication, content)).encrypt(payload),
      ),
    };
    publication = sign({ ...publication, content: vaultCanonical(content) }, master);
    const output = vaultEncoder.encode(vaultCanonical(publication));
    const verified = authenticate(parseVault(output, expected), master);
    try {
      if (!equalBytes(verified, payload)) return rejectVault('AUTHENTICATION_FAILED');
    } finally {
      verified.fill(0);
    }
    return output;
  } catch (error) {
    throw new AccountVaultError(vaultFailure(error));
  } finally {
    master?.fill(0);
    releaseAccess(recovery);
    payload?.fill(0);
    contentKey?.fill(0);
  }
}
async function open(
  input: Uint8Array,
  access: AccountVaultAccess,
  context: KeyEnvelopeContext,
): Promise<OpenAccountVaultResult> {
  let saved: AccountVaultAccess | undefined;
  let master: Uint8Array | undefined;
  try {
    const parsed = parseVault(input, context);
    const expected = snapshotKeyEnvelopeContext(parsed.publication.header);
    saved = snapshotAccess(access);
    master = await unlock(parsed, saved, expected);
    return { ok: true, plaintext: authenticate(parsed, master), revisions: revisions(parsed) };
  } catch (error) {
    return { ok: false, code: vaultFailure(error) };
  } finally {
    master?.fill(0);
    releaseAccess(saved);
  }
}
export function openAccountVaultWithPassword(
  input: Uint8Array,
  password: string,
  context: KeyEnvelopeContext,
): Promise<OpenAccountVaultResult> {
  return open(input, { type: 'password', password }, context);
}
export function openAccountVaultWithRecoveryKey(
  input: Uint8Array,
  recoveryKey: Uint8Array,
  context: KeyEnvelopeContext,
): Promise<OpenAccountVaultResult> {
  return open(input, { type: 'recovery', recoveryKey }, context);
}
/** Authenticates the complete old publication before producing a new immutable candidate. */
export async function rewrapAccountVaultPassword(
  input: Uint8Array,
  context: KeyEnvelopeContext,
  access: AccountVaultAccess,
  newPassword: string,
  random: CryptographicRandomSource,
): Promise<Uint8Array> {
  let master: Uint8Array | undefined;
  let saved: AccountVaultAccess | undefined;
  try {
    const parsed = parseVault(input, context);
    const expected = snapshotKeyEnvelopeContext(parsed.publication.header);
    encodeEnvelopePassword(newPassword).fill(0);
    const generation = increment(parsed.publication.manifest.generation);
    const revision = increment(parsed.passwordRevision);
    saved = snapshotAccess(access);
    master = await unlock(parsed, saved, expected);
    authenticate(parsed, master).fill(0);
    const envelope = await createPasswordKeyEnvelope(
      master,
      newPassword,
      { ...expected, revision },
      random,
    );
    const verified = await openPasswordKeyEnvelope(envelope, newPassword, expected);
    if (!verified.ok) return rejectVault(verified.code);
    try {
      if (!equalBytes(verified.masterKey, master)) return rejectVault('AUTHENTICATION_FAILED');
    } finally {
      verified.masterKey.fill(0);
    }
    const next = sign(
      {
        ...parsed.publication,
        passwordEnvelope: new TextDecoder().decode(envelope),
        manifest: { version: 1, generation, mac: '' },
      },
      master,
    );
    const output = vaultEncoder.encode(vaultCanonical(next));
    authenticate(parseVault(output, expected), master).fill(0);
    return output;
  } catch (error) {
    throw new AccountVaultError(vaultFailure(error));
  } finally {
    master?.fill(0);
    releaseAccess(saved);
  }
}
