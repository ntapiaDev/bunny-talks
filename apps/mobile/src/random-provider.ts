import { getRandomValues } from 'expo-crypto';

// The SDK requires the synchronous Web Crypto entry point. This delegates directly
// to Expo's native CSPRNG; getRandomBytes has a development fallback and is not used.
if (typeof globalThis.crypto !== 'object') {
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
}
Object.defineProperty(globalThis.crypto, 'getRandomValues', {
  value: getRandomValues,
  configurable: true,
});
