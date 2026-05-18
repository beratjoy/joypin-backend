ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerificationCode" VARCHAR(12);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerificationExpiresAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passwordResetTokenHash" VARCHAR(128);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passwordResetExpiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "users_passwordResetTokenHash_idx" ON "users"("passwordResetTokenHash");
