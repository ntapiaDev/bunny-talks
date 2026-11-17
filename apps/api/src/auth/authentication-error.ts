export class AuthenticationError extends Error {
  public constructor(
    public readonly code:
      | 'INVALID_CREDENTIALS'
      | 'RATE_LIMITED'
      | 'BUSY'
      | 'CRYPTO_UNAVAILABLE'
      | 'UNAVAILABLE'
      | 'OUTCOME_UNKNOWN',
  ) {
    super(code);
    this.name = 'AuthenticationError';
  }
}
