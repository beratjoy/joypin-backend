ALTER TABLE "audit_logs"
ADD COLUMN IF NOT EXISTS "category" VARCHAR(40) NOT NULL DEFAULT 'SYSTEM';

CREATE INDEX IF NOT EXISTS "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "audit_logs_category_createdAt_idx" ON "audit_logs"("category", "createdAt");
