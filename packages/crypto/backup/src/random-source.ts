/**
 * A platform-provided cryptographic random source. Implementations must fill the entire
 * buffer with CSPRNG output or reject; predictable fallbacks are forbidden in every mode.
 * Implementing this interface does not prove the source is secure.
 */
export interface CryptographicRandomSource {
  fill(bytes: Uint8Array): Promise<void>;
}
