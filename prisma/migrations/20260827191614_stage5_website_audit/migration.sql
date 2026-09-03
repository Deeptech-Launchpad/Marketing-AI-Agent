-- Stage 5: website audit.
--
-- NOTE: `prisma migrate diff` emitted DROP INDEX for knowledge_chunk_embedding_hnsw
-- and knowledge_chunk_tsv_gin and they have been REMOVED by hand, as in every
-- previous migration (this is the 5th occurrence). Prisma cannot express an HNSW
-- or a GIN-on-tsvector index, so it reads both as drift and proposes deleting
-- them. Applying that would silently turn every knowledge retrieval into a
-- sequential scan. Verify after applying:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'KnowledgeChunk';

-- CreateTable
CREATE TABLE "WebsiteAuditRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "companyName" TEXT,
    "startUrl" TEXT,
    "rootHost" TEXT,
    "prospectSearchId" TEXT,
    "requestedByCrmUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "pagesSkipped" INTEGER NOT NULL DEFAULT 0,
    "productPages" INTEGER NOT NULL DEFAULT 0,
    "categoryPages" INTEGER NOT NULL DEFAULT 0,
    "otherPages" INTEGER NOT NULL DEFAULT 0,
    "duplicatePages" INTEGER NOT NULL DEFAULT 0,
    "canonicalDuplicates" INTEGER NOT NULL DEFAULT 0,
    "soft404Pages" INTEGER NOT NULL DEFAULT 0,
    "httpErrors" INTEGER NOT NULL DEFAULT 0,
    "unreachablePages" INTEGER NOT NULL DEFAULT 0,
    "structuredDataPages" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" INTEGER NOT NULL DEFAULT 0,
    "limitsHit" JSONB,
    "limitsApplied" JSONB,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "error" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsiteAuditRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditedPage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "auditRunId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "requestedUrl" TEXT NOT NULL,
    "finalUrl" TEXT,
    "httpStatus" INTEGER,
    "contentType" TEXT,
    "outcome" TEXT NOT NULL,
    "pageType" TEXT NOT NULL DEFAULT 'unknown',
    "typeSignals" JSONB,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT,
    "canonicalUrl" TEXT,
    "duplicateOfUrl" TEXT,
    "redirectChain" JSONB,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "failureReason" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditedPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageObservation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "auditRunId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'not_observed',
    "value" TEXT,
    "method" TEXT,
    "sourcePath" TEXT,
    "fragment" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebsiteAuditRun_tenantId_crmCompanyId_createdAt_idx" ON "WebsiteAuditRun"("tenantId", "crmCompanyId", "createdAt");

-- CreateIndex
CREATE INDEX "WebsiteAuditRun_tenantId_status_idx" ON "WebsiteAuditRun"("tenantId", "status");

-- CreateIndex
CREATE INDEX "WebsiteAuditRun_prospectSearchId_idx" ON "WebsiteAuditRun"("prospectSearchId");

-- CreateIndex
CREATE INDEX "AuditedPage_auditRunId_pageType_idx" ON "AuditedPage"("auditRunId", "pageType");

-- CreateIndex
CREATE INDEX "AuditedPage_tenantId_crmCompanyId_fetchedAt_idx" ON "AuditedPage"("tenantId", "crmCompanyId", "fetchedAt");

-- CreateIndex
CREATE INDEX "AuditedPage_auditRunId_outcome_idx" ON "AuditedPage"("auditRunId", "outcome");

-- CreateIndex
CREATE INDEX "AuditedPage_contentHash_idx" ON "AuditedPage"("contentHash");

-- CreateIndex
CREATE INDEX "PageObservation_auditRunId_field_status_idx" ON "PageObservation"("auditRunId", "field", "status");

-- CreateIndex
CREATE INDEX "PageObservation_pageId_field_idx" ON "PageObservation"("pageId", "field");

-- CreateIndex
CREATE INDEX "PageObservation_tenantId_field_idx" ON "PageObservation"("tenantId", "field");

-- AddForeignKey
ALTER TABLE "AuditedPage" ADD CONSTRAINT "AuditedPage_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "WebsiteAuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageObservation" ADD CONSTRAINT "PageObservation_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "AuditedPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

