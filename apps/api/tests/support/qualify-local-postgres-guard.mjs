import assert from 'node:assert/strict';

export function validateDisposablePostgres(container) {
  assert.equal(container.Config.Labels?.bunny45a, 'temporary');
  assert.equal(container.State.Running, true);
  const volumes = container.Mounts.filter((mount) => mount.Type === 'volume');
  assert.equal(volumes.length, 1, 'Exactly one disposable PostgreSQL volume is required');
  assert.match(volumes[0].Name, /^bunny45a-[a-z0-9-]+$/);
  assert.equal(volumes[0].Destination, '/var/lib/postgresql');
  assert.equal(volumes[0].RW, true);
  // Reject an overlay that could redirect PGDATA outside the verified volume.
  assert.equal(
    container.Mounts.filter(
      (mount) =>
        mount.Destination === '/var' ||
        mount.Destination === '/var/lib' ||
        mount.Destination === '/var/lib/postgresql' ||
        mount.Destination.startsWith('/var/lib/postgresql/'),
    ).length,
    1,
    'Incompatible PostgreSQL mount',
  );
}
