import { encodeEnvelopePassword } from '@bunny-talks/crypto-backup';

export class RegistrationError extends Error {
  public constructor(
    public readonly code:
      | 'INVALID_EMAIL'
      | 'INVALID_REQUEST'
      | 'INVALID_PROOF'
      | 'EMAIL_UNAVAILABLE'
      | 'INVALID_PASSWORD'
      | 'BLOCKED_PASSWORD'
      | 'POLICY_UNAVAILABLE'
      | 'DELIVERY_UNAVAILABLE'
      | 'OUTCOME_UNKNOWN',
  ) {
    super(code);
    this.name = 'RegistrationError';
  }
}

/** Trusted adapter; must compare the entire password against a maintained blocklist. */
export interface PasswordBlocklist {
  isBlocked(password: string): Promise<boolean>;
}

/** No transformation: identical byte contract to the V1 vault and authentication. */
export function validateRegistrationPassword(password: string): void {
  let bytes: Uint8Array;
  try {
    bytes = encodeEnvelopePassword(password);
  } catch {
    throw new RegistrationError('INVALID_PASSWORD');
  }
  bytes.fill(0);
  if ([...password].length < 15) throw new RegistrationError('INVALID_PASSWORD');
}

export async function checkRegistrationPassword(password: string, blocklist?: PasswordBlocklist) {
  validateRegistrationPassword(password);
  if (!blocklist) throw new RegistrationError('POLICY_UNAVAILABLE');
  let blocked: unknown;
  try {
    blocked = await blocklist.isBlocked(password);
  } catch {
    throw new RegistrationError('POLICY_UNAVAILABLE');
  }
  if (typeof blocked !== 'boolean') throw new RegistrationError('POLICY_UNAVAILABLE');
  if (blocked) throw new RegistrationError('BLOCKED_PASSWORD');
}
