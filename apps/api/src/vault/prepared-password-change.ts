export interface PreparedPasswordChange {
  /** Opaque verifier already computed by the future authentication service, never a password. */
  readonly verifier: string;
  readonly expectedPublicationDigest: string;
  readonly expectedGeneration: number;
  readonly candidateDigest: string;
}
