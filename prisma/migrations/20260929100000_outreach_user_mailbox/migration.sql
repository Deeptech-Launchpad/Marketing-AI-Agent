-- Outreach is sent from each logged-in user's own mailbox (2026-09-29).
CREATE TABLE "UserMailbox" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "crmUserId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "signature" TEXT NOT NULL DEFAULT '',
  "smtpHost" TEXT NOT NULL,
  "smtpPort" INTEGER NOT NULL,
  "smtpSecure" BOOLEAN NOT NULL DEFAULT false,
  "passwordEnc" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'connected',
  "lastVerifiedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserMailbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserMailbox_tenantId_crmUserId_key" ON "UserMailbox"("tenantId", "crmUserId");

ALTER TABLE "OutreachSendAttempt" ADD COLUMN "fromAddress" TEXT;
