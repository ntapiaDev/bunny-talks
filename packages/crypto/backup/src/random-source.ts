/**
 * A platform-provided cryptographic random source. Implementations must fill the entire
 * buffer with CSPRNG output or reject; predictable fallbacks are forbidden in every mode.
 * It must finish writing before resolving and must not mutate the buffer afterward.
 * A successful return cannot prove that any bytes were written or that output is secure.
 */
export interface CryptographicRandomSource {
  fill(bytes: Uint8Array): Promise<void>;
}
