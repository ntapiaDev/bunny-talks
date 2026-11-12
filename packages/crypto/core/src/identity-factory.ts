import type { AccountId, DeviceId, IdentityId } from './identifiers.js';
import type { AccountIdentityDescriptor, DeviceIdentityDescriptor } from './identity.js';

/** Creates the logical identity descriptor for an account. */
export function createAccountIdentityDescriptor(
  accountId: AccountId,
  identityId: IdentityId,
): AccountIdentityDescriptor {
  return {
    accountId,
    identityId,
  };
}

/** Creates the logical identity descriptor for an authorized device. */
export function createDeviceIdentityDescriptor(
  accountId: AccountId,
  deviceId: DeviceId,
  accountIdentityId: IdentityId,
): DeviceIdentityDescriptor {
  return {
    accountId,
    deviceId,
    accountIdentityId,
  };
}
