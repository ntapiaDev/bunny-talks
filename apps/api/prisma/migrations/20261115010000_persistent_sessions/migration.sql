-- Existing foundation sessions carry no bearer secret and remain unusable.
ALTER TABLE "Device" ADD COLUMN "authorizedAt" TIMESTAMPTZ(3);
ALTER TABLE "Device" ADD CONSTRAINT "Device_authorization_dates" CHECK (
  ("authorizedAt" IS NULL OR isfinite("authorizedAt"))
  AND ("revokedAt" IS NULL OR isfinite("revokedAt"))
  AND ("authorizedAt" IS NULL OR "revokedAt" IS NULL OR "revokedAt" >= "authorizedAt")
);
ALTER TABLE "Session"
  ADD COLUMN "tokenHash" BYTEA,
  ADD COLUMN "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "expiresAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "idleTimeoutMs" INTEGER;
-- Preserve historical revocations without inventing an active bearer session.
UPDATE "Session" SET
  "createdAt" = LEAST(CURRENT_TIMESTAMP, COALESCE("revokedAt", CURRENT_TIMESTAMP)),
  "expiresAt" = LEAST(CURRENT_TIMESTAMP, COALESCE("revokedAt", CURRENT_TIMESTAMP)),
  "lastSeenAt" = LEAST(CURRENT_TIMESTAMP, COALESCE("revokedAt", CURRENT_TIMESTAMP));
ALTER TABLE "Session" ADD CONSTRAINT "Session_lifecycle" CHECK (
  ("tokenHash" IS NULL OR octet_length("tokenHash") = 32)
  AND isfinite("createdAt") AND isfinite("expiresAt") AND isfinite("lastSeenAt")
  AND "expiresAt" >= "createdAt" AND "lastSeenAt" >= "createdAt"
  AND ("tokenHash" IS NULL OR ("expiresAt" > "createdAt" AND "lastSeenAt" < "expiresAt"))
  AND ("idleTimeoutMs" IS NULL OR "idleTimeoutMs" > 0)
  AND ("revokedAt" IS NULL OR (isfinite("revokedAt") AND "revokedAt" >= "createdAt"))
);
CREATE INDEX "Session_accountId_idx" ON "Session"("accountId");
