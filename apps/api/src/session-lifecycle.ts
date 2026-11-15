import type { Session } from '../generated/prisma/client.js';
export function sessionIsActive(
  row: Pick<
    Session,
    'tokenHash' | 'revokedAt' | 'createdAt' | 'expiresAt' | 'lastSeenAt' | 'idleTimeoutMs'
  >,
  now: Date,
): boolean {
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
