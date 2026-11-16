import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RegistrationComplete, RegistrationRequest } from '@bunny-talks/validation';
import { parseOpaqueToken } from '../sessions/session-token.js';
import type {
  PostgresEmailRegistration,
  RegistrationEmailTransport,
} from './postgres-email-registration.js';
import type { PostgresRegistrationLimits } from './postgres-registration-limits.js';
import type { RegistrationConfig } from './registration-config.js';
import { RegistrationError } from './registration-policy.js';

/** The HTTP capability never projects the privileged internal receipt. */
export class RegistrationHttpService {
  public constructor(
    private readonly enabled?: {
      registration: PostgresEmailRegistration;
      transport: RegistrationEmailTransport;
      limits: PostgresRegistrationLimits;
      config: RegistrationConfig;
    },
  ) {}

  private requireEnabled() {
    if (!this.enabled) throw new RegistrationError('UNAVAILABLE');
    return this.enabled;
  }

  public async request(
    input: RegistrationRequest,
    source: string,
  ): Promise<{ status: 'accepted' }> {
    const { registration, transport, limits, config } = this.requireEnabled();
    await limits.source('request', source);
    await limits.cleanup();
    const release = await limits.acquire('request');
    const started = performance.now();
    try {
      if (!transport.checkAvailability) throw new RegistrationError('DELIVERY_UNAVAILABLE');
      // Same readiness operation for every address, including suppressed requests.
      try {
        await transport.checkAvailability();
      } catch {
        throw new RegistrationError('DELIVERY_UNAVAILABLE');
      }
      try {
        await registration.requestVerification(input.email);
      } catch (error) {
        // The durable admission already succeeded. SMTP may have accepted DATA despite an error.
        // A 202 acknowledges only this request, never an email delivery. Do not expose this branch.
        if (!(error instanceof RegistrationError) || error.code !== 'DELIVERY_UNAVAILABLE')
          throw error;
      }
      return { status: 'accepted' };
    } finally {
      // Hold the distributed request slot while padding; no unbounded queue of sleeping requests.
      await delay(
        Math.max(0, config.requestFloorMs + randomInt(101) - (performance.now() - started)),
      );
      await release();
    }
  }

  public async complete(
    input: RegistrationComplete,
    source: string,
  ): Promise<{ status: 'account-created' }> {
    const { registration, limits } = this.requireEnabled();
    let proofId: string | undefined;
    try {
      const parsed = parseOpaqueToken(input.token, 'e1');
      proofId = parsed.id;
      parsed.hash.fill(0);
    } catch {
      /* Malformed proofs still consume a source attempt. */
    }
    await limits.source('complete', source, proofId);
    const release = await limits.acquire('complete');
    try {
      await registration.finalize(input);
      return { status: 'account-created' };
    } finally {
      await release();
    }
  }
}
