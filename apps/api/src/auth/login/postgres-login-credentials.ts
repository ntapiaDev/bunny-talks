import type { PrismaClient } from '../../../generated/prisma/client.js';
import type { LoginCredential } from '../verified-login.js';

export class PostgresLoginCredentials {
  public constructor(private readonly client: PrismaClient) {}
  public async find(canonical: string): Promise<LoginCredential | null> {
    const identity = await this.client.emailIdentity.findUnique({
      where: { canonical },
      include: { account: { include: { credential: true } } },
    });
    const credential = identity?.account.credential;
    if (!identity || !credential) return null;
    return {
      accountId: identity.accountId,
      canonical: identity.canonical,
      verifiedAtMs: identity.verifiedAt.getTime(),
      verifier: credential.verifier,
      revision: credential.revision,
      verifierUpdatedAtMs: credential.verifierUpdatedAt?.getTime() ?? null,
    };
  }
}
