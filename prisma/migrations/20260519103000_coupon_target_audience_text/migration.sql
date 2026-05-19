ALTER TABLE "discount_coupons"
  ALTER COLUMN "targetAudience" TYPE VARCHAR(50)
  USING "targetAudience"::text;
