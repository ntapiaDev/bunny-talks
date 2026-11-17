-- Admission state is independent of durable vault receipts and device authorization.
CREATE TABLE "BootstrapBudget" (
  "key" CHAR(64) PRIMARY KEY,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "hits" INTEGER NOT NULL CHECK ("hits" > 0)
);
CREATE INDEX "BootstrapBudget_expiresAt_idx" ON "BootstrapBudget"("expiresAt");
CREATE TABLE "BootstrapLease" (
  "id" UUID PRIMARY KEY,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "BootstrapLease_expiresAt_idx" ON "BootstrapLease"("expiresAt");
