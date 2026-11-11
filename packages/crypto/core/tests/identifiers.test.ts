import { describe, expect, it } from 'vitest';

import {
  createAccountId,
  createArchiveId,
  createDeviceId,
  createKeyId,
} from '../src/identifiers.js';

describe('cryptographic identifiers', () => {
  it('creates an account identifier', () => {
    expect(createAccountId('account-123')).toBe('account-123');
  });

  it('creates a device identifier', () => {
    expect(createDeviceId('device-123')).toBe('device-123');
  });

  it('creates a key identifier', () => {
    expect(createKeyId('key-123')).toBe('key-123');
  });

  it('creates an archive identifier', () => {
    expect(createArchiveId('archive-123')).toBe('archive-123');
  });

  it('rejects empty identifiers', () => {
    expect(() => createAccountId('')).toThrow(TypeError);
  });

  it('rejects identifiers containing surrounding whitespace', () => {
    expect(() => createDeviceId(' device-123 ')).toThrow(TypeError);
  });

  it('does not impose a UUID format', () => {
    expect(createAccountId('account-123')).toBe('account-123');
  });
});
