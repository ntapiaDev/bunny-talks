/** Transport protocol version, independent of every cryptographic format version. */
export type VaultTransportVersion = 1;
/** Canonical decimal string in the positive PostgreSQL bigint range. */
export type DatabaseRevision = string;
export interface VaultCas {
  readonly storageRevision: DatabaseRevision;
  readonly credentialRevision: DatabaseRevision;
}
export interface VaultCryptoRevisions {
  readonly generation: number;
  readonly contentRevision: number;
  readonly passwordRevision: number;
  readonly recoveryRevision: number;
}
export interface VaultReadState {
  readonly transportVersion: VaultTransportVersion;
  readonly account: string;
  readonly vaultId: string;
  readonly cryptographicFormatVersion: 1;
  readonly publicationBase64Url: string;
  /** SHA-256 of the exact publication bytes, canonical unpadded base64url. */
  readonly publicationDigest: string;
  readonly cas: VaultCas;
  /** Structurally extracted; clients must authenticate before trusting these values. */
  readonly revisions: VaultCryptoRevisions;
  readonly envelopeCredentialRevision: DatabaseRevision;
}
export interface InitialVaultPublication {
  readonly transportVersion: VaultTransportVersion;
  readonly operationId: string;
  readonly account: string;
  readonly vaultId: string;
  readonly expectedCredentialRevision: DatabaseRevision;
  readonly expectedStorageRevision: null;
  readonly publicationBase64Url: string;
}
export interface OrdinaryPasswordChange {
  readonly transportVersion: VaultTransportVersion;
  readonly operationId: string;
  readonly account: string;
  readonly vaultId: string;
  readonly expected: VaultCas;
  readonly publicationBase64Url: string;
}
export type VaultOperationKind = 'initial-publication' | 'ordinary-password-change';
export type VaultOperationError =
  | 'INVALID_INPUT'
  | 'INVALID_PUBLICATION'
  | 'ALREADY_EXISTS'
  | 'VERSION_CONFLICT'
  | 'INVALID_TRANSITION'
  | 'IDEMPOTENCY_MISMATCH';
/** Opaque, protected request fingerprint; its algorithm and key policy are intentionally unspecified. */
export interface VaultOperationIdentity {
  readonly account: string;
  readonly operationId: string;
  readonly kind: VaultOperationKind;
  readonly expectedStorageRevision: DatabaseRevision | null;
  readonly expectedCredentialRevision: DatabaseRevision;
  readonly fingerprint: string;
}
export type VaultOperationResult =
  | { readonly transportVersion: 1; readonly status: 'unknown' }
  | {
      readonly transportVersion: 1;
      readonly status: 'committed';
      readonly identity: Omit<VaultOperationIdentity, 'fingerprint'>;
      readonly cas: VaultCas;
      /** SHA-256 of the exact publication bytes, canonical unpadded base64url. */
      readonly publicationDigest: string;
    }
  | {
      readonly transportVersion: 1;
      readonly status: 'rejected';
      readonly identity: Omit<VaultOperationIdentity, 'fingerprint'>;
      readonly code: VaultOperationError;
    };
