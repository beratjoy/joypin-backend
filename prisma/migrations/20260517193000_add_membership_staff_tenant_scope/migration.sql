ALTER TABLE "member_types" ADD COLUMN IF NOT EXISTS "tenantIds" JSONB;
ALTER TABLE "referral_rules" ADD COLUMN IF NOT EXISTS "tenantIds" JSONB;
ALTER TABLE "withdrawal_requests" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "tenantIds" JSONB;
ALTER TABLE "user_subscriptions" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "staff_profiles" ADD COLUMN IF NOT EXISTS "tenantIds" JSONB;

CREATE INDEX IF NOT EXISTS "withdrawal_requests_tenantId_createdAt_idx" ON "withdrawal_requests"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "user_subscriptions_tenantId_createdAt_idx" ON "user_subscriptions"("tenantId", "createdAt");
