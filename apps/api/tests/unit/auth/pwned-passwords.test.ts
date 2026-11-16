import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PwnedPasswords } from '../../../src/auth/registration/pwned-passwords.js';

function range(password: string, count: number) {
  const suffix = createHash('sha1').update(password).digest('hex').toUpperCase().slice(5);
  return (
    `${suffix}:${count}\r\n` +
    Array.from(
      { length: 800 },
      (_, index) => `${index.toString(16).toUpperCase().padStart(35, '0')}:0`,
    ).join('\r\n')
  );
}

describe('Pwned Passwords k-anonymity adapter', () => {
  const password = '  exact unicode e\u0301 😀 password  ';
  it.each([0, 12])(
    'compares the entire suffix locally, ignoring padding with count %s',
    async (count) => {
      const request = vi.fn<typeof fetch>(async () => new Response(range(password, count)));
      expect(await new PwnedPasswords(request).isBlocked(password)).toBe(count > 0);
      const [url, init] = request.mock.calls[0]!;
      expect(url).toBe(
        `https://api.pwnedpasswords.com/range/${createHash('sha1').update(password).digest('hex').slice(0, 5).toUpperCase()}`,
      );
      expect(init).toMatchObject({
        headers: { 'Add-Padding': 'true' },
        redirect: 'error',
        credentials: 'omit',
      });
      expect(JSON.stringify(request.mock.calls)).not.toContain(password);
      expect(JSON.stringify(request.mock.calls)).not.toContain(
        createHash('sha1').update(password).digest('hex').toUpperCase(),
      );
    },
  );
  it('never normalizes or trims the password before lookup', async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response(range(password.normalize('NFC'), 50)),
    );
    expect(await new PwnedPasswords(request).isBlocked(password)).toBe(false);
  });
  it('accepts full real-world ranges larger than 2,000 entries within the byte budget', async () => {
    const body =
      range(password, 12) +
      '\r\n' +
      Array.from(
        { length: 1400 },
        (_, index) => `${(index + 800).toString(16).toUpperCase().padStart(35, '0')}:0`,
      ).join('\r\n');
    const request = vi.fn<typeof fetch>(async () => new Response(body));
    expect(await new PwnedPasswords(request).isBlocked(password)).toBe(true);
  });
  it.each([
    () => new Response('upstream secret', { status: 503 }),
    () => new Response('malformed range'),
    () => new Response('A:1\r\n'.repeat(800)),
    () => new Response('x'.repeat(131073)),
    () => new Response(range(password, 0) + '\r\nbad'),
  ])('fails closed for status, malformed, incomplete or oversized ranges %#', async (response) => {
    const request = vi.fn<typeof fetch>(async () => response());
    await expect(new PwnedPasswords(request).isBlocked(password)).rejects.toThrow(
      'POLICY_UNAVAILABLE',
    );
  });
  it('fails closed and aborts a timed-out request', async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(new Error('upstream secret')));
          }),
      );
      const result = expect(new PwnedPasswords(request).isBlocked(password)).rejects.toThrow(
        'POLICY_UNAVAILABLE',
      );
      await vi.advanceTimersByTimeAsync(2000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });
});
