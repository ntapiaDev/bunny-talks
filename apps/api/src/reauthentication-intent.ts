import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  ordinaryPasswordChangeSchema,
  publicationDigestSchema,
  vaultCryptoRevisionsSchema,
} from '@bunny-talks/validation';
import { validatePasswordVerifier } from './password-verifier.js';
import type { PreparedPasswordChange } from './postgres-vault-repository.js';

export class ReauthenticationError extends Error {
  public constructor(public readonly code: 'INVALID_GRANT' | 'INVALID_INTENT' | 'OUTCOME_UNKNOWN') {
    super(code);
    this.name = 'ReauthenticationError';
  }
}
export function passwordChangeIntent(request: unknown, prepared: PreparedPasswordChange) {
  const parsed = ordinaryPasswordChangeSchema.safeParse(request);
  if (
    !parsed.success ||
    !validatePasswordVerifier(prepared?.verifier) ||
    !publicationDigestSchema.safeParse(prepared?.candidateDigest).success ||
    !publicationDigestSchema.safeParse(prepared?.expectedPublicationDigest).success ||
    !vaultCryptoRevisionsSchema.shape.generation.safeParse(prepared?.expectedGeneration).success
  )
    throw new ReauthenticationError('INVALID_INTENT');
  const r = parsed.data;
  const candidate = createHash('sha256')
    .update(Buffer.from(r.publicationBase64Url, 'base64url'))
    .digest('base64url');
  if (candidate !== prepared.candidateDigest) throw new ReauthenticationError('INVALID_INTENT');
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        'bunny-talks/reauthentication/intent/v2',
        'ordinary-password-change',
        r.transportVersion,
        r.account,
        r.operationId,
        r.vaultId,
        r.expected.storageRevision,
        r.expected.credentialRevision,
        candidate,
        prepared.expectedPublicationDigest,
        prepared.expectedGeneration,
        prepared.verifier,
      ]),
    )
    .digest();
  return { request: r, hash };
}
