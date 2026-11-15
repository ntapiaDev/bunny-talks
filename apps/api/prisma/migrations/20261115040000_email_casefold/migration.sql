BEGIN;
-- Refuse ambiguous existing identities before changing any data.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "EmailIdentity" GROUP BY lower("canonical" COLLATE "C") HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'email canonical collision requires manual resolution';
  END IF;
END $$;
ALTER TABLE "EmailRegistration" DISABLE TRIGGER "EmailRegistration_lifecycle";
CREATE OR REPLACE FUNCTION valid_login_email(display TEXT, canonical TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT octet_length(display) BETWEEN 3 AND 254
    AND octet_length(split_part(display, '@', 1)) BETWEEN 1 AND 64
    AND display COLLATE "C" ~ '^([A-Za-z0-9_''+-]+\.)*[A-Za-z0-9_''+-]*[A-Za-z0-9_+-]@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$'
    AND NOT EXISTS (
      SELECT 1 FROM unnest(string_to_array(split_part(display, '@', 2), '.')) label
      WHERE octet_length(label) > 63
    )
    AND canonical COLLATE "C" = lower(display COLLATE "C") COLLATE "C";
$$;

UPDATE "EmailIdentity" SET "canonical" = lower("canonical" COLLATE "C");
UPDATE "EmailRegistration" SET "canonical" = lower("canonical" COLLATE "C");
ALTER TABLE "EmailRegistration" ENABLE TRIGGER "EmailRegistration_lifecycle";
COMMIT;
