import { describe, expect, it } from 'vitest';
import { generateOpaqueToken, parseOpaqueToken } from '../src/session-token.js';
describe('reauthentication tokens', () => {
  it('uses independent secrets and rejects session tokens and noncanonical input', () => {
    const first = generateOpaqueToken('r1');
    const second = generateOpaqueToken('r1');
    expect(first.token).not.toBe(second.token);
    expect(parseOpaqueToken(first.token, 'r1').hash).toEqual(first.hash);
    for (const token of [first.id, first.token + '=', first.token.replace('r1.', 's1.'), '', null])
      expect(() => parseOpaqueToken(token, 'r1')).toThrow();
  });
});
