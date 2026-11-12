const MAGIC = Uint8Array.of(0x42, 0x54, 0x52, 0x50, 0x41, 0x59, 0x4c, 0x44);
const HEADER_LENGTH = 12;
const KEY_LENGTH = 32;
const IDENTITY_LENGTH = 4 * KEY_LENGTH;
const ARCHIVE_ENTRY_LENGTH = 4 + KEY_LENGTH;
const MAX_ARCHIVE_KEYS = 64;
const MIN_LENGTH = HEADER_LENGTH + IDENTITY_LENGTH;
const MAX_LENGTH = HEADER_LENGTH + IDENTITY_LENGTH + MAX_ARCHIVE_KEYS * ARCHIVE_ENTRY_LENGTH;

/** Candidate bytes only; neither identity consistency nor SDK importability is established. */
export interface RecoveryPayloadV1 {
  readonly identity: {
    readonly dhPublicKey: Uint8Array;
    readonly dhPrivateKey: Uint8Array;
    readonly signingPublicKey: Uint8Array;
    readonly signingPrivateKey: Uint8Array;
  };
  readonly archiveKeys: readonly {
    readonly version: number;
    readonly key: Uint8Array;
  }[];
}

export type RecoveryPayloadError = 'INVALID_PAYLOAD' | 'UNSUPPORTED_FORMAT' | 'LIMIT_EXCEEDED';
export type SerializeRecoveryPayloadResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: RecoveryPayloadError };
export type DecodeRecoveryPayloadResult =
  | { readonly ok: true; readonly payload: RecoveryPayloadV1 }
  | { readonly ok: false; readonly code: RecoveryPayloadError };

const invalid = { ok: false, code: 'INVALID_PAYLOAD' } as const;
const limit = { ok: false, code: 'LIMIT_EXCEEDED' } as const;
const unsupported = { ok: false, code: 'UNSUPPORTED_FORMAT' } as const;
const identityFields = [
  'dhPublicKey',
  'dhPrivateKey',
  'signingPublicKey',
  'signingPrivateKey',
] as const;

// Read only own data properties so accessors cannot change a checked value during serialization.
function fields(value: unknown, names: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== names.length ||
    keys.some((key) => typeof key !== 'string' || !names.includes(key))
  )
    return undefined;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor)) return undefined;
    result[name] = descriptor.value;
  }
  return result;
}

function isKey(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === KEY_LENGTH;
}

/** Serialize unencrypted secrets. The caller owns the returned sensitive bytes. */
export function serializeRecoveryPayloadV1(
  input: RecoveryPayloadV1,
): SerializeRecoveryPayloadResult {
  const root = fields(input, ['identity', 'archiveKeys']);
  if (!root) return invalid;
  const identity = fields(root.identity, identityFields);
  if (!identity || !identityFields.every((name) => isKey(identity[name]))) return invalid;
  const archives = root.archiveKeys;
  if (!Array.isArray(archives)) return invalid;
  if (archives.length > MAX_ARCHIVE_KEYS) return limit;
  if (Reflect.ownKeys(archives).length !== archives.length + 1) return invalid;
  const entries: { version: number; key: Uint8Array }[] = [];
  let previous = 0;
  for (let i = 0; i < archives.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(archives, String(i));
    const entry =
      descriptor && 'value' in descriptor
        ? fields(descriptor.value, ['version', 'key'])
        : undefined;
    if (
      !entry ||
      typeof entry.version !== 'number' ||
      !Number.isInteger(entry.version) ||
      entry.version <= previous ||
      entry.version > 0xffff_ffff ||
      !isKey(entry.key)
    )
      return invalid;
    previous = entry.version;
    entries.push({ version: entry.version, key: entry.key });
  }
  const output = new Uint8Array(
    HEADER_LENGTH + IDENTITY_LENGTH + entries.length * ARCHIVE_ENTRY_LENGTH,
  );
  output.set(MAGIC);
  output.set([1, 1, 1, entries.length], 8);
  let offset = HEADER_LENGTH;
  for (const name of identityFields) {
    output.set(identity[name] as Uint8Array, offset);
    offset += KEY_LENGTH;
  }
  const view = new DataView(output.buffer);
  for (const entry of entries) {
    view.setUint32(offset, entry.version, false);
    offset += 4;
    output.set(entry.key, offset);
    offset += KEY_LENGTH;
  }
  return { ok: true, bytes: output };
}

/** Decode a structural candidate only; this does not authenticate or validate key pairs. */
export function decodeRecoveryPayloadV1(input: Uint8Array): DecodeRecoveryPayloadResult {
  if (!(input instanceof Uint8Array)) return invalid;
  if (input.byteLength > MAX_LENGTH) return limit;
  if (input.byteLength < MIN_LENGTH) return invalid;
  const snapshot = Uint8Array.from(input);
  try {
    if (!MAGIC.every((value, index) => snapshot[index] === value)) return unsupported;
    if (snapshot[8] !== 1 || snapshot[9] !== 1 || snapshot[10] !== 1) return unsupported;
    const count = snapshot[11]!;
    if (count > MAX_ARCHIVE_KEYS) return limit;
    if (snapshot.length !== HEADER_LENGTH + IDENTITY_LENGTH + count * ARCHIVE_ENTRY_LENGTH)
      return invalid;
    const view = new DataView(snapshot.buffer);
    let offset = HEADER_LENGTH + IDENTITY_LENGTH;
    let previous = 0;
    for (let i = 0; i < count; i++) {
      const version = view.getUint32(offset, false);
      if (version <= previous) return invalid;
      previous = version;
      offset += ARCHIVE_ENTRY_LENGTH;
    }
    offset = HEADER_LENGTH;
    const readKey = () => {
      const result = snapshot.slice(offset, offset + KEY_LENGTH);
      offset += KEY_LENGTH;
      return result;
    };
    const identity = {
      dhPublicKey: readKey(),
      dhPrivateKey: readKey(),
      signingPublicKey: readKey(),
      signingPrivateKey: readKey(),
    };
    const archiveKeys: { version: number; key: Uint8Array }[] = [];
    for (let i = 0; i < count; i++) {
      const version = view.getUint32(offset, false);
      offset += 4;
      archiveKeys.push({ version, key: readKey() });
    }
    return { ok: true, payload: { identity, archiveKeys } };
  } finally {
    snapshot.fill(0);
  }
}
