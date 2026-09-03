-- Task #982: multichannel outreach.
--
-- NOTE: `prisma migrate diff` emitted DROP INDEX for knowledge_chunk_embedding_hnsw
-- and knowledge_chunk_tsv_gin and they have been REMOVED by hand, as in every
-- previous migration (9th occurrence). Prisma cannot express an HNSW or a
-- GIN-on-tsvector index, so it reads both as drift and proposes deleting them.
-- Applying that would silently turn every knowledge retrieval into a sequential
-- scan. Verify after applying:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'KnowledgeChunk';

-- This migration also adds the WorkbenchDemo -> WebsiteAuditRun foreign key
-- that Task #981 omitted. Without it, deleting an audit left the demo behind:
-- 41 orphaned demos and 15 live PUBLIC links pointing at audits that no longer
-- existed. Those rows were cleaned up before this migration was applied.

-- CreateTable
CREATE TABLE "OutreachCampaign" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "companyName" TEXT,
    "companyDomain" TEXT,
    "auditRunId" TEXT NOT NULL,
    "auditReportId" TEXT NOT NULL,
    "decisionMakerId" TEXT,
    "workbenchDemoId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "statusReason" TEXT,
    "autoSendEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedByCrmUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachSequenceStep" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "dayOffset" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "requiresPreviousStatus" JSONB,
    "requiresChannelEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachSequenceStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachAction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "stepId" TEXT,
    "crmCompanyId" TEXT NOT NULL,
    "companyName" TEXT,
    "channel" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "contactName" TEXT,
    "contactTitle" TEXT,
    "decisionMakerId" TEXT,
    "destination" TEXT,
    "destinationKind" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "statusReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "providerName" TEXT,
    "providerStatus" TEXT,
    "providerMessageId" TEXT,
    "providerResponse" JSONB,
    "failureKind" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "validation" JSONB,
    "validationOk" BOOLEAN NOT NULL DEFAULT false,
    "suppressionReason" TEXT,
    "suppressionDetail" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "templateVersion" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "blocks" JSONB,
    "ctaUrl" TEXT,
    "workbenchUrl" TEXT,
    "evidence" JSONB,
    "characterCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachProviderRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "providerName" TEXT NOT NULL,
    "providerStatus" TEXT NOT NULL,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "manualRequired" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "failureKind" TEXT,
    "response" JSONB,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachProviderRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutreachCampaign_tenantId_crmCompanyId_createdAt_idx" ON "OutreachCampaign"("tenantId", "crmCompanyId", "createdAt");

-- CreateIndex
CREATE INDEX "OutreachCampaign_tenantId_status_idx" ON "OutreachCampaign"("tenantId", "status");

-- CreateIndex
CREATE INDEX "OutreachCampaign_auditRunId_idx" ON "OutreachCampaign"("auditRunId");

-- CreateIndex
CREATE INDEX "OutreachSequenceStep_tenantId_channel_idx" ON "OutreachSequenceStep"("tenantId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachSequenceStep_campaignId_stepNumber_key" ON "OutreachSequenceStep"("campaignId", "stepNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachAction_idempotencyKey_key" ON "OutreachAction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OutreachAction_tenantId_status_scheduledAt_idx" ON "OutreachAction"("tenantId", "status", "scheduledAt");

-- CreateIndex
CREATE INDEX "OutreachAction_campaignId_stepNumber_idx" ON "OutreachAction"("campaignId", "stepNumber");

-- CreateIndex
CREATE INDEX "OutreachAction_tenantId_crmCompanyId_sentAt_idx" ON "OutreachAction"("tenantId", "crmCompanyId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachMessage_actionId_key" ON "OutreachMessage"("actionId");

-- CreateIndex
CREATE INDEX "OutreachMessage_tenantId_templateKey_templateVersion_idx" ON "OutreachMessage"("tenantId", "templateKey", "templateVersion");

-- CreateIndex
CREATE INDEX "OutreachProviderRun_actionId_attempt_idx" ON "OutreachProviderRun"("actionId", "attempt");

-- CreateIndex
CREATE INDEX "OutreachProviderRun_tenantId_providerStatus_idx" ON "OutreachProviderRun"("tenantId", "providerStatus");

-- AddForeignKey
ALTER TABLE "WorkbenchDemo" ADD CONSTRAINT "WorkbenchDemo_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "WebsiteAuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachSequenceStep" ADD CONSTRAINT "OutreachSequenceStep_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "OutreachCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachAction" ADD CONSTRAINT "OutreachAction_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "OutreachCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachAction" ADD CONSTRAINT "OutreachAction_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "OutreachSequenceStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachMessage" ADD CONSTRAINT "OutreachMessage_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "OutreachAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachProviderRun" ADD CONSTRAINT "OutreachProviderRun_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "OutreachAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

