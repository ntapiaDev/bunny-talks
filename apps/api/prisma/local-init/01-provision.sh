#!/bin/sh
# No credential-bearing psql diagnostics are forwarded to container logs.
set -eu
if [ "${POSTGRES_USER:-}" != bunny_admin ] || [ "${POSTGRES_DB:-}" != postgres ]; then
  echo 'Local PostgreSQL requires POSTGRES_USER=bunny_admin and POSTGRES_DB=postgres' >&2
  exit 1
fi
if ! psql -X --username bunny_admin --dbname postgres --set ON_ERROR_STOP=1 \
  --file /docker-entrypoint-initdb.d/support/provision.sql >/dev/null 2>&1; then
  echo 'PostgreSQL provisioning refused or interrupted; inspect catalogs using the documented read-only diagnostic. No automatic repair.' >&2
  exit 1
fi
