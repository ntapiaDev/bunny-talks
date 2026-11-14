import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as root from '../src/index.js';

describe('backup package entry points', () => {
  it('keeps historical APIs out of the root and behind the experimental entry point', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, { types: string; import: string }> };

    expect(Object.keys(root).sort()).toEqual(
      [
        'KeyEnvelopeError',
        'AccountVaultError',
        'createAccountVault',
        'openAccountVaultWithPassword',
        'openAccountVaultWithRecoveryKey',
        'rewrapAccountVaultPassword',
        'validateAccountVault',
        'createPasswordKeyEnvelope',
        'createRecoveryKeyEnvelope',
        'derivePasswordWrappingKey',
        'deriveRecoveryWrappingKey',
        'generateMasterKey',
        'generateRecoveryKey',
        'generateVaultId',
        'openPasswordKeyEnvelope',
        'openRecoveryKeyEnvelope',
        'validatePasswordKeyEnvelope',
        'validateRecoveryKeyEnvelope',
      ].sort(),
    );
    expect(manifest.exports).toEqual({
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './experimental': { types: './dist/experimental.d.ts', import: './dist/experimental.js' },
    });
  });
});
