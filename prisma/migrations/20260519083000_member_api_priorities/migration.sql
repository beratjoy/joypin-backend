-- Member-type scoped provider routing rules.
CREATE TABLE "member_api_priorities" (
    "id" TEXT NOT NULL,
    "memberTypeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "botProviderId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_api_priorities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "member_api_priorities_memberTypeId_productId_botProviderId_key"
ON "member_api_priorities"("memberTypeId", "productId", "botProviderId");

CREATE INDEX "member_api_priorities_productId_priority_idx"
ON "member_api_priorities"("productId", "priority");

CREATE INDEX "dealer_api_priorities_productId_priority_idx"
ON "dealer_api_priorities"("productId", "priority");

ALTER TABLE "member_api_priorities"
ADD CONSTRAINT "member_api_priorities_memberTypeId_fkey"
FOREIGN KEY ("memberTypeId") REFERENCES "member_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "member_api_priorities"
ADD CONSTRAINT "member_api_priorities_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "member_api_priorities"
ADD CONSTRAINT "member_api_priorities_botProviderId_fkey"
FOREIGN KEY ("botProviderId") REFERENCES "bot_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
