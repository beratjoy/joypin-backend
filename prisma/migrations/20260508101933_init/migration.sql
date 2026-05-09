-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('EPIN', 'TOPUP');

-- CreateEnum
CREATE TYPE "LootBoxRewardType" AS ENUM ('POINT', 'BALANCE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AffiliateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "EmailType" AS ENUM ('WELCOME', 'EMAIL_VERIFICATION', 'ORDER_CONFIRMATION', 'ORDER_DELIVERY', 'GUEST_ORDER_INFO', 'PASSWORD_RESET', 'ACCOUNT_DELETION', 'ABANDONED_CART_1H', 'ABANDONED_CART_24H', 'RE_ENGAGEMENT', 'CAMPAIGN', 'BALANCE_LOADED', 'REFERRAL_EARNED');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'BOUNCED', 'FAILED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignTargetType" AS ENUM ('ALL_USERS', 'ACTIVE_USERS', 'INACTIVE_USERS', 'VIP_MEMBERS', 'DEALERS', 'NEW_USERS', 'CUSTOM_SEGMENT');

-- CreateEnum
CREATE TYPE "MissionType" AS ENUM ('REFERRAL_COUNT', 'TOTAL_TURNOVER', 'TOTAL_PROFIT', 'SOCIAL_SHARE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "MissionRewardType" AS ENUM ('CASH_BALANCE', 'POINTS', 'VIP_MEMBERSHIP');

-- CreateEnum
CREATE TYPE "UnlockRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SubOrderStatus" ADD VALUE 'PENDING_STOCK';
ALTER TYPE "SubOrderStatus" ADD VALUE 'PENDING_TOPUP';
ALTER TYPE "SubOrderStatus" ADD VALUE 'MANUAL_INTERVENTION_REQUIRED';

-- AlterTable
ALTER TABLE "blog_posts" ADD COLUMN     "imageUrl" VARCHAR(500),
ADD COLUMN     "isPublished" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "source" VARCHAR(50);

-- AlterTable
ALTER TABLE "bot_providers" ADD COLUMN     "balance" DECIMAL(14,4) NOT NULL DEFAULT 0,
ADD COLUMN     "balanceCurrency" "Currency" NOT NULL DEFAULT 'USD',
ADD COLUMN     "lastBalanceSync" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "pointPrice" INTEGER,
ADD COLUMN     "type" "ProductType" NOT NULL DEFAULT 'EPIN';

-- AlterTable
ALTER TABLE "sub_orders" ADD COLUMN     "topupFieldData" JSONB;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "memberTypeId" TEXT,
ADD COLUMN     "pointsBalance" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "member_types" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "colorCode" VARCHAR(9) NOT NULL DEFAULT '#6366f1',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "defaultDiscountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_prices" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "memberTypeId" TEXT NOT NULL,
    "price" DECIMAL(12,4) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'TRY',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topup_fields" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fieldKey" VARCHAR(50) NOT NULL,
    "fieldLabel" VARCHAR(100) NOT NULL,
    "fieldType" VARCHAR(20) NOT NULL DEFAULT 'text',
    "placeholder" VARCHAR(200),
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "options" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topup_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "epin_stocks" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "isUsed" BOOLEAN NOT NULL DEFAULT false,
    "orderId" VARCHAR(100),
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "epin_stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_providers" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerProductCode" VARCHAR(200),
    "costPrice" DECIMAL(12,4) NOT NULL,
    "costCurrency" "Currency" NOT NULL DEFAULT 'USD',
    "priority" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_translations" (
    "id" TEXT NOT NULL,
    "blogPostId" TEXT NOT NULL,
    "languageCode" VARCHAR(10) NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "content" TEXT NOT NULL,
    "excerpt" VARCHAR(500),
    "seoTitle" VARCHAR(200),
    "seoDescription" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blog_translations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_settings" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "value" TEXT NOT NULL,
    "group" VARCHAR(50) NOT NULL DEFAULT 'general',
    "description" VARCHAR(255),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "site_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loot_boxes" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "imageUrl" VARCHAR(500),
    "price" DECIMAL(12,4) NOT NULL,
    "isPointPrice" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loot_boxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loot_box_rewards" (
    "id" TEXT NOT NULL,
    "boxId" TEXT NOT NULL,
    "rewardType" "LootBoxRewardType" NOT NULL,
    "rewardValue" DECIMAL(12,4) NOT NULL,
    "rewardLabel" VARCHAR(100),
    "dropChancePercentage" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loot_box_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loot_box_opens" (
    "id" TEXT NOT NULL,
    "boxId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rewardType" "LootBoxRewardType" NOT NULL,
    "rewardValue" DECIMAL(12,4) NOT NULL,
    "rewardLabel" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loot_box_opens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_coupons" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "isUsed" BOOLEAN NOT NULL DEFAULT false,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "assignedReason" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abandoned_cart_logs" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT,
    "email" VARCHAR(255) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "couponCode" VARCHAR(50),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abandoned_cart_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_plans" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "price" DECIMAL(12,4) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'TRY',
    "durationDays" INTEGER NOT NULL,
    "targetMemberTypeId" TEXT NOT NULL,
    "bonusPoints" INTEGER NOT NULL DEFAULT 0,
    "features" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_prices" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "price" DECIMAL(12,4) NOT NULL,
    "country" VARCHAR(5),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "paymentRef" VARCHAR(200),
    "paidAmount" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "previousMemberTypeId" VARCHAR(100),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_tiers" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "commissionPercent" DECIMAL(5,2) NOT NULL,
    "minWithdrawAmount" DECIMAL(12,4) NOT NULL DEFAULT 50,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_transactions" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "referrerUserId" TEXT NOT NULL,
    "orderAmount" DECIMAL(12,4) NOT NULL,
    "commissionRate" DECIMAL(5,2) NOT NULL,
    "commissionAmount" DECIMAL(12,4) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'TRY',
    "status" "AffiliateStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "paidToWallet" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_templates" (
    "id" TEXT NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "subject" VARCHAR(500) NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "description" VARCHAR(500),
    "emailType" "EmailType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "languageCode" VARCHAR(10) NOT NULL DEFAULT 'tr',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_campaigns" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "description" TEXT,
    "subject" VARCHAR(500) NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "previewText" VARCHAR(200),
    "targetType" "CampaignTargetType" NOT NULL DEFAULT 'ALL_USERS',
    "targetFilter" JSONB,
    "targetCount" INTEGER,
    "scheduledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "totalSent" INTEGER NOT NULL DEFAULT 0,
    "totalOpened" INTEGER NOT NULL DEFAULT 0,
    "totalClicked" INTEGER NOT NULL DEFAULT 0,
    "totalBounced" INTEGER NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" VARCHAR(255) NOT NULL,
    "emailType" "EmailType" NOT NULL,
    "subject" VARCHAR(500) NOT NULL,
    "templateSlug" VARCHAR(100),
    "campaignId" TEXT,
    "status" "EmailStatus" NOT NULL DEFAULT 'QUEUED',
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "clickedAt" TIMESTAMP(3),
    "trackingId" TEXT NOT NULL,
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "bounceType" VARCHAR(50),
    "orderId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abandoned_carts" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" VARCHAR(255),
    "itemsJson" JSONB NOT NULL,
    "totalAmount" DECIMAL(14,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'TRY',
    "reminder1SentAt" TIMESTAMP(3),
    "reminder2SentAt" TIMESTAMP(3),
    "couponCode" VARCHAR(50),
    "recoveredAt" TIMESTAMP(3),
    "recoveredOrderId" VARCHAR(100),
    "recoveredAmount" DECIMAL(14,4),
    "isRecovered" BOOLEAN NOT NULL DEFAULT false,
    "isExpired" BOOLEAN NOT NULL DEFAULT false,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abandoned_carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_pools" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_pool_products" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_pool_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "epin_codes" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "codeHash" VARCHAR(64),
    "addedByUserId" TEXT,
    "costPrice" DECIMAL(12,4) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'USD',
    "supplier" VARCHAR(200) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "allowResellers" BOOLEAN NOT NULL DEFAULT true,
    "isUsed" BOOLEAN NOT NULL DEFAULT false,
    "usedAt" TIMESTAMP(3),
    "usedByUserId" TEXT,
    "orderId" VARCHAR(100),
    "subOrderId" VARCHAR(100),
    "expiresAt" TIMESTAMP(3),
    "batchId" VARCHAR(100),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "epin_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "missions" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "imageUrl" VARCHAR(500),
    "type" "MissionType" NOT NULL,
    "targetValue" DECIMAL(14,4) NOT NULL,
    "rewardType" "MissionRewardType" NOT NULL,
    "rewardAmount" DECIMAL(12,4) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "minTier" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "missions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_mission_progress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "currentValue" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "rewardClaimed" BOOLEAN NOT NULL DEFAULT false,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_mission_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_roles" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "displayName" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "color" VARCHAR(9) NOT NULL DEFAULT '#6366f1',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "canDecryptWithoutApproval" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_role_permissions" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "staff_role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "department" VARCHAR(100),
    "phone" VARCHAR(20),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastActiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "epin_unlock_requests" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "epinCodeId" TEXT NOT NULL,
    "status" "UnlockRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "ipAddress" VARCHAR(45),
    "userAgent" VARCHAR(500),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "epin_unlock_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "member_types_name_key" ON "member_types"("name");

-- CreateIndex
CREATE INDEX "product_prices_memberTypeId_idx" ON "product_prices"("memberTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "product_prices_productId_memberTypeId_key" ON "product_prices"("productId", "memberTypeId");

-- CreateIndex
CREATE INDEX "topup_fields_productId_idx" ON "topup_fields"("productId");

-- CreateIndex
CREATE INDEX "epin_stocks_productId_isUsed_idx" ON "epin_stocks"("productId", "isUsed");

-- CreateIndex
CREATE INDEX "epin_stocks_orderId_idx" ON "epin_stocks"("orderId");

-- CreateIndex
CREATE INDEX "product_providers_productId_priority_idx" ON "product_providers"("productId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "product_providers_productId_providerId_key" ON "product_providers"("productId", "providerId");

-- CreateIndex
CREATE INDEX "blog_translations_languageCode_idx" ON "blog_translations"("languageCode");

-- CreateIndex
CREATE UNIQUE INDEX "blog_translations_blogPostId_languageCode_key" ON "blog_translations"("blogPostId", "languageCode");

-- CreateIndex
CREATE UNIQUE INDEX "site_settings_key_key" ON "site_settings"("key");

-- CreateIndex
CREATE INDEX "site_settings_group_idx" ON "site_settings"("group");

-- CreateIndex
CREATE INDEX "loot_box_rewards_boxId_idx" ON "loot_box_rewards"("boxId");

-- CreateIndex
CREATE INDEX "loot_box_opens_userId_idx" ON "loot_box_opens"("userId");

-- CreateIndex
CREATE INDEX "loot_box_opens_boxId_idx" ON "loot_box_opens"("boxId");

-- CreateIndex
CREATE INDEX "user_coupons_userId_isUsed_idx" ON "user_coupons"("userId", "isUsed");

-- CreateIndex
CREATE UNIQUE INDEX "user_coupons_userId_couponId_key" ON "user_coupons"("userId", "couponId");

-- CreateIndex
CREATE INDEX "abandoned_cart_logs_status_idx" ON "abandoned_cart_logs"("status");

-- CreateIndex
CREATE INDEX "abandoned_cart_logs_orderId_idx" ON "abandoned_cart_logs"("orderId");

-- CreateIndex
CREATE INDEX "subscription_prices_currency_idx" ON "subscription_prices"("currency");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_prices_planId_currency_key" ON "subscription_prices"("planId", "currency");

-- CreateIndex
CREATE INDEX "user_subscriptions_userId_status_idx" ON "user_subscriptions"("userId", "status");

-- CreateIndex
CREATE INDEX "user_subscriptions_endDate_status_idx" ON "user_subscriptions"("endDate", "status");

-- CreateIndex
CREATE INDEX "affiliate_transactions_referrerUserId_status_idx" ON "affiliate_transactions"("referrerUserId", "status");

-- CreateIndex
CREATE INDEX "affiliate_transactions_orderId_idx" ON "affiliate_transactions"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "email_templates_slug_key" ON "email_templates"("slug");

-- CreateIndex
CREATE INDEX "email_templates_emailType_isActive_idx" ON "email_templates"("emailType", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "email_templates_slug_languageCode_key" ON "email_templates"("slug", "languageCode");

-- CreateIndex
CREATE INDEX "email_campaigns_status_idx" ON "email_campaigns"("status");

-- CreateIndex
CREATE INDEX "email_campaigns_scheduledAt_idx" ON "email_campaigns"("scheduledAt");

-- CreateIndex
CREATE INDEX "email_campaigns_createdById_idx" ON "email_campaigns"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "email_logs_trackingId_key" ON "email_logs"("trackingId");

-- CreateIndex
CREATE INDEX "email_logs_userId_idx" ON "email_logs"("userId");

-- CreateIndex
CREATE INDEX "email_logs_emailType_idx" ON "email_logs"("emailType");

-- CreateIndex
CREATE INDEX "email_logs_status_idx" ON "email_logs"("status");

-- CreateIndex
CREATE INDEX "email_logs_campaignId_idx" ON "email_logs"("campaignId");

-- CreateIndex
CREATE INDEX "email_logs_trackingId_idx" ON "email_logs"("trackingId");

-- CreateIndex
CREATE INDEX "email_logs_createdAt_idx" ON "email_logs"("createdAt");

-- CreateIndex
CREATE INDEX "abandoned_carts_userId_idx" ON "abandoned_carts"("userId");

-- CreateIndex
CREATE INDEX "abandoned_carts_email_idx" ON "abandoned_carts"("email");

-- CreateIndex
CREATE INDEX "abandoned_carts_isRecovered_idx" ON "abandoned_carts"("isRecovered");

-- CreateIndex
CREATE INDEX "abandoned_carts_lastActivityAt_idx" ON "abandoned_carts"("lastActivityAt");

-- CreateIndex
CREATE INDEX "abandoned_carts_reminder1SentAt_idx" ON "abandoned_carts"("reminder1SentAt");

-- CreateIndex
CREATE INDEX "stock_pools_isActive_idx" ON "stock_pools"("isActive");

-- CreateIndex
CREATE INDEX "stock_pool_products_productId_idx" ON "stock_pool_products"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_pool_products_poolId_productId_key" ON "stock_pool_products"("poolId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "epin_codes_code_key" ON "epin_codes"("code");

-- CreateIndex
CREATE INDEX "epin_codes_poolId_isUsed_priority_createdAt_idx" ON "epin_codes"("poolId", "isUsed", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "epin_codes_poolId_isUsed_allowResellers_idx" ON "epin_codes"("poolId", "isUsed", "allowResellers");

-- CreateIndex
CREATE INDEX "epin_codes_orderId_idx" ON "epin_codes"("orderId");

-- CreateIndex
CREATE INDEX "epin_codes_usedByUserId_idx" ON "epin_codes"("usedByUserId");

-- CreateIndex
CREATE INDEX "epin_codes_batchId_idx" ON "epin_codes"("batchId");

-- CreateIndex
CREATE INDEX "epin_codes_supplier_idx" ON "epin_codes"("supplier");

-- CreateIndex
CREATE INDEX "user_mission_progress_userId_isCompleted_idx" ON "user_mission_progress"("userId", "isCompleted");

-- CreateIndex
CREATE UNIQUE INDEX "user_mission_progress_userId_missionId_key" ON "user_mission_progress"("userId", "missionId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_roles_name_key" ON "staff_roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "staff_role_permissions_roleId_permissionId_key" ON "staff_role_permissions"("roleId", "permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_userId_key" ON "staff_profiles"("userId");

-- CreateIndex
CREATE INDEX "staff_profiles_roleId_idx" ON "staff_profiles"("roleId");

-- CreateIndex
CREATE INDEX "staff_profiles_isActive_idx" ON "staff_profiles"("isActive");

-- CreateIndex
CREATE INDEX "epin_unlock_requests_staffId_status_idx" ON "epin_unlock_requests"("staffId", "status");

-- CreateIndex
CREATE INDEX "epin_unlock_requests_status_createdAt_idx" ON "epin_unlock_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "epin_unlock_requests_epinCodeId_idx" ON "epin_unlock_requests"("epinCodeId");

-- CreateIndex
CREATE INDEX "users_memberTypeId_idx" ON "users"("memberTypeId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_memberTypeId_fkey" FOREIGN KEY ("memberTypeId") REFERENCES "member_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_memberTypeId_fkey" FOREIGN KEY ("memberTypeId") REFERENCES "member_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topup_fields" ADD CONSTRAINT "topup_fields_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "epin_stocks" ADD CONSTRAINT "epin_stocks_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_providers" ADD CONSTRAINT "product_providers_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_providers" ADD CONSTRAINT "product_providers_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "bot_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_translations" ADD CONSTRAINT "blog_translations_blogPostId_fkey" FOREIGN KEY ("blogPostId") REFERENCES "blog_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loot_box_rewards" ADD CONSTRAINT "loot_box_rewards_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "loot_boxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loot_box_opens" ADD CONSTRAINT "loot_box_opens_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "loot_boxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loot_box_opens" ADD CONSTRAINT "loot_box_opens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_coupons" ADD CONSTRAINT "user_coupons_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_coupons" ADD CONSTRAINT "user_coupons_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "discount_coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_targetMemberTypeId_fkey" FOREIGN KEY ("targetMemberTypeId") REFERENCES "member_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_prices" ADD CONSTRAINT "subscription_prices_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_transactions" ADD CONSTRAINT "affiliate_transactions_referrerUserId_fkey" FOREIGN KEY ("referrerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "email_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_pool_products" ADD CONSTRAINT "stock_pool_products_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "stock_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_pool_products" ADD CONSTRAINT "stock_pool_products_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "epin_codes" ADD CONSTRAINT "epin_codes_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "stock_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "epin_codes" ADD CONSTRAINT "epin_codes_usedByUserId_fkey" FOREIGN KEY ("usedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_mission_progress" ADD CONSTRAINT "user_mission_progress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_mission_progress" ADD CONSTRAINT "user_mission_progress_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_role_permissions" ADD CONSTRAINT "staff_role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "staff_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_role_permissions" ADD CONSTRAINT "staff_role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "staff_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "epin_unlock_requests" ADD CONSTRAINT "epin_unlock_requests_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
