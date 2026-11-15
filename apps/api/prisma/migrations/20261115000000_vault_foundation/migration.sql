-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Account" (
    "id" VARCHAR(128) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordCredential" (
    "accountId" VARCHAR(128) NOT NULL,
    "verifier" TEXT NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "PasswordCredential_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "VaultState" (
    "accountId" VARCHAR(128) NOT NULL,
    "vaultId" VARCHAR(22) NOT NULL,
    "storageRevision" BIGINT NOT NULL,
    "activePublicationId" UUID NOT NULL,

    CONSTRAINT "VaultState_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "VaultPublication" (
    "id" UUID NOT NULL,
    "accountId" VARCHAR(128) NOT NULL,
    "vaultId" VARCHAR(22) NOT NULL,
    "cryptographicFormatVersion" INTEGER NOT NULL,
    "generation" BIGINT NOT NULL,
    "contentRevision" BIGINT NOT NULL,
    "passwordRevision" BIGINT NOT NULL,
    "recoveryRevision" BIGINT NOT NULL,
    "envelopeCredentialRevision" BIGINT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "digest" BYTEA NOT NULL,

    CONSTRAINT "VaultPublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultOperation" (
    "accountId" VARCHAR(128) NOT NULL,
    "operationId" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "expectedStorageRevision" BIGINT,
    "expectedCredentialRevision" BIGINT NOT NULL,
    "fingerprintKeyId" VARCHAR(128) NOT NULL,
    "fingerprint" BYTEA NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "resultStorageRevision" BIGINT,
    "resultCredentialRevision" BIGINT,
    "publicationDigest" BYTEA,
    "rejectionCode" VARCHAR(32),

    CONSTRAINT "VaultOperation_pkey" PRIMARY KEY ("accountId","operationId")
);

-- CreateIndex
CREATE UNIQUE INDEX "VaultState_accountId_vaultId_key" ON "VaultState"("accountId", "vaultId");

-- CreateIndex
CREATE UNIQUE INDEX "VaultPublication_accountId_vaultId_id_key" ON "VaultPublication"("accountId", "vaultId", "id");

-- AddForeignKey
ALTER TABLE "PasswordCredential" ADD CONSTRAINT "PasswordCredential_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "VaultState" ADD CONSTRAINT "VaultState_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "VaultState" ADD CONSTRAINT "VaultState_accountId_vaultId_activePublicationId_fkey" FOREIGN KEY ("accountId", "vaultId", "activePublicationId") REFERENCES "VaultPublication"("accountId", "vaultId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "VaultPublication" ADD CONSTRAINT "VaultPublication_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "VaultOperation" ADD CONSTRAINT "VaultOperation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- PostgreSQL constraints not expressible in the Prisma schema.
ALTER TABLE "Account" ADD CONSTRAINT "Account_id_format" CHECK ("id" ~ '^[!-~]{1,128}$');
ALTER TABLE "PasswordCredential" ADD CONSTRAINT "PasswordCredential_revision_positive" CHECK ("revision" > 0);
ALTER TABLE "VaultState" ADD CONSTRAINT "VaultState_revision_positive" CHECK ("storageRevision" > 0);
ALTER TABLE "VaultState" ADD CONSTRAINT "VaultState_vaultId_format" CHECK ("vaultId" ~ '^[A-Za-z0-9_-]{21}[AQgw]$');
ALTER TABLE "VaultPublication" ADD CONSTRAINT "VaultPublication_values" CHECK (
  "vaultId" ~ '^[A-Za-z0-9_-]{21}[AQgw]$' AND "cryptographicFormatVersion" = 1
  AND "generation" BETWEEN 1 AND 9007199254740991
  AND "contentRevision" BETWEEN 1 AND 9007199254740991
  AND "passwordRevision" BETWEEN 1 AND 9007199254740991
  AND "recoveryRevision" BETWEEN 1 AND 9007199254740991
  AND "envelopeCredentialRevision" > 0
  AND octet_length("bytes") BETWEEN 1 AND 131072 AND octet_length("digest") = 32
);
ALTER TABLE "VaultOperation" ADD CONSTRAINT "VaultOperation_values" CHECK (
  "expectedCredentialRevision" > 0
  AND ("expectedStorageRevision" IS NULL OR "expectedStorageRevision" > 0)
  AND (("kind" = 'initial-publication' AND "expectedStorageRevision" IS NULL)
    OR ("kind" = 'ordinary-password-change' AND "expectedStorageRevision" IS NOT NULL))
  AND length("fingerprintKeyId") > 0 AND octet_length("fingerprint") = 32
  AND (("status" = 'COMMITTED' AND "resultStorageRevision" IS NOT NULL AND "resultStorageRevision" > 0
        AND "resultCredentialRevision" IS NOT NULL AND "resultCredentialRevision" > 0
        AND "publicationDigest" IS NOT NULL AND octet_length("publicationDigest") = 32 AND "rejectionCode" IS NULL)
    OR ("status" = 'REJECTED' AND "resultStorageRevision" IS NULL AND "resultCredentialRevision" IS NULL
        AND "publicationDigest" IS NULL AND "rejectionCode" IS NOT NULL
        AND "rejectionCode" IN ('INVALID_INPUT', 'INVALID_PUBLICATION', 'ALREADY_EXISTS', 'VERSION_CONFLICT', 'INVALID_TRANSITION', 'IDEMPOTENCY_MISMATCH')))
);

-- Revocation is individual; these records do not confer authorization.
CREATE TABLE "Device" (
  "id" UUID NOT NULL,
  "accountId" VARCHAR(128) NOT NULL,
  "revokedAt" TIMESTAMPTZ(3),
  CONSTRAINT "Device_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Device_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "Device_accountId_id_key" ON "Device"("accountId", "id");
CREATE TABLE "Session" (
  "id" UUID NOT NULL,
  "accountId" VARCHAR(128) NOT NULL,
  "deviceId" UUID NOT NULL,
  "revokedAt" TIMESTAMPTZ(3),
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Session_accountId_deviceId_fkey" FOREIGN KEY ("accountId", "deviceId") REFERENCES "Device"("accountId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
