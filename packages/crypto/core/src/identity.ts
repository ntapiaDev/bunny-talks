import type { AccountId, DeviceId, IdentityId } from './identifiers.js';

/**
 * Logical cryptographic identity associated with a Bunny Talks account.
 *
 * This descriptor does not expose or contain private key material.
 * Its relationship with the underlying protocol identity is managed
 * by the crypto engine.
 */
export interface AccountIdentityDescriptor {
  readonly accountId: AccountId;
  readonly identityId: IdentityId;
}

/**
 * Cryptographic identity descriptor for one authorized device.
 *
 * Every device belongs to an account identity while retaining its
 * own device-specific cryptographic material when required.
 *
 * This is a logical application-level model, not an SDK data structure.
 */
export interface DeviceIdentityDescriptor {
  readonly accountId: AccountId;
  readonly deviceId: DeviceId;
  readonly accountIdentityId: IdentityId;
}
