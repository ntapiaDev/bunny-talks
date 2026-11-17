import type { VaultOperationResult } from '@bunny-talks/contracts';
import type { VaultBootstrapInput, VaultBootstrapReceiptInput } from '@bunny-talks/validation';
import { vaultOperationResultSchema } from '@bunny-talks/validation';
import { AuthenticationError } from '../auth/authentication-error.js';
import { InitialBootstrapError } from '../auth/bootstrap/initial-bootstrap-error.js';
import type { PostgresInitialDeviceBootstrap } from '../auth/bootstrap/postgres-initial-device-bootstrap.js';
import type { SessionState } from '../auth/sessions/postgres-session-repository.js';
import type { PostgresBootstrapLimits } from './postgres-bootstrap-limits.js';

interface Dependencies {
  readonly bootstrap: Pick<PostgresInitialDeviceBootstrap, 'activate' | 'recoverReceipt'>;
  readonly limits: Pick<PostgresBootstrapLimits, 'admit' | 'acquire' | 'cleanup'>;
}

/** HTTP admission only; 4.4B retains all authentication checks and transaction ownership. */
export class BootstrapHttpService {
  public constructor(private readonly dependencies?: Dependencies) {}

  public async execute(
    input: VaultBootstrapInput | VaultBootstrapReceiptInput,
    context: { readonly token: string; readonly session: SessionState },
    source: string,
  ): Promise<VaultOperationResult> {
    if (!this.dependencies) throw new AuthenticationError('UNAVAILABLE');
    if (input.request.account !== context.session.accountId)
      throw new InitialBootstrapError('INVALID_AUTHENTICATION');
    const { bootstrap, limits } = this.dependencies;
    const activation = 'password' in input;
    await limits.admit(source, context.session.accountId, context.session.deviceId, activation);
    await limits.cleanup();
    const lease = await limits.acquire();
    try {
      const result = activation
        ? await bootstrap.activate(
            context.token,
            input.password,
            input.request,
            input.candidateDigest,
          )
        : await bootstrap.recoverReceipt(context.token, input.request, input.candidateDigest);
      const parsed = vaultOperationResultSchema.safeParse(result);
      if (!parsed.success) throw new InitialBootstrapError('OUTCOME_UNKNOWN');
      return parsed.data;
    } finally {
      await lease.release();
    }
  }
}
