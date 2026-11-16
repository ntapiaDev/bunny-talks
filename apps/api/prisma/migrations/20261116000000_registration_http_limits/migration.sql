BEGIN;
CREATE TABLE "RegistrationBudget" (
  "key" CHAR(64) PRIMARY KEY,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "hits" INTEGER NOT NULL,
  CONSTRAINT "RegistrationBudget_values" CHECK (
    "key" ~ '^[a-f0-9]{64}$' AND "hits" > 0 AND isfinite("startedAt")
    AND isfinite("expiresAt") AND "expiresAt" > "startedAt"
  )
);
CREATE INDEX "RegistrationBudget_expiresAt_idx" ON "RegistrationBudget"("expiresAt");
CREATE TABLE "RegistrationLease" (
  "id" UUID PRIMARY KEY,
  "kind" VARCHAR(8) NOT NULL CHECK ("kind" IN ('request', 'complete')),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL CHECK (isfinite("expiresAt"))
);
CREATE INDEX "RegistrationLease_expiresAt_idx" ON "RegistrationLease"("expiresAt");
CREATE INDEX "EmailRegistration_pending_canonical_idx" ON "EmailRegistration"("canonical", "expiresAt") WHERE "completedAt" IS NULL;
COMMIT;
