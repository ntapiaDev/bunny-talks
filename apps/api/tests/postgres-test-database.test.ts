import { expect, it } from 'vitest';
import { createTestDatabase } from './postgres-test-database.js';

it.each([
  'postgresql://test@127.0.0.1:1/bunny_talks',
  'postgresql://test@remote.invalid:1/bunny_talks_test',
  'postgresql://test@localhost:1/bunny_talks_test?schema=public',
  'postgresql://test@localhost:1/bunny_talks_test#fragment',
  'https://localhost/bunny_talks_test',
])('refuses unsafe database URLs before opening a connection: %s', async (url) => {
  await expect(createTestDatabase(url)).rejects.toMatchObject({ name: 'AssertionError' });
});
