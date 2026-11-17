CREATE TABLE "LoginBudget" (
  "key" CHAR(64) PRIMARY KEY,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "hits" INTEGER NOT NULL,
  CONSTRAINT "LoginBudget_values" CHECK ("key" ~ '^[a-f0-9]{64}$' AND "hits" > 0 AND "expiresAt" > "startedAt")
);
CREATE INDEX "LoginBudget_expiresAt_idx" ON "LoginBudget" ("expiresAt");
CREATE TABLE "LoginLease" (
  "id" UUID PRIMARY KEY,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "LoginLease_expiresAt_idx" ON "LoginLease" ("expiresAt");
