-- Sign-in accounts of the Marketing AI Agent itself (2026-09-30).
-- Additive only: the NXT Sales sign-in path is untouched.
CREATE TABLE "AppUser" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT,
  "passwordHash" TEXT,
  "googleSub" TEXT,
  "emailVerified" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'active',
  "crmUserId" TEXT,
  "lastLoginAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppUser_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AppUser_tenantId_email_key" ON "AppUser"("tenantId", "email");
CREATE INDEX "AppUser_tenantId_status_idx" ON "AppUser"("tenantId", "status");
CREATE INDEX "AppUser_googleSub_idx" ON "AppUser"("googleSub");

CREATE TABLE "PasswordResetToken" (
  "id" TEXT NOT NULL,
  "appUserId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "requestedIp" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_appUserId_createdAt_idx" ON "PasswordResetToken"("appUserId", "createdAt");
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_appUserId_fkey"
  FOREIGN KEY ("appUserId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
