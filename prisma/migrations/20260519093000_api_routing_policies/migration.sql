-- Product/group scoped API routing reject behavior.
CREATE TABLE "product_api_routing_policies" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "onRejectAction" VARCHAR(30) NOT NULL DEFAULT 'FALLBACK',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_api_routing_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "dealer_api_routing_policies" (
    "id" TEXT NOT NULL,
    "dealerGroupId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "onRejectAction" VARCHAR(30) NOT NULL DEFAULT 'FALLBACK',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dealer_api_routing_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "member_api_routing_policies" (
    "id" TEXT NOT NULL,
    "memberTypeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "onRejectAction" VARCHAR(30) NOT NULL DEFAULT 'FALLBACK',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_api_routing_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_api_routing_policies_productId_key"
ON "product_api_routing_policies"("productId");

CREATE UNIQUE INDEX "dealer_api_routing_policies_dealerGroupId_productId_key"
ON "dealer_api_routing_policies"("dealerGroupId", "productId");

CREATE INDEX "dealer_api_routing_policies_productId_idx"
ON "dealer_api_routing_policies"("productId");

CREATE UNIQUE INDEX "member_api_routing_policies_memberTypeId_productId_key"
ON "member_api_routing_policies"("memberTypeId", "productId");

CREATE INDEX "member_api_routing_policies_productId_idx"
ON "member_api_routing_policies"("productId");

ALTER TABLE "product_api_routing_policies"
ADD CONSTRAINT "product_api_routing_policies_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dealer_api_routing_policies"
ADD CONSTRAINT "dealer_api_routing_policies_dealerGroupId_fkey"
FOREIGN KEY ("dealerGroupId") REFERENCES "dealer_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dealer_api_routing_policies"
ADD CONSTRAINT "dealer_api_routing_policies_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "member_api_routing_policies"
ADD CONSTRAINT "member_api_routing_policies_memberTypeId_fkey"
FOREIGN KEY ("memberTypeId") REFERENCES "member_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "member_api_routing_policies"
ADD CONSTRAINT "member_api_routing_policies_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
