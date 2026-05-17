ALTER TABLE "bot_providers" ADD COLUMN IF NOT EXISTS "tenantIds" JSONB;
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "discount_coupons" ADD COLUMN IF NOT EXISTS "tenantIds" JSONB;
ALTER TABLE "blog_posts" ADD COLUMN IF NOT EXISTS "tenantIds" JSONB;
ALTER TABLE "loot_boxes" ADD COLUMN IF NOT EXISTS "tenantIds" JSONB;
ALTER TABLE "email_templates" ADD COLUMN IF NOT EXISTS "tenantIds" JSONB;
ALTER TABLE "email_campaigns" ADD COLUMN IF NOT EXISTS "tenantIds" JSONB;
ALTER TABLE "email_logs" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "missions" ADD COLUMN IF NOT EXISTS "tenantIds" JSONB;

CREATE INDEX IF NOT EXISTS "audit_logs_tenantId_createdAt_idx" ON "audit_logs"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "email_logs_tenantId_createdAt_idx" ON "email_logs"("tenantId", "createdAt");
