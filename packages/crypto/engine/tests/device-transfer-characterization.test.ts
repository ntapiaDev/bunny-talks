import { timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackupStorage } from '@open-e2ee/signal-protocol-sdk/device';
import {
  createDeviceBackup,
  decryptBackup,
  deriveTransferKeys,
  encryptBackup,
  generateTransferKeyPair,
  prepareNewDeviceTransfer,
  prepareOldDeviceTransferWithBackup,
  QR_CODE_MAX_AGE,
  validateBackup,
  verifyTransferQRCode,
  wipeTransferKeys,
} from '@open-e2ee/signal-protocol-sdk/device';
import { base64ToBytes, bytesToBase64 } from '@open-e2ee/signal-protocol-sdk/encoding';
import {
  generateEcOneTimePreKeys,
  generateIdentityKeyPair,
} from '@open-e2ee/signal-protocol-sdk/keys';
import { nodeStore } from '@open-e2ee/signal-protocol-sdk/local/store/node';
import type { SignalProtocolLocalSecretVault } from '@open-e2ee/signal-protocol-sdk/local/vault';
import { asBase64 } from '@open-e2ee/signal-protocol-sdk/types/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importIdentity, validateExportedIdentity } from '../src/index.js';

// These tests characterize primitives; they do not authenticate an association.
function exportOnlyStorage(getIdentityKey: BackupStorage['getIdentityKey']): BackupStorage {
  return {
    getIdentityKey,
    async storeIdentityKey() {
      throw new Error('Export-only adapter');
    },
    async runRestoreTransaction() {
      throw new Error('Export-only adapter');
    },
  };
}

async function createTransferFixture() {
  const identity = await generateIdentityKeyPair();
  const receiver = await prepareNewDeviceTransfer({ platform: 'android' });
  const storage = exportOnlyStorage(async () => ({
    dhKey: identity.dhKey,
    signingKey: identity.signingKey,
  }));
  const sender = await prepareOldDeviceTransferWithBackup(storage, { platform: 'ios' });
  const qr = await verifyTransferQRCode(receiver.qrCode);
  const senderKeys = await deriveTransferKeys(sender.keyPair.privateKey, qr.publicKey);
  const receiverKeys = await deriveTransferKeys(
    receiver.keyPair.privateKey,
    sender.keyPair.publicKey,
  );
  const backup = await sender.getBackup();
  const encrypted = await encryptBackup(backup, senderKeys.encryptionKey);
  return { identity, receiver, sender, qr, senderKeys, receiverKeys, backup, encrypted };
}

