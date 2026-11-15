CREATE UNIQUE INDEX "Session_accountId_id_deviceId_key" ON "Session"("accountId", "id", "deviceId");
CREATE TABLE "ReauthenticationGrant" (
  "id" UUID PRIMARY KEY,
  "tokenHash" BYTEA NOT NULL,
  "accountId" VARCHAR(128) NOT NULL,
  "sessionId" UUID NOT NULL,
  "deviceId" UUID NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "operationId" UUID NOT NULL,
  "intentHash" BYTEA NOT NULL,
  "credentialRevision" BIGINT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "consumedAt" TIMESTAMPTZ(3),
  CONSTRAINT "Grant_session_fkey" FOREIGN KEY ("accountId", "sessionId", "deviceId") REFERENCES "Session"("accountId", "id", "deviceId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "Grant_values" CHECK (
    octet_length("tokenHash") = 32 AND octet_length("intentHash") = 32
    AND "kind" = 'ordinary-password-change' AND "credentialRevision" > 0
    AND isfinite("createdAt") AND isfinite("expiresAt")
    AND "expiresAt" = "createdAt" + INTERVAL '5 minutes'
    AND ("consumedAt" IS NULL OR (isfinite("consumedAt") AND "consumedAt" >= "createdAt" AND "consumedAt" < "expiresAt"))
  )
);
-- Identity is immutable; consumption may advance once only, never be undone.
CREATE FUNCTION prevent_grant_reassignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'consumedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'consumedAt')
     OR (OLD."consumedAt" IS NOT NULL AND NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt") THEN
    RAISE EXCEPTION 'immutable grant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Grant_immutable" BEFORE UPDATE ON "ReauthenticationGrant"
FOR EACH ROW EXECUTE FUNCTION prevent_grant_reassignment();
