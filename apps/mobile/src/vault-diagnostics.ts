import { CryptoDigestAlgorithm, digestStringAsync, getRandomValues } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {
  createAccountVault,
  createPasswordKeyEnvelope,
  createRecoveryKeyEnvelope,
  derivePasswordWrappingKey,
  deriveRecoveryWrappingKey,
  generateMasterKey,
  generateRecoveryKey,
  generateVaultId,
  openAccountVaultWithPassword,
  openAccountVaultWithRecoveryKey,
  rewrapAccountVaultPassword,
  validateAccountVault,
} from '@bunny-talks/crypto-backup';
import vector from '../../../packages/crypto/backup/tests/fixtures/account-vault-v1.json';
import recoveryVector from '../../../packages/crypto/backup/tests/fixtures/key-envelope-recovery.json';
import type { DiagnosticEntry } from './diagnostics';
import { classifyVaultDiagnosticRecords } from './vault-diagnostic-state';

const prefix = 'bunny.vault.diagnostic.v1.';
const random = {
  async fill(bytes: Uint8Array) {
    getRandomValues(bytes);
  },
};
let runtime: string | undefined;
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) => {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new Error('Invalid diagnostic bytes');
  return Uint8Array.from(value.match(/../g)!, (byte) => parseInt(byte, 16));
};
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
function requireCheck(value: unknown): asserts value {
  if (!value) throw new Error('Diagnostic check failed');
}
const text = new TextEncoder();
const decode = new TextDecoder('utf-8', { fatal: true });