describe('OpenE2EE device transfer primitives', () => {
  let fixture: Awaited<ReturnType<typeof createTransferFixture>>;
  beforeEach(async () => {
    fixture = await createTransferFixture();
  });
  afterEach(() => {
    if (!fixture) return;
    for (const keys of [fixture.senderKeys, fixture.receiverKeys]) {
      keys.encryptionKey.fill(0);
      keys.authenticationKey.fill(0);
    }
    wipeTransferKeys(fixture.sender.keyPair);
    wipeTransferKeys(fixture.receiver.keyPair);
  });

  it('exports and imports only the identity into an independent SQLCipher store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bunny-transfer-'));
    const secrets = new Map<string, Uint8Array>();
    const vault: SignalProtocolLocalSecretVault = {
      async getSecret(name) {
        return secrets.get(name)?.slice() ?? null;
      },
      async setSecret(name, value) {
        secrets.set(name, value.slice());
      },
      async deleteSecret(name) {
        secrets.delete(name);
      },
    };
    let source: Awaited<ReturnType<typeof nodeStore>> | undefined;
    let destination: Awaited<ReturnType<typeof nodeStore>> | undefined;
    try {
      source = await nodeStore({ directory, name: 'source.db', vault });
      destination = await nodeStore({ directory, name: 'destination.db', vault });
      await source.storeIdentityKey(fixture.identity, 'aci');
      await source.storeEcOneTimePreKeys(await generateEcOneTimePreKeys(1), 'aci');
      const sourceStore = source;
      const storage = exportOnlyStorage(async () => {
        const stored = await sourceStore.getIdentityKey('aci');
        return stored === null ? null : { dhKey: stored.dhKey, signingKey: stored.signingKey };
      });
      const backup = await createDeviceBackup(storage, { platform: 'ios' });
      expect(Object.keys(backup.identityKey).sort()).toEqual(['dhKey', 'signingKey']);
      expect('registrationId' in backup.identityKey).toBe(false);
      expect('sessions' in backup).toBe(false);
      expect('oneTimePreKeys' in backup).toBe(false);
      const encrypted = await encryptBackup(backup, fixture.senderKeys.encryptionKey);
      expect(JSON.stringify(encrypted).includes(fixture.identity.dhKey.privateKey)).toBe(false);
      expect(JSON.stringify(encrypted).includes(fixture.identity.signingKey.privateKey)).toBe(
        false,
      );
      const received = await decryptBackup(encrypted, fixture.receiverKeys.encryptionKey);
      const registrationId = fixture.identity.registrationId === 1 ? 2 : 1;
      await importIdentity(destination, received.identityKey, registrationId);
      const restored = await destination.getIdentityKey('aci');
      expect(restored?.dhKey.publicKey === fixture.identity.dhKey.publicKey).toBe(true);
      expect(restored?.dhKey.privateKey === fixture.identity.dhKey.privateKey).toBe(true);
      expect(restored?.signingKey.publicKey === fixture.identity.signingKey.publicKey).toBe(true);
      expect(restored?.signingKey.privateKey === fixture.identity.signingKey.privateKey).toBe(true);
      expect(restored?.registrationId).toBe(registrationId);
      expect(await destination.getLocalRegistrationId('aci')).toBe(registrationId);
      expect(await destination.getSessionCount()).toBe(0);
      expect(await destination.getEcOneTimePreKeys('aci')).toHaveLength(0);
      expect(await source.getEcOneTimePreKeys('aci')).toHaveLength(1);
    } finally {
      const closed = await Promise.allSettled([source?.close(), destination?.close()]);
      for (const secret of secrets.values()) secret.fill(0);
      const removed = await Promise.allSettled([rm(directory, { recursive: true, force: true })]);
      expect([...closed, ...removed].every((result) => result.status === 'fulfilled')).toBe(true);
    }
  });

  it('derives matching encryption and authentication keys on both sides', () => {
    expect(
      timingSafeEqual(fixture.senderKeys.encryptionKey, fixture.receiverKeys.encryptionKey),
    ).toBe(true);
    expect(
      timingSafeEqual(fixture.senderKeys.authenticationKey, fixture.receiverKeys.authenticationKey),
    ).toBe(true);
  });

  it('rejects altered ciphertext', async () => {
    const ciphertext = base64ToBytes(asBase64(fixture.encrypted.ciphertext));
    ciphertext[0] = ciphertext[0]! ^ 1;
    await expect(
      decryptBackup(
        { ...fixture.encrypted, ciphertext: bytesToBase64(ciphertext) },
        fixture.receiverKeys.encryptionKey,
      ),
    ).rejects.toThrow();
  });

  it('rejects decryption with a key from an unrelated device', async () => {
    const attacker = await generateTransferKeyPair();
    try {
      const keys = await deriveTransferKeys(attacker.privateKey, fixture.sender.keyPair.publicKey);
      try {
        await expect(decryptBackup(fixture.encrypted, keys.encryptionKey)).rejects.toThrow();
      } finally {
        keys.encryptionKey.fill(0);
        keys.authenticationKey.fill(0);
      }
    } finally {
      wipeTransferKeys(attacker);
    }
  });

  it('allows repeated QR validation and packet decryption without replay state', async () => {
    expect(
      (await verifyTransferQRCode(fixture.receiver.qrCode)).publicKey === fixture.qr.publicKey,
    ).toBe(true);
    for (let i = 0; i < 2; i++) {
      const decrypted = await decryptBackup(fixture.encrypted, fixture.receiverKeys.encryptionKey);
      expect(decrypted.identityKey.dhKey.publicKey === fixture.identity.dhKey.publicKey).toBe(true);
    }
  });

  it('does not verify the outer encrypted backup metadata during decryption', async () => {
    const decrypted = await decryptBackup(
      { ...fixture.encrypted, metadata: { ...fixture.encrypted.metadata, version: 999 } },
      fixture.receiverKeys.encryptionKey,
    );
    expect(decrypted.identityKey.dhKey.publicKey === fixture.identity.dhKey.publicKey).toBe(true);
  });

  it('can decrypt a substituted sender packet when no sender authentication is applied', async () => {
    const attacker = await generateTransferKeyPair();
    try {
      const attackerKeys = await deriveTransferKeys(attacker.privateKey, fixture.qr.publicKey);
      const receiverKeys = await deriveTransferKeys(
        fixture.receiver.keyPair.privateKey,
        attacker.publicKey,
      );
      try {
        const attackerIdentity = await generateIdentityKeyPair();
        const forged = await encryptBackup(
          {
            ...fixture.backup,
            identityKey: { dhKey: attackerIdentity.dhKey, signingKey: attackerIdentity.signingKey },
          },
          attackerKeys.encryptionKey,
        );
        const decrypted = await decryptBackup(forged, receiverKeys.encryptionKey);
        expect(decrypted.identityKey.dhKey.publicKey === attackerIdentity.dhKey.publicKey).toBe(
          true,
        );
      } finally {
        for (const key of [
          attackerKeys.encryptionKey,
          attackerKeys.authenticationKey,
          receiverKeys.encryptionKey,
          receiverKeys.authenticationKey,
        ])
          key.fill(0);
      }
    } finally {
      wipeTransferKeys(attacker);
    }
  });

  it('checks QR format, version, declared timestamp age and future clock skew', async () => {
    expect(fixture.qr.publicKey === fixture.receiver.keyPair.publicKey).toBe(true);
    for (const invalid of [
      { ...fixture.qr, timestamp: Date.now() - QR_CODE_MAX_AGE - 1000 },
      { ...fixture.qr, timestamp: Date.now() + 31000 },
      { ...fixture.qr, publicKey: 'invalid' },
      { ...fixture.qr, version: -1 },
    ])
      await expect(verifyTransferQRCode(JSON.stringify(invalid))).rejects.toThrow();
  });

  it('accepts a structurally valid but inconsistent key pair while the engine rejects it', async () => {
    const other = await generateIdentityKeyPair();
    const mismatched = {
      ...fixture.backup,
      identityKey: {
        ...fixture.backup.identityKey,
        dhKey: { ...fixture.backup.identityKey.dhKey, publicKey: other.dhKey.publicKey },
      },
    };
    expect(() => validateBackup(mismatched)).not.toThrow();
    expect(() => validateExportedIdentity(mismatched.identityKey)).toThrow();
    expect(() =>
      validateBackup({ ...fixture.backup, sessions: [] } as typeof fixture.backup),
    ).toThrow();
  });

  it('retains an extra registration ID when the export adapter returns one', async () => {
    const unfiltered = await createDeviceBackup(
      exportOnlyStorage(async () => fixture.identity),
      {},
    );
    expect('registrationId' in unfiltered.identityKey).toBe(true);
    expect(() => validateBackup(unfiltered)).not.toThrow();
  });
});
