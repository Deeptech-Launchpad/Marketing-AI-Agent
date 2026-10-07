-- Bulk Email Upload (2026-10-07). Additive: two new tables, nothing changed.

CREATE TABLE "BulkEmailCampaign" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "templateKey" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "fromEmail" TEXT NOT NULL,
  "fromName" TEXT,
  "ccEmails" JSONB NOT NULL,
  "signature" TEXT NOT NULL,
  "postalAddress" TEXT NOT NULL,
  "sourceFileName" TEXT,
  "timezone" TEXT NOT NULL,
  "startAt" TIMESTAMP(3) NOT NULL,
  "sendDays" JSONB NOT NULL,
  "sendStartMinute" INTEGER NOT NULL,
  "sendEndMinute" INTEGER NOT NULL,
  "intervalMinutes" INTEGER NOT NULL,
  "dailyCap" INTEGER NOT NULL,
  "totalRows" INTEGER NOT NULL DEFAULT 0,
  "createdByCrmUserId" TEXT NOT NULL,
  "approvedByCrmUserId" TEXT NOT NULL,
  "approvedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BulkEmailCampaign_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BulkEmailCampaign_tenantId_status_idx" ON "BulkEmailCampaign"("tenantId", "status");

CREATE TABLE "BulkEmailRecipient" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "companyName" TEXT NOT NULL,
  "contactName" TEXT,
  "toEmail" TEXT,
  "ccEmails" JSONB NOT NULL,
  "sourceRows" JSONB NOT NULL,
  "subject" TEXT,
  "body" TEXT,
  "status" TEXT NOT NULL,
  "reason" TEXT,
  "scheduledAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "messageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BulkEmailRecipient_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BulkEmailRecipient_campaignId_status_scheduledAt_idx" ON "BulkEmailRecipient"("campaignId", "status", "scheduledAt");
CREATE INDEX "BulkEmailRecipient_tenantId_status_scheduledAt_idx" ON "BulkEmailRecipient"("tenantId", "status", "scheduledAt");
CREATE INDEX "BulkEmailRecipient_tenantId_toEmail_idx" ON "BulkEmailRecipient"("tenantId", "toEmail");
ALTER TABLE "BulkEmailRecipient" ADD CONSTRAINT "BulkEmailRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "BulkEmailCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
