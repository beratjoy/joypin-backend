CREATE TABLE "dealer_api_keys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL DEFAULT 'Varsayilan API Anahtari',
    "prefix" VARCHAR(24) NOT NULL,
    "keyHash" VARCHAR(64) NOT NULL,
    "keyLast4" VARCHAR(4) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dealer_api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dealer_api_keys_keyHash_key" ON "dealer_api_keys"("keyHash");
CREATE INDEX "dealer_api_keys_userId_isActive_idx" ON "dealer_api_keys"("userId", "isActive");

ALTER TABLE "dealer_api_keys"
ADD CONSTRAINT "dealer_api_keys_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
