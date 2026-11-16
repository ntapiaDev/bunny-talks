import { randomUUID, timingSafeEqual } from 'node:crypto';
import { canonicalizeLoginEmail } from '@bunny-talks/validation';
import type { EmailRegistration, Prisma, PrismaClient } from '../../../generated/prisma/client.js';
import { createPasswordVerifier, PasswordVerifierError } from '../password-verifier.js';
import { generateOpaqueToken, parseOpaqueToken } from '../sessions/session-token.js';
import type { PostgresRegistrationLimits } from './postgres-registration-limits.js';
import type { PasswordBlocklist } from './registration-policy.js';
import { checkRegistrationPassword, RegistrationError } from './registration-policy.js';

/** Only this trusted port receives the raw proof; never include it in a client response. */
export interface RegistrationEmailTransport {
  checkAvailability?(): Promise<void>;
  submitVerification(
    message: Readonly<{ to: string; token: string; expiresAt: Date }>,
  ): Promise<void>;
}

export interface RegistrationReceipt {
  readonly status: 'account-created';
  readonly accountId: string;
}

function email(value: unknown) {
  try {
    return canonicalizeLoginEmail(value);
  } catch {
    throw new RegistrationError('INVALID_EMAIL');
  }
}

function proof(value: unknown) {
  try {
    return parseOpaqueToken(value, 'e1');
  } catch {
    throw new RegistrationError('INVALID_PROOF');
  }
}

function requireProof(row: EmailRegistration | null, hash: Uint8Array, canonical: string) {
  if (
    !row ||
    row.canonical !== canonical ||
    row.tokenHash.length !== hash.length ||
    !timingSafeEqual(row.tokenHash, hash)
  )
    throw new RegistrationError('INVALID_PROOF');
  return row;
}

function receipt(row: EmailRegistration): RegistrationReceipt | null {
  return row.completedAt !== null && row.accountId !== null
    ? { status: 'account-created', accountId: row.accountId }
    : null;
}

/** Internal service. No arbitrary account IDs, verification flags, PHCs or mutation callbacks. */
export class PostgresEmailRegistration {
  public constructor(
    private readonly client: PrismaClient,
    private readonly transport?: RegistrationEmailTransport,
    private readonly blocklist?: PasswordBlocklist,
    private readonly clock: () => Date = () => new Date(),
    private readonly limits?: PostgresRegistrationLimits,
  ) {}

  private now() {
    const now = new Date(this.clock().getTime());
    if (!Number.isFinite(now.getTime())) throw new RegistrationError('INVALID_REQUEST');
    return now;
  }

  public async requestVerification(
    address: unknown,
  ): Promise<{ status: 'verification-requested' }> {
    const identity = email(address);
    if (!this.transport) throw new RegistrationError('DELIVERY_UNAVAILABLE');
    const now = this.now();
    const expiresAt = new Date(now.getTime() + 1800000);
    let token;
    try {
      token = generateOpaqueToken('e1');
    } catch {
      throw new RegistrationError('OUTCOME_UNKNOWN');
    }
    try {
      try {
        const data = {
          id: token.id,
          ...identity,
          tokenHash: Uint8Array.from(token.hash),
          createdAt: now,
          expiresAt,
        };
        if (this.limits) {
          const limits = this.limits;
          const admitted = await limits.transaction(async (tx) => {
            if (!(await limits.admitEmail(tx, identity.canonical))) return false;
            if (await tx.emailIdentity.findUnique({ where: { canonical: identity.canonical } }))
              return false;
            if (
              await tx.emailRegistration.findFirst({
                where: {
                  canonical: identity.canonical,
                  completedAt: null,
                  expiresAt: { gt: now },
                },
              })
            )
              return false;
            await tx.emailRegistration.create({ data });
            return true;
          });
          if (!admitted) return { status: 'verification-requested' };
        } else await this.client.emailRegistration.create({ data });
      } catch (error) {
        if (error instanceof RegistrationError && error.code === 'RATE_LIMITED') throw error;
        throw new RegistrationError('OUTCOME_UNKNOWN');
      }
      try {
        await this.transport.submitVerification({
          to: identity.display,
          token: token.token,
          expiresAt,
        });
      } catch {
        throw new RegistrationError('DELIVERY_UNAVAILABLE');
      }
      // This acknowledges transport acceptance, not delivery to a mailbox.
      return { status: 'verification-requested' };
    } finally {
      token.hash.fill(0);
    }
  }

