export {
  createPasswordKeyEnvelope,
  createRecoveryKeyEnvelope,
  derivePasswordWrappingKey,
  deriveRecoveryWrappingKey,
  generateMasterKey,
  generateRecoveryKey,
  generateVaultId,
  KeyEnvelopeError,
  openPasswordKeyEnvelope,
  openRecoveryKeyEnvelope,
  validatePasswordKeyEnvelope,
  validateRecoveryKeyEnvelope,
} from './key-envelopes.js';
export type {
  KeyEnvelopeContext,
  KeyEnvelopeErrorCode,
  KeyEnvelopeMetadata,
  KeyEnvelopeValidation,
  OpenKeyEnvelopeResult,
  StructuralKeyEnvelope,
} from './key-envelopes.js';
export type { CryptographicRandomSource } from './random-source.js';
export { AccountVaultError, validateAccountVault } from './account-vault-format.js';
export type {
  AccountVaultErrorCode,
  AccountVaultRevisions,
  ValidateAccountVaultResult,
} from './account-vault-format.js';
export {
  createAccountVault,
  openAccountVaultWithPassword,
  openAccountVaultWithRecoveryKey,
  rewrapAccountVaultPassword,
} from './account-vault.js';
export type { AccountVaultAccess, OpenAccountVaultResult } from './account-vault.js';
