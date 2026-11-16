interface SessionLifetime {
  readonly tokenHash: Uint8Array | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
  readonly idleTimeoutMs: number | null;
}

export function sessionIsActive(row: SessionLifetime, now: Date): boolean {
  const t = now.getTime();
  return (
    row.tokenHash !== null &&
    row.revokedAt === null &&
    t >= row.createdAt.getTime() &&
    t >= row.lastSeenAt.getTime() &&
    t < row.expiresAt.getTime() &&
    (row.idleTimeoutMs === null || t - row.lastSeenAt.getTime() < row.idleTimeoutMs)
  );
}
