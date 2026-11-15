BEGIN;

-- Existing verifier timestamps are unknown, not the time of this migration.
ALTER TABLE "PasswordCredential" ADD COLUMN "verifierUpdatedAt" TIMESTAMPTZ(3);
ALTER TABLE "PasswordCredential" ALTER COLUMN "verifierUpdatedAt" SET DEFAULT statement_timestamp();
ALTER TABLE "PasswordCredential" ADD CONSTRAINT "Credential_timestamp_finite"
  CHECK ("verifierUpdatedAt" IS NULL OR isfinite("verifierUpdatedAt"));

-- Cover all writers, including rewrapping and future profile upgrades.
CREATE FUNCTION maintain_verifier_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."verifierUpdatedAt" := clock_timestamp();
  ELSIF NEW.verifier IS DISTINCT FROM OLD.verifier THEN
    NEW."verifierUpdatedAt" := clock_timestamp();
  ELSE
    NEW."verifierUpdatedAt" := OLD."verifierUpdatedAt";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Credential_timestamp" BEFORE INSERT OR UPDATE ON "PasswordCredential"
FOR EACH ROW EXECUTE FUNCTION maintain_verifier_timestamp();

-- ASCII dot-atom local part, DNS domain, no provider-specific equivalences.
CREATE FUNCTION valid_login_email(display TEXT, canonical TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT octet_length(display) BETWEEN 3 AND 254
    AND octet_length(split_part(display, '@', 1)) BETWEEN 1 AND 64
    AND display COLLATE "C" ~ '^([A-Za-z0-9_''+-]+\.)*[A-Za-z0-9_''+-]*[A-Za-z0-9_+-]@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$'
    AND NOT EXISTS (
      SELECT 1 FROM unnest(string_to_array(split_part(display, '@', 2), '.')) label
      WHERE octet_length(label) > 63
    )
    AND canonical COLLATE "C" = (split_part(display, '@', 1) || '@' || lower(split_part(display, '@', 2) COLLATE "C")) COLLATE "C";
$$;

CREATE TABLE "EmailIdentity" (
  "accountId" VARCHAR(128) PRIMARY KEY,
  "canonical" VARCHAR(254) COLLATE "C" NOT NULL,
  "display" VARCHAR(254) NOT NULL,
  "verifiedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "EmailIdentity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EmailIdentity_values" CHECK (valid_login_email("display", "canonical") AND isfinite("verifiedAt"))
);
CREATE UNIQUE INDEX "EmailIdentity_canonical_key" ON "EmailIdentity"("canonical");

-- Pending intentions do not reserve an address. Completed rows are durable receipts.
CREATE TABLE "EmailRegistration" (
  "id" UUID PRIMARY KEY,
  "canonical" VARCHAR(254) COLLATE "C" NOT NULL,
  "display" VARCHAR(254) NOT NULL,
  "tokenHash" BYTEA NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3),
  "accountId" VARCHAR(128),
  CONSTRAINT "EmailRegistration_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EmailRegistration_values" CHECK (
    valid_login_email("display", "canonical") AND octet_length("tokenHash") = 32
    AND isfinite("createdAt") AND isfinite("expiresAt")
    AND "expiresAt" = "createdAt" + INTERVAL '30 minutes'
    AND (("completedAt" IS NULL AND "accountId" IS NULL)
      OR ("completedAt" IS NOT NULL AND "accountId" IS NOT NULL
        AND isfinite("completedAt") AND "completedAt" >= "createdAt" AND "completedAt" < "expiresAt"))
  )
);
CREATE UNIQUE INDEX "EmailRegistration_accountId_key" ON "EmailRegistration"("accountId");
CREATE INDEX "EmailRegistration_expiresAt_idx" ON "EmailRegistration"("expiresAt");

CREATE FUNCTION protect_email_registration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."completedAt" IS NOT NULL OR NEW."accountId" IS NOT NULL THEN
      RAISE EXCEPTION 'registration must start pending' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - 'completedAt' - 'accountId') IS DISTINCT FROM (to_jsonb(OLD) - 'completedAt' - 'accountId')
      OR (OLD."completedAt" IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'immutable registration' USING ERRCODE = '23514';
    END IF;
    IF NEW."completedAt" IS NOT NULL AND OLD."completedAt" IS NULL THEN
      IF NOT EXISTS (SELECT 1 FROM "EmailIdentity" e JOIN "PasswordCredential" p ON p."accountId" = e."accountId"
        WHERE e."accountId" = NEW."accountId" AND e.canonical = NEW.canonical
          AND e."verifiedAt" = NEW."completedAt" AND p."verifierUpdatedAt" IS NOT NULL) THEN
        RAISE EXCEPTION 'incomplete registration' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "EmailRegistration_lifecycle" BEFORE INSERT OR UPDATE ON "EmailRegistration"
FOR EACH ROW EXECUTE FUNCTION protect_email_registration();

COMMIT;
