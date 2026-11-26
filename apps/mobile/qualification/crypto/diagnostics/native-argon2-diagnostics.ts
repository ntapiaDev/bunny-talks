import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { NativeArgon2Provider } from '../../../src/infrastructure/crypto/native-argon2';
import type { DiagnosticEntry } from './diagnostic-entry';

const fromHex = (value: string) => Uint8Array.from(value.match(/../g)!, (s) => parseInt(s, 16));
const toHex = (value: Uint8Array) =>
  Array.from(value, (s) => s.toString(16).padStart(2, '0')).join('');
const vectors = [
  ['00ff0041', '54650f1dabcb7aeb86186af9006a2a0fecb058df0713ff4efdc4389bf4ee456c'],
  ['636166c3a9', 'b7598161b65744128361ebff3b4e3994142411b9df041fa5b31ad763ba361c89'],
  ['63616665cc81', '23d11f2325e9905c6b191b04d9a10b495e3daf33b3d390f554965afd8db77fcf'],
  ['f09f908720c3a9', '76bd7cb906ba4b69cdeaaca7c22b0fc3b442d2af82737dfe21c055a1ca2da5d1'],
] as const;

/** Fixed public vectors only; never logs a password, derived key or exception. */
export async function runNativeArgon2Diagnostics(
  provider: NativeArgon2Provider,
  report: (entry: DiagnosticEntry) => void,
): Promise<void> {
  let stage = 'Argon2 natif : environnement';
  try {
    if (!('HermesInternal' in globalThis)) throw new Error();
    const salt = fromHex('0001feff10002030405060708090a0b0');
    stage = 'Argon2 natif : vecteurs courts indépendants';
    const start = performance.now();
    for (const [password, expected] of vectors) {
      const value = await provider.derive(fromHex(password), salt, 'diagnostic-short');
      try {
        if (toHex(value) !== expected) throw new Error();
      } finally {
        value.fill(0);
      }
    }
    report({ label: stage, status: 'pass', durationMs: Math.round(performance.now() - start) });
    stage = 'Argon2 natif : profil complet 64 Mio';
    report({ label: `${stage} : en cours`, status: 'info' });
    let ticks = 0;
    let maxGap = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks++;
    }, 100);
    const fullStart = performance.now();
    const fullSalt = Uint8Array.from({ length: 16 }, (_, index) => index + 32);
    let result: Uint8Array | undefined;
    try {
      result = await provider.derive(
        new TextEncoder().encode('public vector password'),
        fullSalt,
        'reference',
      );
      const elapsed = Math.round(performance.now() - fullStart);
      if (toHex(result) !== 'c5b1c7296660177c1eceb3145ef5453c13248fd86d8592443e63359d58e52e16')
        throw new Error();
      report({ label: stage, status: 'pass', durationMs: elapsed });
      stage = 'HKDF après Argon2 natif : vecteur indépendant';
      const output = hkdf(
        sha256,
        result,
        fullSalt,
        new TextEncoder().encode('bunny-talks/key-envelope/password/v1/wrapping-key'),
        32,
      );
      try {
        if (toHex(output) !== 'e38919c1d56c76f701dcf94408f6949a6720fb93c512ad176281894384468c24')
          throw new Error();
      } finally {
        output.fill(0);
      }
      report({ label: stage, status: 'pass' });
      report({
        label: `Ordonnanceur JS : ${ticks} passages, intervalle maximal ${Math.round(maxGap)} ms`,
        status: 'info',
      });
    } finally {
      clearInterval(timer);
      result?.fill(0);
    }
  } catch {
    report({ label: stage, status: 'fail' });
  }
}
