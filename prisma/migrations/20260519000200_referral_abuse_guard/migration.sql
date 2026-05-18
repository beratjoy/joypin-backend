ALTER TABLE "user_referrals"
ADD COLUMN IF NOT EXISTS "riskStatus" VARCHAR(30) NOT NULL DEFAULT 'CLEAR',
ADD COLUMN IF NOT EXISTS "riskScore" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "riskReasons" JSONB,
ADD COLUMN IF NOT EXISTS "signupIp" VARCHAR(45),
ADD COLUMN IF NOT EXISTS "signupUserAgent" VARCHAR(500),
ADD COLUMN IF NOT EXISTS "blockedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "referral_risk_events" (
  "id" TEXT NOT NULL,
  "userReferralId" TEXT,
  "referrerId" TEXT,
  "referredUserId" TEXT,
  "tenantId" TEXT,
  "eventType" VARCHAR(80) NOT NULL,
  "severity" VARCHAR(20) NOT NULL,
  "score" INTEGER NOT NULL DEFAULT 0,
  "action" VARCHAR(30) NOT NULL,
  "reasons" JSONB,
  "metadata" JSONB,
  "ipAddress" VARCHAR(45),
  "userAgent" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "resolvedBy" TEXT,
  CONSTRAINT "referral_risk_events_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "referral_risk_events"
  ADD CONSTRAINT "referral_risk_events_userReferralId_fkey"
  FOREIGN KEY ("userReferralId") REFERENCES "user_referrals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "user_referrals_riskStatus_createdAt_idx" ON "user_referrals"("riskStatus", "createdAt");
CREATE INDEX IF NOT EXISTS "referral_risk_events_createdAt_idx" ON "referral_risk_events"("createdAt");
CREATE INDEX IF NOT EXISTS "referral_risk_events_severity_action_idx" ON "referral_risk_events"("severity", "action");
CREATE INDEX IF NOT EXISTS "referral_risk_events_referrerId_idx" ON "referral_risk_events"("referrerId");
CREATE INDEX IF NOT EXISTS "referral_risk_events_referredUserId_idx" ON "referral_risk_events"("referredUserId");
