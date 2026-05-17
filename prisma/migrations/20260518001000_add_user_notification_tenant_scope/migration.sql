ALTER TABLE "user_notifications" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

UPDATE "user_notifications" un
SET "tenantId" = o."tenantId"
FROM "orders" o
WHERE un."relatedEntityType" = 'order'
  AND un."relatedEntityId" = o.id
  AND un."tenantId" IS NULL
  AND o."tenantId" IS NOT NULL;

UPDATE "user_notifications" un
SET "tenantId" = pt."tenantId"
FROM "payment_transactions" pt
WHERE un."relatedEntityType" = 'payment'
  AND un."relatedEntityId" = pt.id
  AND un."tenantId" IS NULL
  AND pt."tenantId" IS NOT NULL;

UPDATE "user_notifications" un
SET "tenantId" = wr."tenantId"
FROM "withdrawal_requests" wr
WHERE un."relatedEntityType" = 'withdrawal'
  AND un."relatedEntityId" = wr.id
  AND un."tenantId" IS NULL
  AND wr."tenantId" IS NOT NULL;

UPDATE "user_notifications" un
SET "tenantId" = t."tenantId"
FROM "tickets" t
WHERE un."relatedEntityType" = 'ticket'
  AND un."relatedEntityId" = t.id
  AND un."tenantId" IS NULL
  AND t."tenantId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "user_notifications_tenantId_createdAt_idx" ON "user_notifications"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "user_notifications_userId_tenantId_isRead_idx" ON "user_notifications"("userId", "tenantId", "isRead");