/** Diagnostic data only; failure never resets existing records. */
export async function runVaultDiagnostics(
  report: (entry: DiagnosticEntry) => void,
  full = false,
): Promise<void> {
  let stage = 'Initialisation coffre';
  let recovery: Uint8Array | undefined;
  let master: Uint8Array | undefined;
  let derivation: Uint8Array | undefined;
  const step = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    stage = label;
    report({ label: `${label} : en cours`, status: 'info' });
    const start = performance.now();
    const result = await run();
    report({ label, status: 'pass', durationMs: Math.round(performance.now() - start) });
    return result;
  };
  try {
    requireCheck(
      'HermesInternal' in globalThis && globalThis.crypto?.getRandomValues === getRandomValues,
    );
    runtime ??= hex(await generateMasterKey(random));
    const records = await Promise.all(
      ['password', 'recovery', 'publication', 'witness'].map((name) =>
        SecureStore.getItemAsync(prefix + name),
      ),
    );
    const [oldPassword, oldRecovery, oldPublication, oldWitness] = records;
    if (classifyVaultDiagnosticRecords(records) === 'partial')
      throw new Error('Partial diagnostic state');
    if (oldWitness && oldPassword && oldRecovery && oldPublication) {
      recovery = unhex(oldRecovery);
      const witness = JSON.parse(oldWitness) as {
        process: string;
        account: string;
        vaultId: string;
        digest: string;
      };
      requireCheck(
        typeof witness.process === 'string' &&
          typeof witness.account === 'string' &&
          typeof witness.vaultId === 'string' &&
          /^[0-9a-f]{64}$/.test(witness.digest),
      );
      requireCheck(
        (await digestStringAsync(CryptoDigestAlgorithm.SHA256, oldPublication)) === witness.digest,
      );
      const context = { account: witness.account, vaultId: witness.vaultId };
      const publication = text.encode(oldPublication);
      if (!full) {
        requireCheck(validateAccountVault(publication, context).ok);
        report({
          label: 'Publication persistante retrouvée : validation structurelle seule',
          status: 'info',
        });
        return;
      }
      await step('Coffre persistant : ouverture mot de passe', async () => {
        const result = await openAccountVaultWithPassword(publication, oldPassword, context);
        requireCheck(
          result.ok &&
            result.revisions.generation === 1 &&
            decode.decode(result.plaintext) === 'Bunny vault diagnostic',
        );
        result.plaintext.fill(0);
      });
      await step('Coffre persistant : ouverture récupération', async () => {
        const result = await openAccountVaultWithRecoveryKey(publication, recovery!, context);
        requireCheck(
          result.ok &&
            result.revisions.generation === 1 &&
            decode.decode(result.plaintext) === 'Bunny vault diagnostic',
        );
        result.plaintext.fill(0);
      });
      report({
        label:
          witness.process === runtime
            ? 'Même runtime : arrêt forcé nécessaire'
            : 'Nouveau runtime : publication retrouvée',
        status: 'info',
      });
      return;
    }
    const generated = await step('Génération native des secrets', async () => {
      master = await generateMasterKey(random);
      recovery = await generateRecoveryKey(random);
      const vaultId = await generateVaultId(random);
      const password = hex(await generateRecoveryKey(random));
      requireCheck(master.length === 32 && recovery.length === 32 && !same(master, recovery));
      return { context: { account: 'android-vault-diagnostic', vaultId }, password };
    });
    await step('Vecteur indépendant HKDF récupération', async () => {
      const actual = deriveRecoveryWrappingKey(
        unhex(recoveryVector.secret),
        unhex(recoveryVector.salt),
      );
      try {
        requireCheck(hex(actual) === recoveryVector.key);
      } finally {
        actual.fill(0);
      }
    });
    await step('Vecteur indépendant : publication et manifest', async () => {
      const fixed = await openAccountVaultWithRecoveryKey(
        text.encode(vector.publication),
        unhex(vector.recoveryKey),
        vector.context,
      );
      requireCheck(fixed.ok && hex(fixed.plaintext) === vector.plaintext);
      fixed.plaintext.fill(0);
      const wrongKey = await openAccountVaultWithRecoveryKey(
        text.encode(vector.publication),
        new Uint8Array(32),
        vector.context,
      );
      requireCheck(!wrongKey.ok && wrongKey.code === 'AUTHENTICATION_FAILED');
      const wrongAccount = await openAccountVaultWithRecoveryKey(
        text.encode(vector.publication),
        unhex(vector.recoveryKey),
        { ...vector.context, account: 'other' },
      );
      requireCheck(!wrongAccount.ok && wrongAccount.code === 'CONTEXT_MISMATCH');
      const changed = JSON.parse(vector.publication) as { manifest: { mac: string } };
      changed.manifest.mac = 'A'.repeat(43);
      const wrongMac = await openAccountVaultWithRecoveryKey(
        text.encode(JSON.stringify(changed)),
        unhex(vector.recoveryKey),
        vector.context,
      );
      requireCheck(!wrongMac.ok && wrongMac.code === 'AUTHENTICATION_FAILED');
    });
    if (!full) {
      report({ label: 'Contrôles rapides terminés ; Argon2id non exécuté', status: 'info' });
      return;
    }
    const argonStart = performance.now();
    await step('Vecteur indépendant Argon2id 64 Mio + HKDF', async () => {
      derivation = await derivePasswordWrappingKey(
        vector.password,
        Uint8Array.from({ length: 16 }, (_, index) => index + 32),
      );
      requireCheck(
        hex(derivation) === 'e38919c1d56c76f701dcf94408f6949a6720fb93c512ad176281894384468c24',
      );
      derivation.fill(0);
      derivation = undefined;
    });
    if (performance.now() - argonStart > 15000) {
      report({ label: 'Argon2id lent : essais coûteux arrêtés', status: 'info' });
      return;
    }
    await step('Enveloppes mot de passe et récupération', async () => {
      await createPasswordKeyEnvelope(
        master!,
        generated.password,
        { ...generated.context, revision: 1 },
        random,
      );
      await createRecoveryKeyEnvelope(
        master!,
        recovery!,
        { ...generated.context, revision: 1 },
        random,
      );
    });
    const publication = await step('Création du coffre', () =>
      createAccountVault(
        generated.context,
        generated.password,
        recovery!,
        text.encode('Bunny vault diagnostic'),
        random,
      ),
    );
    await step('Ouverture par mot de passe', async () => {
      const result = await openAccountVaultWithPassword(
        publication,
        generated.password,
        generated.context,
      );
      requireCheck(result.ok && decode.decode(result.plaintext) === 'Bunny vault diagnostic');
      result.plaintext.fill(0);
    });
    await step('Ouverture par récupération', async () => {
      const result = await openAccountVaultWithRecoveryKey(
        publication,
        recovery!,
        generated.context,
      );
      requireCheck(result.ok && decode.decode(result.plaintext) === 'Bunny vault diagnostic');
      result.plaintext.fill(0);
    });
    const rewrapped = await step('Réenveloppement du mot de passe', () =>
      rewrapAccountVaultPassword(
        publication,
        generated.context,
        { type: 'recovery', recoveryKey: recovery! },
        generated.password + 'new',
        random,
      ),
    );
    await step('Réenveloppement : deux accès', async () => {
      const pass = await openAccountVaultWithPassword(
        rewrapped,
        generated.password + 'new',
        generated.context,
      );
      const restored = await openAccountVaultWithRecoveryKey(
        rewrapped,
        recovery!,
        generated.context,
      );
      requireCheck(
        pass.ok &&
          restored.ok &&
          pass.revisions.generation === 2 &&
          same(pass.plaintext, restored.plaintext),
      );
      pass.plaintext.fill(0);
      restored.plaintext.fill(0);
    });
    await step('Refus des secrets et publications altérés', async () => {
      requireCheck(
        !(await openAccountVaultWithPassword(publication, 'incorrect', generated.context)).ok,
      );
      requireCheck(
        !(await openAccountVaultWithRecoveryKey(publication, new Uint8Array(32), generated.context))
          .ok,
      );
      requireCheck(
        !(
          await openAccountVaultWithRecoveryKey(publication, recovery!, {
            ...generated.context,
            account: 'other',
          })
        ).ok,
      );
      const value = JSON.parse(decode.decode(publication)) as {
        manifest: { mac: string };
        header: { version: number };
      };
      value.manifest.mac = 'A'.repeat(43);
      requireCheck(
        !(
          await openAccountVaultWithRecoveryKey(
            text.encode(JSON.stringify(value)),
            recovery!,
            generated.context,
          )
        ).ok,
      );
      value.header.version = 2;
      requireCheck(!validateAccountVault(text.encode(JSON.stringify(value)), generated.context).ok);
    });
    stage = 'Persistance isolée SecureStore';
    await SecureStore.setItemAsync(prefix + 'password', generated.password);
    await SecureStore.setItemAsync(prefix + 'recovery', hex(recovery!));
    await SecureStore.setItemAsync(prefix + 'publication', decode.decode(publication));
    const digest = await digestStringAsync(
      CryptoDigestAlgorithm.SHA256,
      decode.decode(publication),
    );
    await SecureStore.setItemAsync(
      prefix + 'witness',
      JSON.stringify({ process: runtime, ...generated.context, digest }),
    );
    report({ label: 'Publication conservée ; arrêter le processus puis relancer', status: 'info' });
  } catch {
    report({ label: stage, status: 'fail' });
  } finally {
    master?.fill(0);
    recovery?.fill(0);
    derivation?.fill(0);
  }
}
