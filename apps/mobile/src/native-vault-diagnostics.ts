import { getRandomValues } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type { Argon2idProvider } from '@bunny-talks/crypto-backup';
import {
  createAccountVault,
  openAccountVaultWithPassword,
  openAccountVaultWithRecoveryKey,
  rewrapAccountVaultPassword,
} from '@bunny-talks/crypto-backup';
import vector from '../../../packages/crypto/backup/tests/fixtures/account-vault-v1.json';
import nativeVector from '../../../packages/crypto/backup/tests/fixtures/native-vault-v1.json';
import type { DiagnosticEntry } from './diagnostics';

const encode = new TextEncoder();
const decode = new TextDecoder();
const recovery = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const password = 'public native vault password';
const context = { account: 'native-vault-diagnostic', vaultId: 'AAECAwQFBgcICQoLDA0ODw' };
const storage = 'bunny.native-vault.diagnostic.v1';
const random = {
  async fill(bytes: Uint8Array) {
    getRandomValues(bytes);
  },
};
const check = (value: unknown) => {
  if (!value) throw new Error('CHECK_FAILED');
};

/** Public test credentials only. One manually requested step at a time, fail-stop. */
export function createNativeVaultDiagnostics(provider: Argon2idProvider) {
  let index = 0;
  let stopped = false;
  let running = false;
  let publication: Uint8Array | undefined;
  let kdfs = 0;
  const bounded: Argon2idProvider = {
    async derive(...args) {
      if (++kdfs > 16) throw new Error('DIAGNOSTIC_BUDGET');
      return provider.derive(...args);
    },
  };
  const opened = async (data: Uint8Array, pass: string) => {
    const result = await openAccountVaultWithPassword(data, pass, context, bounded);
    check(result.ok);
    if (result.ok) {
      try {
        check(decode.decode(result.plaintext) === 'public native vault payload');
      } finally {
        result.plaintext.fill(0);
      }
    }
  };
  const restored = async (data: Uint8Array) => {
    const result = await openAccountVaultWithRecoveryKey(data, recovery, context);
    check(result.ok);
    if (result.ok) {
      try {
        check(decode.decode(result.plaintext) === 'public native vault payload');
      } finally {
        result.plaintext.fill(0);
      }
    }
  };
  const rewrap = async (
    access: { type: 'password'; password: string } | { type: 'recovery'; recoveryKey: Uint8Array },
    next: string,
  ) => {
    const old = JSON.parse(decode.decode(publication!)) as {
      content: string;
      recoveryEnvelope: string;
    };
    const result = await rewrapAccountVaultPassword(
      publication!,
      context,
      access,
      next,
      random,
      bounded,
    );
    const updated = JSON.parse(decode.decode(result)) as typeof old;
    check(old.content === updated.content && old.recoveryEnvelope === updated.recoveryEnvelope);
    publication = result;
  };
  const steps: [string, () => Promise<void>][] = [
    [
      'Création native (2 KDF)',
      async () => {
        let counter = 0;
        // Deterministic entropy is exclusively for this public interoperability fixture.
        const fixtureRandom = {
          async fill(bytes: Uint8Array) {
            for (let i = 0; i < bytes.length; i++) bytes[i] = counter++ % 256;
          },
        };
        publication = await createAccountVault(
          context,
          password,
          recovery,
          encode.encode('public native vault payload'),
          fixtureRandom,
          bounded,
        );
        check(decode.decode(publication) === nativeVector.publication);
      },
    ],
    ['Ouverture mot de passe (1 KDF)', async () => opened(publication!, password)],
    ['Ouverture récupération (sans KDF)', async () => restored(publication!)],
    [
      'Réenveloppement ancien mot de passe (3 KDF)',
      async () => rewrap({ type: 'password', password }, password + '2'),
    ],
    [
      'Accès après réenveloppement (1 KDF)',
      async () => {
        await opened(publication!, password + '2');
        await restored(publication!);
      },
    ],
    [
      'Réenveloppement récupération (2 KDF)',
      async () => rewrap({ type: 'recovery', recoveryKey: recovery }, password + '3'),
    ],
    [
      'Manifest et deux accès finaux (1 KDF)',
      async () => {
        await opened(publication!, password + '3');
        await restored(publication!);
      },
    ],
    [
      'Rejets secrets et contexte (1 KDF)',
      async () => {
        const bad = await openAccountVaultWithPassword(publication!, 'incorrect', context, bounded);
        check(!bad.ok && bad.code === 'AUTHENTICATION_FAILED');
        const key = await openAccountVaultWithRecoveryKey(
          publication!,
          new Uint8Array(32),
          context,
        );
        check(!key.ok && key.code === 'AUTHENTICATION_FAILED');
        const ctx = await openAccountVaultWithPassword(
          publication!,
          password + '3',
          { ...context, account: 'other' },
          bounded,
        );
        check(!ctx.ok && ctx.code === 'CONTEXT_MISMATCH');
      },
    ],
    [
      'Vecteur Node vers Android (1 KDF)',
      async () => {
        const result = await openAccountVaultWithPassword(
          encode.encode(vector.publication),
          vector.password,
          vector.context,
          bounded,
        );
        check(result.ok);
        if (result.ok) {
          try {
            check(
              Array.from(result.plaintext, (b) => b.toString(16).padStart(2, '0')).join('') ===
                vector.plaintext,
            );
          } finally {
            result.plaintext.fill(0);
          }
        }
      },
    ],
    [
      'Persistance isolée (sans KDF)',
      async () => {
        check((await SecureStore.getItemAsync(storage)) === null);
        await SecureStore.setItemAsync(storage, decode.decode(publication!));
        check((await SecureStore.getItemAsync(storage)) === decode.decode(publication!));
      },
    ],
  ];
  return {
    label: () =>
      stopped
        ? 'Diagnostic arrêté'
        : (steps[index]?.[0] ?? 'Terminé : arrêt forcé puis réouverture'),
    async next(report: (entry: DiagnosticEntry) => void) {
      if (running || stopped || index >= steps.length) return;
      running = true;
      const [label, run] = steps[index]!;
      const start = performance.now();
      let ticks = 0;
      const timer = setInterval(() => {
        ticks++;
      }, 50);
      try {
        await run();
        index++;
        report({
          label: `${label} ; activité JS ${ticks} ; KDF cumulés ${kdfs}/16`,
          status: 'pass',
          durationMs: Math.round(performance.now() - start),
        });
      } catch {
        stopped = true;
        report({ label, status: 'fail' });
      } finally {
        clearInterval(timer);
        running = false;
      }
    },
    async reopen(report: (entry: DiagnosticEntry) => void) {
      if (running || stopped) return;
      running = true;
      const start = performance.now();
      try {
        // A fresh controller has no in-memory candidate. Do not certify a same-runtime read.
        check(publication === undefined);
        const saved = await SecureStore.getItemAsync(storage);
        check(saved);
        await opened(encode.encode(saved!), password + '3');
        await restored(encode.encode(saved!));
        report({
          label: 'Publication persistée : deux accès (nouveau contrôleur)',
          status: 'pass',
          durationMs: Math.round(performance.now() - start),
        });
      } catch {
        stopped = true;
        report({ label: 'Réouverture persistante', status: 'fail' });
      } finally {
        running = false;
      }
    },
  };
}
