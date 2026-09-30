-- Creating an account with an email address and a password, proven by a
-- one-time code (2026-09-30). Additive: Google sign-in is unchanged.

-- A password account has no Google id, so this can no longer be required.
ALTER TABLE "AppUser" ALTER COLUMN "googleSub" DROP NOT NULL;
ALTER TABLE "AppUser" ALTER COLUMN "emailVerified" SET DEFAULT false;
ALTER TABLE "AppUser" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;

-- One-time codes. Only the hash is stored; the code itself exists only in the
-- email that was sent.
CREATE TABLE "EmailOtp" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "usedAt" TIMESTAMP(3),
  "requestedIp" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailOtp_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmailOtp_tenantId_email_purpose_createdAt_idx" ON "EmailOtp"("tenantId", "email", "purpose", "createdAt");
CREATE INDEX "EmailOtp_expiresAt_idx" ON "EmailOtp"("expiresAt");
