-- TASK #983 — ENGAGEMENT TRACKING
--
-- NOTE ON THE pgvector INDEXES
-- `prisma migrate diff` emits DROP INDEX for knowledge_chunk_embedding_hnsw and
-- knowledge_chunk_tsv_gin on every migration, because Prisma cannot model an
-- HNSW or a GIN index and therefore believes they are drift. They are not: they
-- are the vector and full-text search indexes the knowledge base depends on.
-- Both DROP statements are stripped here, as in every prior migration, and the
-- indexes are verified present afterwards.

-- CreateTable
CREATE TABLE "EngagementEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "companyName" TEXT,
    "eventType" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceProvider" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "freshnessLabel" TEXT NOT NULL DEFAULT 'unknown',
    "ageHours" INTEGER NOT NULL DEFAULT 0,
    "timestampNote" TEXT,
    "sessionRef" TEXT,
    "providerEventId" TEXT,
    "workbenchDemoId" TEXT,
    "outreachActionId" TEXT,
    "auditRunId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "processingStatus" TEXT NOT NULL DEFAULT 'recorded',
    "evidence" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngagementEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngagementIngestionRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "source" TEXT NOT NULL,
    "sourceProvider" TEXT,
    "endpoint" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verificationMethod" TEXT,
    "received" INTEGER NOT NULL DEFAULT 0,
    "accepted" INTEGER NOT NULL DEFAULT 0,
    "duplicate" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "rejectionReason" TEXT,
    "rejectionDetail" JSONB,
    "crmCompanyId" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngagementIngestionRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EngagementEvent_dedupeKey_key" ON "EngagementEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "EngagementEvent_tenantId_crmCompanyId_occurredAt_idx" ON "EngagementEvent"("tenantId", "crmCompanyId", "occurredAt");

-- CreateIndex
CREATE INDEX "EngagementEvent_tenantId_crmCompanyId_channel_occurredAt_idx" ON "EngagementEvent"("tenantId", "crmCompanyId", "channel", "occurredAt");

-- CreateIndex
CREATE INDEX "EngagementEvent_tenantId_eventType_occurredAt_idx" ON "EngagementEvent"("tenantId", "eventType", "occurredAt");

-- CreateIndex
CREATE INDEX "EngagementEvent_workbenchDemoId_occurredAt_idx" ON "EngagementEvent"("workbenchDemoId", "occurredAt");

-- CreateIndex
CREATE INDEX "EngagementEvent_outreachActionId_occurredAt_idx" ON "EngagementEvent"("outreachActionId", "occurredAt");

-- CreateIndex
CREATE INDEX "EngagementEvent_sessionRef_idx" ON "EngagementEvent"("sessionRef");

-- CreateIndex
CREATE INDEX "EngagementIngestionRun_tenantId_createdAt_idx" ON "EngagementIngestionRun"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "EngagementIngestionRun_source_verified_createdAt_idx" ON "EngagementIngestionRun"("source", "verified", "createdAt");

-- AddForeignKey
ALTER TABLE "EngagementEvent" ADD CONSTRAINT "EngagementEvent_workbenchDemoId_fkey" FOREIGN KEY ("workbenchDemoId") REFERENCES "WorkbenchDemo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngagementEvent" ADD CONSTRAINT "EngagementEvent_outreachActionId_fkey" FOREIGN KEY ("outreachActionId") REFERENCES "OutreachAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngagementEvent" ADD CONSTRAINT "EngagementEvent_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "WebsiteAuditRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

