import { timingSafeEqual } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client.js';
import { sessionIsActive } from './session-lifecycle.js';
import { SessionError } from './session-token.js';

/** The caller must hold the account lock; this helper never starts a transaction. */
export async function requireSessionInTransaction(
  tx: Prisma.TransactionClient,
  accountId: string,
  token: { id: string; hash: Uint8Array },
  now: Date,
) {
  const row = await tx.session.findUnique({ where: { id: token.id }, include: { device: true } });
  if (
    !row ||
    row.accountId !== accountId ||
    !row.tokenHash ||
    row.tokenHash.length !== 32 ||
    !timingSafeEqual(token.hash, row.tokenHash) ||
    !sessionIsActive(row, now) ||
    row.device.revokedAt !== null
  )
    throw new SessionError('INVALID_SESSION');
  return row;
}
