-- Multi-domain brand/tenant foundation
CREATE TABLE IF NOT EXISTS "tenant_brands" (
  "id" TEXT NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "slug" VARCHAR(120) NOT NULL,
  "publicName" VARCHAR(160) NOT NULL,
  "defaultLocale" VARCHAR(10) NOT NULL DEFAULT 'tr',
  "defaultCountry" VARCHAR(10) NOT NULL DEFAULT 'TR',
  "defaultCurrency" "Currency" NOT NULL DEFAULT 'TRY',
  "primaryColor" VARCHAR(20) NOT NULL DEFAULT '#6366f1',
  "accentColor" VARCHAR(20) NOT NULL DEFAULT '#22c55e',
  "logoUrl" VARCHAR(500),
  "faviconUrl" VARCHAR(500),
  "cdnPublicUrl" VARCHAR(500),
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenant_brands_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "tenant_domains" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "hostname" VARCHAR(255) NOT NULL,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "notes" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenant_domains_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "tenant_settings" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "key" VARCHAR(100) NOT NULL,
  "value" TEXT NOT NULL,
  "group" VARCHAR(50) NOT NULL DEFAULT 'general',
  "description" VARCHAR(255),
  "updatedBy" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_brands_slug_key" ON "tenant_brands"("slug");
CREATE INDEX IF NOT EXISTS "tenant_brands_isDefault_idx" ON "tenant_brands"("isDefault");
CREATE INDEX IF NOT EXISTS "tenant_brands_isActive_idx" ON "tenant_brands"("isActive");
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_domains_hostname_key" ON "tenant_domains"("hostname");
CREATE INDEX IF NOT EXISTS "tenant_domains_tenantId_idx" ON "tenant_domains"("tenantId");
CREATE INDEX IF NOT EXISTS "tenant_domains_hostname_isActive_idx" ON "tenant_domains"("hostname", "isActive");
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_settings_tenantId_key_key" ON "tenant_settings"("tenantId", "key");
CREATE INDEX IF NOT EXISTS "tenant_settings_tenantId_group_idx" ON "tenant_settings"("tenantId", "group");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_domains_tenantId_fkey') THEN
    ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant_brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_settings_tenantId_fkey') THEN
    ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant_brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

INSERT INTO "tenant_brands" ("id", "name", "slug", "publicName", "defaultLocale", "defaultCountry", "defaultCurrency", "primaryColor", "accentColor", "logoUrl", "faviconUrl", "cdnPublicUrl", "isDefault", "isActive", "metadata")
VALUES (gen_random_uuid()::text, 'Epin365', 'epin365', 'Epin365', 'tr', 'TR', 'TRY', '#6366f1', '#22c55e', NULL, NULL, 'https://cdn.epin365.com', true, true, '{}'::jsonb)
ON CONFLICT ("slug") DO UPDATE SET
  "publicName" = EXCLUDED."publicName",
  "cdnPublicUrl" = COALESCE("tenant_brands"."cdnPublicUrl", EXCLUDED."cdnPublicUrl"),
  "isDefault" = true,
  "isActive" = true,
  "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "tenant_domains" ("id", "tenantId", "hostname", "isPrimary", "isActive")
SELECT gen_random_uuid()::text, id, 'epin365.com', true, true FROM "tenant_brands" WHERE slug = 'epin365'
ON CONFLICT ("hostname") DO UPDATE SET "tenantId" = EXCLUDED."tenantId", "isPrimary" = true, "isActive" = true, "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "tenant_domains" ("id", "tenantId", "hostname", "isPrimary", "isActive")
SELECT gen_random_uuid()::text, id, 'www.epin365.com', false, true FROM "tenant_brands" WHERE slug = 'epin365'
ON CONFLICT ("hostname") DO UPDATE SET "tenantId" = EXCLUDED."tenantId", "isPrimary" = false, "isActive" = true, "updatedAt" = CURRENT_TIMESTAMP;
