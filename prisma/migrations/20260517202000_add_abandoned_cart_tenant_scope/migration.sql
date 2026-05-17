ALTER TABLE "abandoned_carts" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "abandoned_carts_tenantId_idx" ON "abandoned_carts"("tenantId");
