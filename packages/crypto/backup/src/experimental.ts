// Historical experiments; these formats do not implement the target recovery vault.
export type { CryptographicRandomSource } from './random-source.js';
export { validateEnvelopeStructureV1 } from './structural-validation.js';
export type {
  StructurallyValidEnvelopeV1,
  StructuralValidationError,
  StructuralValidationResult,
} from './structural-validation.js';
export { createDirectVaultV1, openDirectVaultV1 } from './direct-v1.js';
export type { DirectVaultMetadataV1, OpenDirectVaultResultV1 } from './direct-v1.js';
export { decodeRecoveryPayloadV1, serializeRecoveryPayloadV1 } from './recovery-payload-v1.js';
export type {
  DecodeRecoveryPayloadResult,
  RecoveryPayloadError,
  RecoveryPayloadV1,
  SerializeRecoveryPayloadResult,
} from './recovery-payload-v1.js';
