CREATE TABLE IF NOT EXISTS "publisher_applications" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT,
  "userId" TEXT,
  "fullName" VARCHAR(180) NOT NULL,
  "email" VARCHAR(255) NOT NULL,
  "phone" VARCHAR(40),
  "platform" VARCHAR(80),
  "profileUrl" VARCHAR(500) NOT NULL,
  "followerCount" INTEGER NOT NULL DEFAULT 0,
  "message" TEXT,
  "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  "adminNote" TEXT,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "publisher_applications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "publisher_applications_tenantId_status_idx" ON "publisher_applications"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "publisher_applications_email_idx" ON "publisher_applications"("email");
CREATE INDEX IF NOT EXISTS "publisher_applications_createdAt_idx" ON "publisher_applications"("createdAt");
