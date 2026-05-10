ALTER TABLE "product_categories" ADD COLUMN IF NOT EXISTS "layout" VARCHAR(50) NOT NULL DEFAULT 'jollymax';
ALTER TABLE "product_categories" ADD COLUMN IF NOT EXISTS "badges" JSONB;
ALTER TABLE "product_categories" ADD COLUMN IF NOT EXISTS "paymentMethods" JSONB;
ALTER TABLE "product_categories" ADD COLUMN IF NOT EXISTS "requiresUserId" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "product_categories" ADD COLUMN IF NOT EXISTS "userIdLabel" VARCHAR(100);
ALTER TABLE "product_categories" ADD COLUMN IF NOT EXISTS "userIdPlaceholder" VARCHAR(200);
ALTER TABLE "product_categories" ADD COLUMN IF NOT EXISTS "zoneIdLabel" VARCHAR(100);
