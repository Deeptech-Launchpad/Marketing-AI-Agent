-- TEST MODE for the Sales-approved outreach sequence (2026-09-28).
-- Additive only: no existing column changes meaning.

CREATE TABLE "OutreachBatch" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'test',
  "status" TEXT NOT NULL DEFAULT 'running',
  "firstSendAt" TIMESTAMP(3) NOT NULL,
  "timezone" TEXT NOT NULL,
  "sendDays" JSONB NOT NULL,
  "sendStartMinute" INTEGER NOT NULL,
  "sendEndMinute" INTEGER NOT NULL,
  "spacingMinutes" INTEGER NOT NULL,
  "dailyCap" INTEGER NOT NULL,
  "createdByCrmUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutreachBatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OutreachBatch_tenantId_status_idx" ON "OutreachBatch"("tenantId", "status");

ALTER TABLE "OutreachCampaign" ADD COLUMN "isTest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OutreachCampaign" ADD COLUMN "batchId" TEXT;
ALTER TABLE "OutreachCampaign" ADD CONSTRAINT "OutreachCampaign_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "OutreachBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "OutreachCampaign_batchId_idx" ON "OutreachCampaign"("batchId");

ALTER TABLE "OutreachAction" ADD COLUMN "sentVia" TEXT;

CREATE TABLE "OutreachSendAttempt" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "actionId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "intendedRecipient" TEXT,
  "actualRecipients" JSONB NOT NULL,
  "subject" TEXT,
  "transport" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "providerMessageId" TEXT,
  "error" TEXT,
  "errorKind" TEXT,
  "triggeredBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OutreachSendAttempt_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "OutreachSendAttempt" ADD CONSTRAINT "OutreachSendAttempt_actionId_fkey"
  FOREIGN KEY ("actionId") REFERENCES "OutreachAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "OutreachSendAttempt_actionId_createdAt_idx" ON "OutreachSendAttempt"("actionId", "createdAt");
CREATE INDEX "OutreachSendAttempt_tenantId_createdAt_idx" ON "OutreachSendAttempt"("tenantId", "createdAt");
