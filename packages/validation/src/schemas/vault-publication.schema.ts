import { z } from 'zod';

/** Decimal PostgreSQL bigint without leading zeros or lossy number conversion. */
export const databaseRevisionSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
const operationId = z.uuid().refine((value) => value === value.toLowerCase());
const account = z.string().regex(/^[!-~]{1,128}$/);
const vaultId = z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/);
/** Canonical unpadded base64url encoding of a 32-byte SHA-256 digest. */
export const publicationDigestSchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
// A 131072-byte publication encodes to at most 174763 unpadded characters.
const publication = z
  .string()
  .min(1)
  .max(174763)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine(
    (value) =>
      value.length % 4 !== 1 &&
      (value.length % 4 === 0 ||
        (value.length % 4 === 2 ? 'AQgw' : 'AEIMQUYcgkosw048').includes(value.at(-1)!)),
  );
export const vaultCasSchema = z.strictObject({
  storageRevision: databaseRevisionSchema,
  credentialRevision: databaseRevisionSchema,
});
export const initialVaultPublicationSchema = z.strictObject({
  transportVersion: z.literal(1),
  operationId,
  account,
  vaultId,
  expectedCredentialRevision: databaseRevisionSchema,
  expectedStorageRevision: z.null(),
  publicationBase64Url: publication,
});
export const ordinaryPasswordChangeSchema = z.strictObject({
  transportVersion: z.literal(1),
  operationId,
  account,
  vaultId,
  expected: vaultCasSchema,
  publicationBase64Url: publication,
});

const cryptoCounter = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const vaultCryptoRevisionsSchema = z.strictObject({
  generation: cryptoCounter,
  contentRevision: cryptoCounter,
  passwordRevision: cryptoCounter,
  recoveryRevision: cryptoCounter,
});
export const vaultReadStateSchema = z.strictObject({
  transportVersion: z.literal(1),
  account,
  vaultId,
  cryptographicFormatVersion: z.literal(1),
  publicationBase64Url: publication,
  publicationDigest: publicationDigestSchema,
  cas: vaultCasSchema,
  revisions: vaultCryptoRevisionsSchema,
  envelopeCredentialRevision: databaseRevisionSchema,
});
const publicOperationIdentity = z.strictObject({
  account,
  operationId,
  kind: z.enum(['initial-publication', 'ordinary-password-change']),
  expectedStorageRevision: databaseRevisionSchema.nullable(),
  expectedCredentialRevision: databaseRevisionSchema,
});
const operationError = z.enum([
  'INVALID_INPUT',
  'INVALID_PUBLICATION',
  'ALREADY_EXISTS',
  'VERSION_CONFLICT',
  'INVALID_TRANSITION',
  'IDEMPOTENCY_MISMATCH',
]);
export const vaultOperationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ transportVersion: z.literal(1), status: z.literal('unknown') }),
  z.strictObject({
    transportVersion: z.literal(1),
    status: z.literal('committed'),
    identity: publicOperationIdentity,
    cas: vaultCasSchema,
    publicationDigest: publicationDigestSchema,
  }),
  z.strictObject({
    transportVersion: z.literal(1),
    status: z.literal('rejected'),
    identity: publicOperationIdentity,
    code: operationError,
  }),
]);
