ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "sliders" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "payment_transactions" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "payment_webhook_logs" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "orders_tenantId_idx" ON "orders"("tenantId");
CREATE INDEX IF NOT EXISTS "sliders_tenantId_isActive_idx" ON "sliders"("tenantId", "isActive");
CREATE INDEX IF NOT EXISTS "payment_transactions_tenantId_idx" ON "payment_transactions"("tenantId");
CREATE INDEX IF NOT EXISTS "payment_webhook_logs_tenantId_idx" ON "payment_webhook_logs"("tenantId");
CREATE INDEX IF NOT EXISTS "tickets_tenantId_idx" ON "tickets"("tenantId");

WITH default_tenant AS (
  SELECT id FROM "tenant_brands" WHERE "isDefault" = true ORDER BY "createdAt" ASC LIMIT 1
)
UPDATE "orders" SET "tenantId" = (SELECT id FROM default_tenant) WHERE "tenantId" IS NULL;

UPDATE "payment_transactions" pt
SET "tenantId" = o."tenantId"
FROM "orders" o
WHERE pt."orderId" = o.id AND pt."tenantId" IS NULL;

WITH default_tenant AS (
  SELECT id FROM "tenant_brands" WHERE "isDefault" = true ORDER BY "createdAt" ASC LIMIT 1
)
UPDATE "payment_transactions" SET "tenantId" = (SELECT id FROM default_tenant) WHERE "tenantId" IS NULL;

UPDATE "payment_webhook_logs" wl
SET "tenantId" = o."tenantId"
FROM "orders" o
WHERE wl."orderId" = o.id AND wl."tenantId" IS NULL;