  /** A consumed proof only retrieves its historical receipt; it never authenticates a session. */
  public async finalize(input: unknown): Promise<RegistrationReceipt> {
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw new RegistrationError('INVALID_REQUEST');
    const request = input as Record<string, unknown>;
    if (
      Object.keys(request).length !== 3 ||
      !Object.hasOwn(request, 'email') ||
      !Object.hasOwn(request, 'token') ||
      !Object.hasOwn(request, 'password') ||
      typeof request.password !== 'string'
    )
      throw new RegistrationError('INVALID_REQUEST');
    const identity = email(request.email);
    const parsed = proof(request.token);
    try {
      const before = requireProof(
        await this.client.emailRegistration.findUnique({ where: { id: parsed.id } }),
        parsed.hash,
        identity.canonical,
      );
      const previous = receipt(before);
      if (previous) return previous;
      this.requireUnexpired(before);
      await checkRegistrationPassword(request.password, this.blocklist);
      await this.limits?.hash();
      // Never hold a database transaction or row lock during Argon2id or adapter I/O.
      const verifier = await createPasswordVerifier(request.password);
      return await this.client.$transaction<RegistrationReceipt>(
        async (tx: Prisma.TransactionClient) => {
          await tx.$queryRaw`SELECT set_config('lock_timeout', '1000ms', true), set_config('statement_timeout', '3000ms', true)`;
          await tx.$queryRaw`SELECT "id" FROM "EmailRegistration" WHERE "id" = ${parsed.id}::uuid FOR UPDATE`;
          const current = requireProof(
            await tx.emailRegistration.findUnique({ where: { id: parsed.id } }),
            parsed.hash,
            identity.canonical,
          );
          const existing = receipt(current);
          if (existing) return existing;
          const now = this.requireUnexpired(current);
          // The unique index is authoritative even when other proofs finalize concurrently.
          if (await tx.emailIdentity.findUnique({ where: { canonical: identity.canonical } }))
            throw new RegistrationError('EMAIL_UNAVAILABLE');
          const accountId = randomUUID();
          await tx.account.create({ data: { id: accountId } });
          // The conflict target identifies only the canonical email index. Other failures propagate.
          const inserted = await tx.$queryRaw<
            { accountId: string }[]
          >`INSERT INTO "EmailIdentity" ("accountId", "canonical", "display", "verifiedAt") VALUES (${accountId}, ${current.canonical}, ${current.display}, ${now}) ON CONFLICT ("canonical") DO NOTHING RETURNING "accountId"`;
          if (inserted.length === 0) throw new RegistrationError('EMAIL_UNAVAILABLE');
          await tx.passwordCredential.create({ data: { accountId, verifier } });
          await tx.emailRegistration.update({
            where: { id: current.id },
            data: { accountId, completedAt: now },
          });
          return { status: 'account-created', accountId };
        },
        { isolationLevel: 'ReadCommitted', maxWait: 2000, timeout: 5000 },
      );
    } catch (error) {
      if (error instanceof RegistrationError || error instanceof PasswordVerifierError) throw error;
      // Never infer rollback from a driver or commit error. Retry the same proof.
      throw new RegistrationError('OUTCOME_UNKNOWN');
    } finally {
      parsed.hash.fill(0);
    }
  }

  private requireUnexpired(row: EmailRegistration) {
    const now = this.now();
    if (now < row.createdAt || now >= row.expiresAt) throw new RegistrationError('INVALID_PROOF');
    return now;
  }
}
