import { createHash } from 'node:crypto';
import type { PasswordBlocklist } from './registration-policy.js';
import { RegistrationError } from './registration-policy.js';

/** SHA-1 is only the range lookup protocol; password storage always uses Argon2id. */
export class PwnedPasswords implements PasswordBlocklist {
  public constructor(private readonly request: typeof fetch = fetch) {}

  public async isBlocked(password: string): Promise<boolean> {
    const hash = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await this.request(
        `https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`,
        {
          headers: { 'Add-Padding': 'true', 'User-Agent': 'Bunny-Talks-Registration/1' },
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
        },
      );
      if (response.status !== 200 || !response.body) throw new Error('Unavailable');
      // Bound streamed data as well as declared size; malformed/partial ranges fail closed.
      let text = '';
      let bytes = 0;
      const reader = response.body.getReader();
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > 131072) throw new Error('Oversized range');
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
      // Real ranges can exceed 2,000 entries as the corpus grows; bound bytes, not corpus size.
      if (lines.length < 800) throw new Error('Incomplete range');
      const seen = new Set<string>();
      let blocked = false;
      for (const line of lines) {
        const match = /^([A-F0-9]{35}):([0-9]{1,15})$/.exec(line);
        if (!match || seen.has(match[1]!)) throw new Error('Malformed range');
        seen.add(match[1]!);
        if (match[1] === hash.slice(5) && Number(match[2]) > 0) blocked = true;
      }
      return blocked;
    } catch {
      throw new RegistrationError('POLICY_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
