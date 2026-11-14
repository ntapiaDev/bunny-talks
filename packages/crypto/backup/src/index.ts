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
