import { expect, it } from 'vitest';
import {
  validateLocalMigrationUrl,
  verifyLocalMigrationConnection,
} from '../../../migrate-local.mjs';

it.each([
  undefined,
  'postgresql://bunny_dev:secret@localhost/bunny_talks',
  'postgresql://bunny_dev:secret@localhost:5432/bunny_talks',
  'postgresql://bunny_dev:secret@localhost:55432/bunny_talks',
  'postgresql://bunny_dev:secret@localhost:57488/bunny_talks',
  'postgresql://bunny_dev:secret@localhost:15432/bunny_talks_test',
  'postgresql://bunny_admin:secret@localhost:15432/bunny_talks',
  'postgresql://bunny_dev:secret@remote.invalid:15432/bunny_talks',
  'postgresql://bunny_dev:secret@localhost:15432/bunny_talks?schema=public',
  'postgresql://bunny_dev:secret@localhost:15432/bunny_talks#fragment',
])('rejects a migration to an unsafe destination', (value) => {
  expect(() => validateLocalMigrationUrl(value)).toThrow('Invalid local migration configuration');
});
it('accepts the dedicated local development destination', () => {
  expect(
    validateLocalMigrationUrl('postgresql://bunny_dev:secret@localhost:15432/bunny_talks').pathname,
  ).toBe('/bunny_talks');
});

it.each(['18.6', '18.70', '19.7', '', undefined])(
  'rejects an unexpected server version',
  async (version) => {
    await expect(
      verifyLocalMigrationConnection({ query: async () => ({ rows: [{ safe: true, version }] }) }),
    ).rejects.toThrow('Unsafe local migration');
  },
);
it.each(['18.7', '18.7 (Debian build)'])('accepts PostgreSQL 18.7', async (version) => {
  await expect(
    verifyLocalMigrationConnection({ query: async () => ({ rows: [{ safe: true, version }] }) }),
  ).resolves.toBeUndefined();
});
it('still rejects unsafe server permissions on the correct version', async () => {
  await expect(
    verifyLocalMigrationConnection({
      query: async () => ({ rows: [{ safe: false, version: '18.7' }] }),
    }),
  ).rejects.toThrow('Unsafe local migration');
});
