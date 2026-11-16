export class InitialBootstrapError extends Error {
  public constructor(
    public readonly code:
      | 'INVALID_AUTHENTICATION'
      | 'NOT_ELIGIBLE'
      | 'HISTORICAL_STATE'
      | 'REPLAY_FORBIDDEN'
      | 'OUTCOME_UNKNOWN',
  ) {
    super(code);
    this.name = 'InitialBootstrapError';
  }
}
