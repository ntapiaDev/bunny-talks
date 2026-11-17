import { expect, it } from 'vitest';
import { validateDisposablePostgres } from '../../support/qualify-local-postgres-guard.mjs';

const volume = {
  Type: 'volume',
  Name: 'bunny45a-fixture',
  Destination: '/var/lib/postgresql',
  RW: true,
};
const fixture = {
  Config: { Labels: { bunny45a: 'temporary' } },
  State: { Running: true },
  Mounts: [volume],
};
it('accepts an explicitly disposable PostgreSQL 18 volume', () => {
  expect(() => validateDisposablePostgres(fixture)).not.toThrow();
});
it.each([
  [],
  [{ ...volume, Name: 'bunny-talks_bunny_postgres_data' }],
  [{ ...volume, Type: 'bind' }],
  [{ ...volume, Destination: '/var/lib/postgresql/data' }],
  [{ ...volume, RW: false }],
  [volume, { Type: 'bind', Destination: '/var/lib/postgresql/18/docker' }],
  [volume, { Type: 'bind', Destination: '/var/lib' }],
  [volume, { ...volume, Name: 'bunny45a-other', Destination: '/other' }],
])('rejects absent or incompatible mounts', (Mounts) => {
  expect(() => validateDisposablePostgres({ ...fixture, Mounts })).toThrow();
});
it('rejects an unlabelled or stopped container', () => {
  expect(() => validateDisposablePostgres({ ...fixture, Config: { Labels: {} } })).toThrow();
  expect(() => validateDisposablePostgres({ ...fixture, State: { Running: false } })).toThrow();
});
