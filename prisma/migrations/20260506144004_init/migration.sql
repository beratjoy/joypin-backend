-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'STAFF', 'RESELLER', 'DEALER', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NOT_SUBMITTED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "KycDocumentType" AS ENUM ('IDENTITY_CARD', 'PASSPORT', 'DRIVING_LICENSE', 'TAX_CERTIFICATE', 'COMPANY_REGISTRATION', 'UTILITY_BILL', 'SELFIE_WITH_ID');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION');

-- CreateEnum
CREATE TYPE "PricingModel" AS ENUM ('COST_PLUS_MARGIN', 'FIXED_MINUS_DISCOUNT', 'FIXED_PRICE');

-- CreateEnum
CREATE TYPE "StockType" AS ENUM ('EPIN', 'API_TOPUP');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('USD', 'EUR', 'TRY', 'GBP', 'AED', 'SAR');

-- CreateEnum
CREATE TYPE "EPinStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'SOLD', 'EXPIRED', 'DEFECTIVE');

-- CreateEnum
CREATE TYPE "ParentOrderStatus" AS ENUM ('PENDING', 'PROCESSING', 'PARTIALLY_DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SubOrderStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'FAILED', 'AWAITING_FALLBACK');

-- CreateEnum
CREATE TYPE "DeliveryType" AS ENUM ('EPIN', 'API_TOPUP', 'MANUAL');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "WalletTxType" AS ENUM ('CREDIT', 'DEBIT', 'TRANSFER', 'FREEZE', 'UNFREEZE');

-- CreateEnum
CREATE TYPE "BalanceField" AS ENUM ('CURRENT', 'BONUS', 'WITHDRAWABLE', 'CREDIT', 'FROZEN', 'LOTTERY', 'CASHBACK', 'COMMISSION');

-- CreateEnum
CREATE TYPE "ReferralBasis" AS ENUM ('PROFIT', 'SALE_PRICE');

-- CreateEnum
CREATE TYPE "BotProviderType" AS ENUM ('API', 'BOT', 'MANUAL');

-- CreateEnum
CREATE TYPE "BotProviderStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'VIEW_EPIN', 'DECRYPT_EPIN', 'LOGIN', 'LOGOUT', 'ORDER_PLACED', 'ORDER_CANCELLED', 'ORDER_REFUNDED', 'SUBORDER_CANCELLED', 'SUBORDER_DELIVERED', 'SUBORDER_REFUNDED', 'BALANCE_UPDATED', 'REFERRAL_PAID', 'STAFF_CLAIM_ORDER', 'STAFF_RELEASE_ORDER', 'API_FALLBACK_TRIGGERED', 'GUEST_ORDER_CREATED', 'COUPON_APPLIED', 'INVOICE_ISSUED', 'SESSION_IMPERSONATED');

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('INDIVIDUAL', 'CORPORATE');

-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('DEFAULT', 'E_INVOICE', 'PDF_INTERNATIONAL');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'PENDING', 'ISSUED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReferralIncomeModel" AS ENUM ('PRODUCT_SALE', 'NEW_REGISTRATION');

-- CreateEnum
CREATE TYPE "ReferralModelType" AS ENUM ('REFERRAL_LINK', 'LIST_INCOME');

-- CreateEnum
CREATE TYPE "ReferralCalculation" AS ENUM ('SALE_PRICE', 'PROFIT_STOCK_COST', 'PROFIT_CURRENT_COST');

-- CreateEnum
CREATE TYPE "CouponType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');

-- CreateEnum
CREATE TYPE "CouponStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'DEPLETED', 'DISABLED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'SMS', 'PUSH');

-- CreateEnum
CREATE TYPE "FinancialLogType" AS ENUM ('SALE', 'PARTIAL_REFUND', 'FULL_REFUND', 'CANCELLATION', 'SERVICE_FEE', 'TAX', 'COMMISSION_REVERSAL');

-- CreateEnum
CREATE TYPE "PaymentGateway" AS ENUM ('STRIPE', 'MERCURY', 'BINANCE_PAY', 'CRYPTOMUS', 'BANK_TRANSFER', 'WALLET');

-- CreateEnum
CREATE TYPE "PaymentTransactionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "WithdrawalMethod" AS ENUM ('CRYPTO_USDT_TRC20', 'CRYPTO_USDT_ERC20', 'CRYPTO_BTC', 'BANK_WIRE', 'WISE', 'PAYONEER');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('PAYMENT_RECEIVED', 'PAYMENT_FAILED', 'WITHDRAWAL_STATUS_CHANGE', 'ORDER_STATUS_CHANGE', 'WALLET_BALANCE_CHANGE', 'SYSTEM_ANNOUNCEMENT');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE', 'CRYPTOMUS', 'PAYTR', 'LIDIO');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'AWAITING_REPLY', 'REPLIED', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "firstName" VARCHAR(100) NOT NULL,
    "lastName" VARCHAR(100) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(20),
    "role" "UserRole" NOT NULL DEFAULT 'CUSTOMER',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "customerType" "CustomerType" NOT NULL DEFAULT 'INDIVIDUAL',
    "identityNumber" VARCHAR(20),
    "birthDate" TIMESTAMP(3),
    "taxExempt" BOOLEAN NOT NULL DEFAULT false,
    "invoiceType" "InvoiceType" NOT NULL DEFAULT 'DEFAULT',
    "dealerGroupId" TEXT,
    "referredById" TEXT,
    "referralCode" VARCHAR(20),
    "smsVerified" BOOLEAN NOT NULL DEFAULT false,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "otpSecret" VARCHAR(255),
    "loginOtpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "orderOtpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "smsNotification" BOOLEAN NOT NULL DEFAULT true,
    "emailNotification" BOOLEAN NOT NULL DEFAULT true,
    "callNotification" BOOLEAN NOT NULL DEFAULT true,
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
    "kycApprovedAt" TIMESTAMP(3),
    "kycLevel" INTEGER NOT NULL DEFAULT 0,
    "countryCode" VARCHAR(10) NOT NULL DEFAULT 'TR',
    "preferredCurrency" "Currency" NOT NULL DEFAULT 'TRY',
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIp" VARCHAR(45),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "module" VARCHAR(50) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_permissions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" TEXT,

    CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dealer_groups" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "defaultDiscountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "minOrderAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "creditLimit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "cancelOnApiFail" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dealer_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dealer_stock_restrictions" (
    "id" TEXT NOT NULL,
    "dealerGroupId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "isBlocked" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dealer_stock_restrictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dealer_api_priorities" (
    "id" TEXT NOT NULL,
    "dealerGroupId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "botProviderId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dealer_api_priorities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_categories" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "imageUrl" VARCHAR(500),
    "parentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "seoTitle" VARCHAR(200),
    "seoDescription" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(220) NOT NULL,
    "description" TEXT,
    "iconUrl" VARCHAR(500),
    "merchantImageUrl" VARCHAR(500),
    "categoryId" TEXT NOT NULL,
    "baseCurrency" "Currency" NOT NULL DEFAULT 'USD',
    "baseCost" DECIMAL(12,4) NOT NULL,
    "pricingModel" "PricingModel" NOT NULL DEFAULT 'COST_PLUS_MARGIN',
    "marginPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "fixedPrice" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "stockType" "StockType" NOT NULL DEFAULT 'EPIN',
    "hasInfiniteStock" BOOLEAN NOT NULL DEFAULT false,
    "stockCount" INTEGER NOT NULL DEFAULT 0,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 10,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "seoTitle" VARCHAR(200),
    "seoDescription" VARCHAR(500),
    "seoKeywords" VARCHAR(500),
    "customInputFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dealer_group_pricings" (
    "id" TEXT NOT NULL,
    "dealerGroupId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "overridePricingModel" "PricingModel",
    "customMarginPercent" DECIMAL(5,2),
    "customFixedPrice" DECIMAL(12,4),
    "customDiscountPercent" DECIMAL(5,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dealer_group_pricings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" TEXT NOT NULL,
    "fromCurrency" "Currency" NOT NULL,
    "toCurrency" "Currency" NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "rawRate" DECIMAL(18,8),
    "spreadPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "source" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "epins" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "encryptedCode" TEXT NOT NULL,
    "encryptionIv" VARCHAR(64) NOT NULL,
    "status" "EPinStatus" NOT NULL DEFAULT 'AVAILABLE',
    "supplierId" TEXT NOT NULL,
    "purchaseCost" DECIMAL(12,4) NOT NULL,
    "purchaseCurrency" "Currency" NOT NULL DEFAULT 'USD',
    "expiresAt" TIMESTAMP(3),
    "serialNumber" VARCHAR(100),
    "batchId" VARCHAR(100),
    "supplierRef" VARCHAR(100),
    "reservedAt" TIMESTAMP(3),
    "soldAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "epins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "orderNumber" VARCHAR(30) NOT NULL,
    "userId" TEXT,
    "isGuest" BOOLEAN NOT NULL DEFAULT false,
    "guestEmail" VARCHAR(255),
    "guestPhone" VARCHAR(20),
    "guestTrackingToken" VARCHAR(64),
    "currency" "Currency" NOT NULL DEFAULT 'TRY',
    "totalAmount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "status" "ParentOrderStatus" NOT NULL DEFAULT 'PENDING',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paymentMethod" VARCHAR(50),
    "paymentRef" VARCHAR(200),
    "customerNote" TEXT,
    "adminNote" TEXT,
    "ipAddress" VARCHAR(45),
    "assignedStaffId" TEXT,
    "staffLockedAt" TIMESTAMP(3),
    "staffNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sub_orders" (
    "id" TEXT NOT NULL,
    "parentOrderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(12,4) NOT NULL,
    "unitCost" DECIMAL(12,4) NOT NULL,
    "totalPrice" DECIMAL(14,4) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'TRY',
    "status" "SubOrderStatus" NOT NULL DEFAULT 'PENDING',
    "deliveryType" "DeliveryType" NOT NULL DEFAULT 'EPIN',
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "botProviderId" TEXT,
    "fallbackAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "adminNote" TEXT,
    "cancelReason" TEXT,
    "deliveryNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sub_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sub_order_items" (
    "id" TEXT NOT NULL,
    "subOrderId" TEXT NOT NULL,
    "epinId" TEXT,
    "externalRef" VARCHAR(200),
    "isDelivered" BOOLEAN NOT NULL DEFAULT false,
    "deliveredAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sub_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_financial_logs" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "subOrderId" TEXT,
    "type" "FinancialLogType" NOT NULL,
    "description" TEXT,
    "grossAmount" DECIMAL(14,4) NOT NULL,
    "taxAmount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "feeAmount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(14,4) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'USD',
    "costAmount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "profitAmount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "performedById" VARCHAR(36),
    "performedBy" VARCHAR(200),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_financial_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'TRY',
    "balanceCurrent" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "balanceBonus" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "balanceWithdrawable" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "balanceCredit" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "balanceFrozen" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "balanceLottery" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "balanceCashback" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "balanceCommission" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" "WalletTxType" NOT NULL,
    "balanceField" "BalanceField" NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "balanceAfter" DECIMAL(14,4) NOT NULL,
    "description" TEXT,
    "orderId" TEXT,
    "referenceType" VARCHAR(50),
    "referenceId" TEXT,
    "performedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_rules" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "incomeModel" "ReferralIncomeModel" NOT NULL DEFAULT 'PRODUCT_SALE',
    "referralModel" "ReferralModelType" NOT NULL DEFAULT 'REFERRAL_LINK',
    "calculationMethod" "ReferralCalculation" NOT NULL DEFAULT 'SALE_PRICE',
    "calculationBasis" "ReferralBasis" NOT NULL,
    "commissionPercent" DECIMAL(5,2) NOT NULL,
    "fixedCommission" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "tierLevel" INTEGER NOT NULL DEFAULT 1,
    "earnerCustomerType" VARCHAR(50),
    "minPurchaseAmount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "maxPurchaseAmount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "minSalesAmount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "maxCommission" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "orderCountLimit" INTEGER NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "selfEarningEnabled" BOOLEAN NOT NULL DEFAULT false,
    "applicableCategoryIds" TEXT[],
    "applicableProductIds" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_referrals" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "referralRuleId" TEXT,
    "totalEarnings" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "totalTransactions" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_transactions" (
    "id" TEXT NOT NULL,
    "userReferralId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "subOrderId" TEXT,
    "calculationBasis" "ReferralBasis" NOT NULL,
    "appliedPercent" DECIMAL(5,2) NOT NULL,
    "baseAmount" DECIMAL(14,4) NOT NULL,
    "commissionAmount" DECIMAL(14,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_providers" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "type" "BotProviderType" NOT NULL,
    "status" "BotProviderStatus" NOT NULL DEFAULT 'ACTIVE',
    "apiUrl" VARCHAR(500),
    "encryptedApiKey" TEXT,
    "encryptedApiSecret" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "maxConcurrentRequests" INTEGER NOT NULL DEFAULT 10,
    "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "fallbackProviderId" TEXT,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_provider_products" (
    "id" TEXT NOT NULL,
    "botProviderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "externalProductCode" VARCHAR(100),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_provider_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "description" TEXT,
    "iconUrl" VARCHAR(500),
    "gatewayConfig" JSONB,
    "minAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "maxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "feePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "fixedFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dealer_group_payment_methods" (
    "id" TEXT NOT NULL,
    "dealerGroupId" TEXT NOT NULL,
    "paymentMethodId" TEXT NOT NULL,
    "isAllowed" BOOLEAN NOT NULL DEFAULT true,
    "additionalFeePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dealer_group_payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "contactName" VARCHAR(150),
    "email" VARCHAR(255),
    "phone" VARCHAR(30),
    "taxId" VARCHAR(50),
    "address" TEXT,
    "country" VARCHAR(50),
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" "AuditAction" NOT NULL,
    "entityType" VARCHAR(50),
    "entityId" TEXT,
    "details" JSONB,
    "previousValue" JSONB,
    "newValue" JSONB,
    "ipAddress" VARCHAR(45),
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discount_coupons" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "description" TEXT,
    "type" "CouponType" NOT NULL DEFAULT 'PERCENTAGE',
    "value" DECIMAL(14,4) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'USD',
    "minOrderAmount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "maxDiscountAmount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "maxUsageTotal" INTEGER NOT NULL DEFAULT 0,
    "maxUsagePerUser" INTEGER NOT NULL DEFAULT 1,
    "currentUsage" INTEGER NOT NULL DEFAULT 0,
    "applicableProductIds" TEXT[],
    "applicableCategoryIds" TEXT[],
    "applicableUserRoles" TEXT[],
    "status" "CouponStatus" NOT NULL DEFAULT 'ACTIVE',
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discount_coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_usages" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "userId" TEXT,
    "orderId" TEXT,
    "discountAmount" DECIMAL(14,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "invoiceNumber" VARCHAR(30) NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "InvoiceType" NOT NULL DEFAULT 'DEFAULT',
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DECIMAL(14,4) NOT NULL,
    "serviceFee" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 20,
    "taxAmount" DECIMAL(14,4) NOT NULL,
    "totalAmount" DECIMAL(14,4) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'TRY',
    "customerName" VARCHAR(200) NOT NULL,
    "customerEmail" VARCHAR(255) NOT NULL,
    "customerAddress" TEXT,
    "taxId" VARCHAR(50),
    "externalInvoiceId" VARCHAR(200),
    "pdfUrl" VARCHAR(500),
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "notes" TEXT,
    "billingEntityId" TEXT,
    "issuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "orderId" TEXT,
    "subOrderId" TEXT,
    "productName" VARCHAR(200) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,4) NOT NULL,
    "totalPrice" DECIMAL(14,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sliders" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "imageUrl" VARCHAR(500) NOT NULL,
    "mobileImageUrl" VARCHAR(500),
    "linkUrl" VARCHAR(500),
    "position" VARCHAR(50) NOT NULL DEFAULT 'HOME_TOP',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sliders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_categories" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_posts" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "slug" VARCHAR(350) NOT NULL,
    "content" TEXT NOT NULL,
    "excerpt" VARCHAR(500),
    "coverImage" VARCHAR(500),
    "categoryId" TEXT,
    "authorId" TEXT,
    "seoTitle" VARCHAR(200),
    "seoDescription" VARCHAR(500),
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blog_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lotteries" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "imageUrl" VARCHAR(500),
    "createdById" TEXT NOT NULL,
    "entryPrice" DECIMAL(14,4) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'TRY',
    "maxEntries" INTEGER NOT NULL DEFAULT 0,
    "prizeDescription" TEXT,
    "prizeValue" DECIMAL(14,4),
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "drawDate" TIMESTAMP(3),
    "winnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lotteries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lottery_entries" (
    "id" TEXT NOT NULL,
    "lotteryId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ticketNumber" VARCHAR(20) NOT NULL,
    "isWinner" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lottery_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" TEXT NOT NULL,
    "event" VARCHAR(50) NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "subject" VARCHAR(300),
    "body" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "dealerGroupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversion_events" (
    "id" TEXT NOT NULL,
    "platform" VARCHAR(50) NOT NULL,
    "eventName" VARCHAR(100) NOT NULL,
    "orderId" TEXT,
    "userId" TEXT,
    "value" DECIMAL(14,4),
    "currency" "Currency" NOT NULL DEFAULT 'USD',
    "metadata" JSONB,
    "pixelId" VARCHAR(100),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversion_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_payment_restrictions" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "paymentMethodId" TEXT NOT NULL,
    "isHidden" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_payment_restrictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_documents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentType" "KycDocumentType" NOT NULL,
    "documentUrl" VARCHAR(500) NOT NULL,
    "thumbnailUrl" VARCHAR(500),
    "documentNumber" VARCHAR(50),
    "issuedCountry" VARCHAR(5),
    "issuedDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "status" "KycStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "rejectionReason" TEXT,
    "ocrData" JSONB,
    "matchScore" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kyc_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_entities" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "legalName" VARCHAR(300) NOT NULL,
    "taxId" VARCHAR(50) NOT NULL,
    "vatNumber" VARCHAR(50),
    "address" TEXT NOT NULL,
    "city" VARCHAR(100) NOT NULL,
    "state" VARCHAR(100),
    "country" VARCHAR(50) NOT NULL,
    "postalCode" VARCHAR(20) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(30) NOT NULL,
    "website" VARCHAR(200),
    "paymentAccounts" JSONB,
    "logoUrl" VARCHAR(500),
    "stampUrl" VARCHAR(500),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "walletTxId" TEXT,
    "gateway" "PaymentGateway" NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'USD',
    "feeAmount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(14,4) NOT NULL,
    "gatewayTransactionId" VARCHAR(255),
    "gatewayResponse" JSONB,
    "status" "PaymentTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "cryptoCurrency" VARCHAR(10),
    "cryptoAddress" VARCHAR(100),
    "cryptoTxHash" VARCHAR(100),
    "riskScore" INTEGER,
    "is3DSecure" BOOLEAN NOT NULL DEFAULT false,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'USD',
    "feeAmount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(14,4) NOT NULL,
    "method" "WithdrawalMethod" NOT NULL,
    "destinationAccount" JSONB NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "statusHistory" JSONB,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "processedAt" TIMESTAMP(3),
    "processedTxHash" VARCHAR(100),
    "failureReason" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_discounts" (
    "id" TEXT NOT NULL,
    "dealerGroupId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL,
    "discountAmount" DECIMAL(14,4),
    "minQuantity" INTEGER NOT NULL DEFAULT 1,
    "maxQuantity" INTEGER NOT NULL DEFAULT 0,
    "minOrderAmount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_discounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "message" TEXT NOT NULL,
    "relatedEntityType" VARCHAR(50),
    "relatedEntityId" TEXT,
    "actionUrl" VARCHAR(500),
    "actionText" VARCHAR(100),
    "imageUrl" VARCHAR(500),
    "deliveryStatus" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "user_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_logs" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "signature" TEXT,
    "isValid" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_webhook_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "subject" VARCHAR(255) NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "assignedToId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_messages" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "isStaff" BOOLEAN NOT NULL DEFAULT false,
    "content" TEXT NOT NULL,
    "attachments" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_referralCode_key" ON "users"("referralCode");

-- CreateIndex
CREATE INDEX "users_dealerGroupId_idx" ON "users"("dealerGroupId");

-- CreateIndex
CREATE INDEX "users_referredById_idx" ON "users"("referredById");

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE INDEX "permissions_module_idx" ON "permissions"("module");

-- CreateIndex
CREATE UNIQUE INDEX "user_permissions_userId_permissionId_key" ON "user_permissions"("userId", "permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "dealer_groups_name_key" ON "dealer_groups"("name");

-- CreateIndex
CREATE UNIQUE INDEX "dealer_stock_restrictions_dealerGroupId_productId_key" ON "dealer_stock_restrictions"("dealerGroupId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "dealer_api_priorities_dealerGroupId_productId_botProviderId_key" ON "dealer_api_priorities"("dealerGroupId", "productId", "botProviderId");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_slug_key" ON "product_categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");

-- CreateIndex
CREATE INDEX "products_categoryId_idx" ON "products"("categoryId");

-- CreateIndex
CREATE INDEX "products_stockType_isActive_idx" ON "products"("stockType", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "dealer_group_pricings_dealerGroupId_productId_key" ON "dealer_group_pricings"("dealerGroupId", "productId");

-- CreateIndex
CREATE INDEX "exchange_rates_fromCurrency_idx" ON "exchange_rates"("fromCurrency");

-- CreateIndex
CREATE INDEX "exchange_rates_toCurrency_idx" ON "exchange_rates"("toCurrency");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_fromCurrency_toCurrency_key" ON "exchange_rates"("fromCurrency", "toCurrency");

-- CreateIndex
CREATE INDEX "epins_productId_status_idx" ON "epins"("productId", "status");

-- CreateIndex
CREATE INDEX "epins_batchId_idx" ON "epins"("batchId");

-- CreateIndex
CREATE INDEX "epins_supplierId_idx" ON "epins"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_orderNumber_key" ON "orders"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "orders_guestTrackingToken_key" ON "orders"("guestTrackingToken");

-- CreateIndex
CREATE INDEX "orders_userId_idx" ON "orders"("userId");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_createdAt_idx" ON "orders"("createdAt");

-- CreateIndex
CREATE INDEX "orders_guestTrackingToken_idx" ON "orders"("guestTrackingToken");

-- CreateIndex
CREATE INDEX "orders_assignedStaffId_idx" ON "orders"("assignedStaffId");

-- CreateIndex
CREATE INDEX "sub_orders_parentOrderId_idx" ON "sub_orders"("parentOrderId");

-- CreateIndex
CREATE INDEX "sub_orders_status_idx" ON "sub_orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sub_order_items_epinId_key" ON "sub_order_items"("epinId");

-- CreateIndex
CREATE INDEX "sub_order_items_subOrderId_idx" ON "sub_order_items"("subOrderId");

-- CreateIndex
CREATE INDEX "order_financial_logs_orderId_idx" ON "order_financial_logs"("orderId");

-- CreateIndex
CREATE INDEX "order_financial_logs_subOrderId_idx" ON "order_financial_logs"("subOrderId");

-- CreateIndex
CREATE INDEX "order_financial_logs_type_idx" ON "order_financial_logs"("type");

-- CreateIndex
CREATE INDEX "order_financial_logs_createdAt_idx" ON "order_financial_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_userId_key" ON "wallets"("userId");

-- CreateIndex
CREATE INDEX "wallet_transactions_walletId_idx" ON "wallet_transactions"("walletId");

-- CreateIndex
CREATE INDEX "wallet_transactions_orderId_idx" ON "wallet_transactions"("orderId");

-- CreateIndex
CREATE INDEX "wallet_transactions_createdAt_idx" ON "wallet_transactions"("createdAt");

-- CreateIndex
CREATE INDEX "user_referrals_referrerId_idx" ON "user_referrals"("referrerId");

-- CreateIndex
CREATE UNIQUE INDEX "user_referrals_referrerId_referredUserId_key" ON "user_referrals"("referrerId", "referredUserId");

-- CreateIndex
CREATE INDEX "referral_transactions_userReferralId_idx" ON "referral_transactions"("userReferralId");

-- CreateIndex
CREATE INDEX "referral_transactions_orderId_idx" ON "referral_transactions"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "bot_provider_products_botProviderId_productId_key" ON "bot_provider_products"("botProviderId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_code_key" ON "payment_methods"("code");

-- CreateIndex
CREATE UNIQUE INDEX "dealer_group_payment_methods_dealerGroupId_paymentMethodId_key" ON "dealer_group_payment_methods"("dealerGroupId", "paymentMethodId");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_code_key" ON "suppliers"("code");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "discount_coupons_code_key" ON "discount_coupons"("code");

-- CreateIndex
CREATE INDEX "coupon_usages_couponId_idx" ON "coupon_usages"("couponId");

-- CreateIndex
CREATE INDEX "coupon_usages_userId_idx" ON "coupon_usages"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoiceNumber_key" ON "invoices"("invoiceNumber");

-- CreateIndex
CREATE INDEX "invoices_userId_idx" ON "invoices"("userId");

-- CreateIndex
CREATE INDEX "invoices_status_idx" ON "invoices"("status");

-- CreateIndex
CREATE INDEX "invoices_createdAt_idx" ON "invoices"("createdAt");

-- CreateIndex
CREATE INDEX "invoice_items_invoiceId_idx" ON "invoice_items"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "blog_categories_slug_key" ON "blog_categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "blog_posts_slug_key" ON "blog_posts"("slug");

-- CreateIndex
CREATE INDEX "blog_posts_categoryId_idx" ON "blog_posts"("categoryId");

-- CreateIndex
CREATE INDEX "blog_posts_status_idx" ON "blog_posts"("status");

-- CreateIndex
CREATE INDEX "blog_posts_slug_idx" ON "blog_posts"("slug");

-- CreateIndex
CREATE INDEX "lotteries_status_idx" ON "lotteries"("status");

-- CreateIndex
CREATE INDEX "lotteries_createdById_idx" ON "lotteries"("createdById");

-- CreateIndex
CREATE INDEX "lottery_entries_lotteryId_idx" ON "lottery_entries"("lotteryId");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_entries_lotteryId_userId_key" ON "lottery_entries"("lotteryId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_event_channel_dealerGroupId_key" ON "notification_templates"("event", "channel", "dealerGroupId");

-- CreateIndex
CREATE INDEX "conversion_events_platform_idx" ON "conversion_events"("platform");

-- CreateIndex
CREATE INDEX "conversion_events_orderId_idx" ON "conversion_events"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "category_payment_restrictions_categoryId_paymentMethodId_key" ON "category_payment_restrictions"("categoryId", "paymentMethodId");

-- CreateIndex
CREATE INDEX "kyc_documents_userId_idx" ON "kyc_documents"("userId");

-- CreateIndex
CREATE INDEX "kyc_documents_status_idx" ON "kyc_documents"("status");

-- CreateIndex
CREATE INDEX "kyc_documents_documentType_idx" ON "kyc_documents"("documentType");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_walletTxId_key" ON "payment_transactions"("walletTxId");

-- CreateIndex
CREATE INDEX "payment_transactions_userId_idx" ON "payment_transactions"("userId");

-- CreateIndex
CREATE INDEX "payment_transactions_orderId_idx" ON "payment_transactions"("orderId");

-- CreateIndex
CREATE INDEX "payment_transactions_gateway_idx" ON "payment_transactions"("gateway");

-- CreateIndex
CREATE INDEX "payment_transactions_status_idx" ON "payment_transactions"("status");

-- CreateIndex
CREATE INDEX "withdrawal_requests_userId_idx" ON "withdrawal_requests"("userId");

-- CreateIndex
CREATE INDEX "withdrawal_requests_status_idx" ON "withdrawal_requests"("status");

-- CreateIndex
CREATE INDEX "withdrawal_requests_createdAt_idx" ON "withdrawal_requests"("createdAt");

-- CreateIndex
CREATE INDEX "product_discounts_productId_idx" ON "product_discounts"("productId");

-- CreateIndex
CREATE INDEX "product_discounts_isActive_idx" ON "product_discounts"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "product_discounts_dealerGroupId_productId_key" ON "product_discounts"("dealerGroupId", "productId");

-- CreateIndex
CREATE INDEX "user_notifications_userId_idx" ON "user_notifications"("userId");

-- CreateIndex
CREATE INDEX "user_notifications_type_idx" ON "user_notifications"("type");

-- CreateIndex
CREATE INDEX "user_notifications_deliveryStatus_idx" ON "user_notifications"("deliveryStatus");

-- CreateIndex
CREATE INDEX "user_notifications_isRead_idx" ON "user_notifications"("isRead");

-- CreateIndex
CREATE INDEX "user_notifications_createdAt_idx" ON "user_notifications"("createdAt");

-- CreateIndex
CREATE INDEX "payment_webhook_logs_provider_createdAt_idx" ON "payment_webhook_logs"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "payment_webhook_logs_orderId_idx" ON "payment_webhook_logs"("orderId");

-- CreateIndex
CREATE INDEX "tickets_userId_status_idx" ON "tickets"("userId", "status");

-- CreateIndex
CREATE INDEX "tickets_assignedToId_status_idx" ON "tickets"("assignedToId", "status");

-- CreateIndex
CREATE INDEX "tickets_orderId_idx" ON "tickets"("orderId");

-- CreateIndex
CREATE INDEX "ticket_messages_ticketId_createdAt_idx" ON "ticket_messages"("ticketId", "createdAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_dealerGroupId_fkey" FOREIGN KEY ("dealerGroupId") REFERENCES "dealer_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealer_stock_restrictions" ADD CONSTRAINT "dealer_stock_restrictions_dealerGroupId_fkey" FOREIGN KEY ("dealerGroupId") REFERENCES "dealer_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealer_stock_restrictions" ADD CONSTRAINT "dealer_stock_restrictions_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealer_api_priorities" ADD CONSTRAINT "dealer_api_priorities_dealerGroupId_fkey" FOREIGN KEY ("dealerGroupId") REFERENCES "dealer_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealer_api_priorities" ADD CONSTRAINT "dealer_api_priorities_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealer_api_priorities" ADD CONSTRAINT "dealer_api_priorities_botProviderId_fkey" FOREIGN KEY ("botProviderId") REFERENCES "bot_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "product_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealer_group_pricings" ADD CONSTRAINT "dealer_group_pricings_dealerGroupId_fkey" FOREIGN KEY ("dealerGroupId") REFERENCES "dealer_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealer_group_pricings" ADD CONSTRAINT "dealer_group_pricings_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "epins" ADD CONSTRAINT "epins_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "epins" ADD CONSTRAINT "epins_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_parentOrderId_fkey" FOREIGN KEY ("parentOrderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_botProviderId_fkey" FOREIGN KEY ("botProviderId") REFERENCES "bot_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_order_items" ADD CONSTRAINT "sub_order_items_subOrderId_fkey" FOREIGN KEY ("subOrderId") REFERENCES "sub_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_order_items" ADD CONSTRAINT "sub_order_items_epinId_fkey" FOREIGN KEY ("epinId") REFERENCES "epins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_financial_logs" ADD CONSTRAINT "order_financial_logs_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_referrals" ADD CONSTRAINT "user_referrals_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_referrals" ADD CONSTRAINT "user_referrals_referredUserId_fkey" FOREIGN KEY ("referredUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_referrals" ADD CONSTRAINT "user_referrals_referralRuleId_fkey" FOREIGN KEY ("referralRuleId") REFERENCES "referral_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_transactions" ADD CONSTRAINT "referral_transactions_userReferralId_fkey" FOREIGN KEY ("userReferralId") REFERENCES "user_referrals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_transactions" ADD CONSTRAINT "referral_transactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_transactions" ADD CONSTRAINT "referral_transactions_subOrderId_fkey" FOREIGN KEY ("subOrderId") REFERENCES "sub_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_providers" ADD CONSTRAINT "bot_providers_fallbackProviderId_fkey" FOREIGN KEY ("fallbackProviderId") REFERENCES "bot_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_provider_products" ADD CONSTRAINT "bot_provider_products_botProviderId_fkey" FOREIGN KEY ("botProviderId") REFERENCES "bot_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_provider_products" ADD CONSTRAINT "bot_provider_products_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealer_group_payment_methods" ADD CONSTRAINT "dealer_group_payment_methods_dealerGroupId_fkey" FOREIGN KEY ("dealerGroupId") REFERENCES "dealer_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealer_group_payment_methods" ADD CONSTRAINT "dealer_group_payment_methods_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "payment_methods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_usages" ADD CONSTRAINT "coupon_usages_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "discount_coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_billingEntityId_fkey" FOREIGN KEY ("billingEntityId") REFERENCES "billing_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "blog_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_entries" ADD CONSTRAINT "lottery_entries_lotteryId_fkey" FOREIGN KEY ("lotteryId") REFERENCES "lotteries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_payment_restrictions" ADD CONSTRAINT "category_payment_restrictions_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "product_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_payment_restrictions" ADD CONSTRAINT "category_payment_restrictions_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "payment_methods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_walletTxId_fkey" FOREIGN KEY ("walletTxId") REFERENCES "wallet_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_discounts" ADD CONSTRAINT "product_discounts_dealerGroupId_fkey" FOREIGN KEY ("dealerGroupId") REFERENCES "dealer_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_discounts" ADD CONSTRAINT "product_discounts_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
