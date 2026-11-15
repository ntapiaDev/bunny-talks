BEGIN;

-- No backfill: historical publications do not identify their initiating device.
CREATE TABLE "InitialBootstrapOperation" (
  "accountId" VARCHAR(128) NOT NULL,
  "operationId" UUID NOT NULL,
  "deviceId" UUID NOT NULL,
  CONSTRAINT "InitialBootstrapOperation_pkey" PRIMARY KEY ("accountId", "operationId"),
  CONSTRAINT "Bootstrap_operation_fkey" FOREIGN KEY ("accountId", "operationId") REFERENCES "VaultOperation"("accountId", "operationId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "Bootstrap_device_fkey" FOREIGN KEY ("accountId", "deviceId") REFERENCES "Device"("accountId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- Keep the binding permanently, including after device/session revocation.
CREATE FUNCTION protect_initial_bootstrap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt "VaultOperation"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'immutable bootstrap binding' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM "Account" WHERE id = NEW."accountId" FOR UPDATE;
  SELECT * INTO receipt FROM "VaultOperation"
    WHERE "accountId" = NEW."accountId" AND "operationId" = NEW."operationId";
  IF receipt.kind IS DISTINCT FROM 'initial-publication' THEN
    RAISE EXCEPTION 'bootstrap requires initial receipt' USING ERRCODE = '23514';
  END IF;
  IF receipt.status = 'COMMITTED' AND EXISTS (
    SELECT 1 FROM "InitialBootstrapOperation" b JOIN "VaultOperation" o
      USING ("accountId", "operationId")
    WHERE b."accountId" = NEW."accountId" AND o.status = 'COMMITTED'
  ) THEN
    RAISE EXCEPTION 'bootstrap already committed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Bootstrap_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "InitialBootstrapOperation"
FOR EACH ROW EXECUTE FUNCTION protect_initial_bootstrap();

-- A bound rejection must never be rewritten as a success (or conversely).
CREATE FUNCTION protect_bootstrap_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD AND EXISTS (
    SELECT 1 FROM "InitialBootstrapOperation"
      WHERE "accountId" = OLD."accountId" AND "operationId" = OLD."operationId"
  ) THEN
    RAISE EXCEPTION 'immutable bootstrap receipt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Bootstrap_receipt_immutable" BEFORE UPDATE ON "VaultOperation"
FOR EACH ROW EXECUTE FUNCTION protect_bootstrap_receipt();

COMMIT;
