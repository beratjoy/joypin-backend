ALTER TABLE "dealer_groups"
ADD COLUMN IF NOT EXISTS "allowCryptoDeposit" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "dealer_billing_profiles" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "customerType" "CustomerType" NOT NULL DEFAULT 'INDIVIDUAL',
  "invoiceType" "InvoiceType" NOT NULL DEFAULT 'DEFAULT',
  "companyName" VARCHAR(200),
  "taxId" VARCHAR(50),
  "taxOffice" VARCHAR(120),
  "identityNumber" VARCHAR(20),
  "address" TEXT,
  "city" VARCHAR(100),
  "state" VARCHAR(100),
  "country" VARCHAR(50) NOT NULL DEFAULT 'TR',
  "postalCode" VARCHAR(20),
  "email" VARCHAR(255),
  "phone" VARCHAR(30),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dealer_billing_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "dealer_billing_profiles_userId_key"
ON "dealer_billing_profiles"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dealer_billing_profiles_userId_fkey'
  ) THEN
    ALTER TABLE "dealer_billing_profiles"
    ADD CONSTRAINT "dealer_billing_profiles_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
