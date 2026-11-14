import { describe, expect, it } from 'vitest';
import { checkWitness } from '../src/witness';

const digest = 'a'.repeat(64);
const marker = JSON.stringify({ process: 'first-process', state: digest });

describe('persistent diagnostic witness', () => {
  it('distinguishes re-execution in one process from a fresh process', () => {
    expect(checkWitness(marker, digest, 'first-process')).toBe('same-process');
    expect(checkWitness(marker, digest, 'next-process')).toBe('new-process');
  });
  it('rejects changed, missing or malformed persisted state', () => {
    expect(() => checkWitness(marker, 'b'.repeat(64), 'next-process')).toThrow();
    for (const value of [
      '',
      '{}',
      'null',
      'invalid',
      JSON.stringify({ process: '', state: digest }),
    ])
      expect(() => checkWitness(value, digest, 'next-process')).toThrow();
  });
});
