import { describe, expect, it } from 'vitest';

import { createAccountId, createDeviceId, createIdentityId } from '../src/identifiers.js';

import {
  createAccountIdentityDescriptor,
  createDeviceIdentityDescriptor,
} from '../src/identity-factory.js';

describe('account cryptographic identity', () => {
  it('creates an account identity descriptor', () => {
    const accountId = createAccountId('account-123');
    const identityId = createIdentityId('identity-123');

    expect(createAccountIdentityDescriptor(accountId, identityId)).toEqual({
      accountId: 'account-123',
      identityId: 'identity-123',
    });
  });
});

describe('device cryptographic identity', () => {
  it('associates a device with the account identity', () => {
    const accountId = createAccountId('account-123');
    const identityId = createIdentityId('identity-123');
    const deviceId = createDeviceId('device-456');

    expect(createDeviceIdentityDescriptor(accountId, deviceId, identityId)).toEqual({
      accountId: 'account-123',
      deviceId: 'device-456',
      accountIdentityId: 'identity-123',
    });
  });

  it('allows several devices to reference the same account identity', () => {
    const accountId = createAccountId('account-123');
    const identityId = createIdentityId('identity-123');

    const firstDevice = createDeviceIdentityDescriptor(
      accountId,
      createDeviceId('device-1'),
      identityId,
    );

    const secondDevice = createDeviceIdentityDescriptor(
      accountId,
      createDeviceId('device-2'),
      identityId,
    );

    expect(firstDevice.accountIdentityId).toBe(secondDevice.accountIdentityId);

    expect(firstDevice.deviceId).not.toBe(secondDevice.deviceId);
  });
});
