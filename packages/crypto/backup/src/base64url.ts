const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function encodeBase64Url(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    result += alphabet[a >> 2]! + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) result += alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) result += alphabet[c & 63]!;
  }
  return result;
}

// Only used after structural validation has checked the alphabet, length and padding bits.
export function decodeBase64Url(value: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor((value.length * 3) / 4));
  let bits = 0;
  let accumulator = 0;
  let offset = 0;
  for (const char of value) {
    accumulator = (accumulator << 6) | alphabet.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (accumulator >> bits) & 255;
    }
  }
  return bytes;
}
