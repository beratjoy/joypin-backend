ALTER TABLE "product_categories"
  ALTER COLUMN "badges" DROP DEFAULT,
  ALTER COLUMN "badges" TYPE JSONB USING COALESCE(to_jsonb("badges"), '[]'::jsonb),
  ALTER COLUMN "badges" SET DEFAULT '[]'::jsonb;

ALTER TABLE "product_categories"
  ALTER COLUMN "paymentMethods" DROP DEFAULT,
  ALTER COLUMN "paymentMethods" TYPE JSONB USING COALESCE(to_jsonb("paymentMethods"), '[]'::jsonb),
  ALTER COLUMN "paymentMethods" SET DEFAULT '[]'::jsonb;
