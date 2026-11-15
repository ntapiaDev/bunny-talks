export type VaultRepositoryErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_PUBLICATION'
  | 'KEY_UNAVAILABLE'
  | 'ACCOUNT_NOT_FOUND'
  | 'CREDENTIAL_NOT_FOUND'
  | 'CORRUPT_STORAGE'
  | 'TRANSACTION_OUTCOME_UNKNOWN';

/** Fixed messages deliberately exclude driver errors, request data and secrets. */
export class VaultRepositoryError extends Error {
  public constructor(public readonly code: VaultRepositoryErrorCode) {
    super(code);
    this.name = 'VaultRepositoryError';
  }
}
