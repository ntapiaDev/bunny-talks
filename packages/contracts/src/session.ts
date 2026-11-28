export interface SessionIdentityDto {
  readonly accountId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceState: 'pending' | 'authorized';
  readonly expiresAt: string;
}

export interface SessionDto extends SessionIdentityDto {
  readonly credentialRevision: string;
}

export interface LoginResponse {
  readonly sessionToken: string;
  readonly session: SessionIdentityDto;
}
