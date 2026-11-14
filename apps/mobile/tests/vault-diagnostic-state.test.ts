import { describe, expect, it } from 'vitest';
import { classifyVaultDiagnosticRecords } from '../src/vault-diagnostic-state';

describe('vault diagnostic record state', () => {
  it('distinguishes a fresh installation and complete records', () => {
    expect(classifyVaultDiagnosticRecords([null, null, null, null])).toBe('fresh');
    expect(classifyVaultDiagnosticRecords(['password', 'key', 'publication', 'witness'])).toBe(
      'stored',
    );
  });
  it('refuses incomplete, empty and incorrectly sized records', () => {
    for (const state of [
      [null, null, null],
      ['password', null, null, null],
      ['', '', '', ''],
      ['password', 'key', 'publication', null],
    ]) {
      expect(classifyVaultDiagnosticRecords(state)).toBe('partial');
    }
  });
});
