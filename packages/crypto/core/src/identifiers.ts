/**
 * Opaque identifiers used by the cryptographic packages.
 *
 * These types prevent accidental mixing of identifiers belonging
 * to different concepts. They do not contain cryptographic secrets.
 *
 * The underlying identifier format is deliberately unspecified:
 * it may be determined by the application or its persistence layer.
 */

type Identifier<Kind extends string> = string & {
  readonly __identifierKind: Kind;
};

export type AccountId = Identifier<'AccountId'>;
export type DeviceId = Identifier<'DeviceId'>;
export type IdentityId = Identifier<'IdentityId'>;
export type KeyId = Identifier<'KeyId'>;
export type ArchiveId = Identifier<'ArchiveId'>;

function createIdentifier<Kind extends string>(value: string, kind: Kind): Identifier<Kind> {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`Invalid ${kind}: identifier must be non-empty and trimmed.`);
  }

  return value as Identifier<Kind>;
}

/** Creates a validated account identifier. */
export function createAccountId(value: string): AccountId {
  return createIdentifier(value, 'AccountId');
}

/** Creates a validated device identifier. */
export function createDeviceId(value: string): DeviceId {
  return createIdentifier(value, 'DeviceId');
}

/** Creates a validated cryptographic identity identifier. */
export function createIdentityId(value: string): IdentityId {
  return createIdentifier(value, 'IdentityId');
}

/** Creates a validated cryptographic key identifier. */
export function createKeyId(value: string): KeyId {
  return createIdentifier(value, 'KeyId');
}

/** Creates a validated encrypted archive identifier. */
export function createArchiveId(value: string): ArchiveId {
  return createIdentifier(value, 'ArchiveId');
}
