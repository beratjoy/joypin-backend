ALTER TABLE "wallet_transactions" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

UPDATE "wallet_transactions" wt
SET "tenantId" = o."tenantId"
FROM "orders" o
WHERE wt."orderId" = o.id
  AND wt."tenantId" IS NULL
  AND o."tenantId" IS NOT NULL;

UPDATE "wallet_transactions" wt
SET "tenantId" = pt."tenantId"
FROM "payment_transactions" pt
WHERE pt."walletTxId" = wt.id
  AND wt."tenantId" IS NULL
  AND pt."tenantId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "wallet_transactions_tenantId_createdAt_idx" ON "wallet_transactions"("tenantId", "createdAt");
