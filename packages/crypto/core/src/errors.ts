/**
 * Stable error codes shared by the cryptographic packages.
 *
 * SDK-specific errors must be translated into these codes at the
 * integration boundary. SDK internals must not leak into core.
 */
export type CryptoErrorCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_OPERATION'
  | 'KEY_NOT_FOUND'
  | 'KEY_ACCESS_DENIED'
  | 'ENCRYPTION_FAILED'
  | 'DECRYPTION_FAILED'
  | 'INTEGRITY_CHECK_FAILED'
  | 'STORAGE_FAILURE'
  | 'DEVICE_NOT_AUTHORIZED'
  | 'RECOVERY_FAILED'
  | 'UNKNOWN';

export interface CryptoErrorOptions {
  readonly cause?: unknown;
  readonly retryable?: boolean;
}

/**
 * Normalized error exposed by the cryptographic packages.
 *
 * The original error can be preserved as `cause` for internal
 * diagnostics, but must never be logged if it contains secrets.
 */
export class CryptoError extends Error {
  public readonly code: CryptoErrorCode;
  public readonly retryable: boolean;

  public constructor(code: CryptoErrorCode, message: string, options: CryptoErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });

    this.name = 'CryptoError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}
