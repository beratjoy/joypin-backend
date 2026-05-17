ALTER TABLE "product_categories" ADD COLUMN IF NOT EXISTS "tenantIds" JSONB;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "tenantIds" JSONB;
ALTER TABLE "payment_methods" ADD COLUMN IF NOT EXISTS "tenantIds" JSONB;
