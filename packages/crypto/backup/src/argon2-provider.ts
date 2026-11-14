import { argon2idAsync } from '@noble/hashes/argon2.js';

export interface Argon2idParameters {
  readonly memoryKiB: 65536;
  readonly passes: 3;
  readonly parallelism: 4;
  readonly version: 19;
  readonly outputBytes: 32;
}
/** Inputs belong to the caller; output is a fresh owned buffer. No input mutation. */
export interface Argon2idProvider {
  derive(
    password: Uint8Array,
    salt: Uint8Array,
    parameters: Argon2idParameters,
  ): Promise<Uint8Array>;
}
export const ARGON2ID_V1: Argon2idParameters = Object.freeze({
  memoryKiB: 65536,
  passes: 3,
  parallelism: 4,
  version: 19,
  outputBytes: 32,
});
export const nobleArgon2idProvider: Argon2idProvider = Object.freeze({
  derive: (password: Uint8Array, salt: Uint8Array, parameters: Argon2idParameters) =>
    argon2idAsync(password, salt, {
      m: parameters.memoryKiB,
      t: parameters.passes,
      p: parameters.parallelism,
      version: parameters.version,
      dkLen: parameters.outputBytes,
      maxmem: 64 * 1024 * 1024,
      asyncTick: 10,
    }),
});
