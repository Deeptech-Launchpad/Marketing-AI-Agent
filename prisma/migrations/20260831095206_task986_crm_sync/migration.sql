-- TASK #986 — CRM / NXT SALES HANDOFF
--
-- Adds CrmSyncRecord, CrmSyncAttempt and CrmSyncOutbox.
--
-- CrmSyncRecord.externalKey and .qualificationId are UNIQUE: that is what makes
-- a redelivered sync job converge on the existing handoff instead of creating a
-- duplicate CRM record.
--
-- NOTE ON THE pgvector INDEXES
-- `prisma migrate diff` emits DROP INDEX for knowledge_chunk_embedding_hnsw and
-- knowledge_chunk_tsv_gin on every migration, because Prisma cannot model an
-- HNSW or a GIN index and therefore believes they are drift. They are not: they
-- are the vector and full-text search indexes the knowledge base depends on.
-- Both DROP statements are stripped here, as in every prior migration, and the
-- indexes are verified present afterwards.

-- CreateTable
CREATE TABLE "CrmSyncRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "qualificationId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "companyName" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "externalKey" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "providerStatus" TEXT NOT NULL,
    "capabilities" JSONB,
    "mappingVersion" TEXT NOT NULL,
    "payloadVersion" TEXT NOT NULL,
    "resourceResults" JSONB,
    "externalIds" JSONB,
    "validationOk" BOOLEAN NOT NULL DEFAULT false,
    "validationIssues" JSONB,
    "ownerCrmUserId" TEXT,
    "ownerStatus" TEXT NOT NULL DEFAULT 'unassigned',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastError" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "nextRetryAt" TIMESTAMP(3),
    "intentScoreId" TEXT,
    "intentScoreSnapshotId" TEXT,
    "auditRunId" TEXT,
    "auditReportId" TEXT,
    "workbenchDemoId" TEXT,
    "outreachCampaignId" TEXT,
    "followUpTaskId" TEXT,
    "decisionMakerId" TEXT,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmSyncRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmSyncAttempt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "syncRecordId" TEXT NOT NULL,
    "qualificationId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "previousState" TEXT,
    "newState" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "providerStatus" TEXT NOT NULL,
    "mappingVersion" TEXT NOT NULL,
    "payloadVersion" TEXT NOT NULL,
    "resourceResults" JSONB,
    "externalIds" JSONB,
    "errorCode" TEXT,
    "error" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "validationOk" BOOLEAN NOT NULL DEFAULT false,
    "validationIssues" JSONB,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "actorType" TEXT NOT NULL DEFAULT 'system',
    "actorCrmUserId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmSyncAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmSyncOutbox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "syncRecordId" TEXT NOT NULL,
    "qualificationId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "externalKey" TEXT NOT NULL,
    "mappingVersion" TEXT NOT NULL,
    "payloadVersion" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT NOT NULL,
    "blockedBy" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "deliveredBy" TEXT,
    "abandonedReason" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmSyncOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmSyncRecord_qualificationId_key" ON "CrmSyncRecord"("qualificationId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmSyncRecord_externalKey_key" ON "CrmSyncRecord"("externalKey");

-- CreateIndex
CREATE INDEX "CrmSyncRecord_tenantId_state_updatedAt_idx" ON "CrmSyncRecord"("tenantId", "state", "updatedAt");

-- CreateIndex
CREATE INDEX "CrmSyncRecord_tenantId_crmCompanyId_idx" ON "CrmSyncRecord"("tenantId", "crmCompanyId");

-- CreateIndex
CREATE INDEX "CrmSyncRecord_state_nextRetryAt_idx" ON "CrmSyncRecord"("state", "nextRetryAt");

-- CreateIndex
CREATE INDEX "CrmSyncAttempt_syncRecordId_attempt_idx" ON "CrmSyncAttempt"("syncRecordId", "attempt");

-- CreateIndex
CREATE INDEX "CrmSyncAttempt_tenantId_occurredAt_idx" ON "CrmSyncAttempt"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "CrmSyncOutbox_tenantId_state_createdAt_idx" ON "CrmSyncOutbox"("tenantId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "CrmSyncOutbox_syncRecordId_createdAt_idx" ON "CrmSyncOutbox"("syncRecordId", "createdAt");

-- CreateIndex
CREATE INDEX "CrmSyncOutbox_externalKey_idx" ON "CrmSyncOutbox"("externalKey");

-- AddForeignKey
ALTER TABLE "CrmSyncRecord" ADD CONSTRAINT "CrmSyncRecord_qualificationId_fkey" FOREIGN KEY ("qualificationId") REFERENCES "SalesQualification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmSyncAttempt" ADD CONSTRAINT "CrmSyncAttempt_syncRecordId_fkey" FOREIGN KEY ("syncRecordId") REFERENCES "CrmSyncRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmSyncOutbox" ADD CONSTRAINT "CrmSyncOutbox_syncRecordId_fkey" FOREIGN KEY ("syncRecordId") REFERENCES "CrmSyncRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

