-- Task #979: catalog findings, sales collateral and PDF report.
--
-- NOTE: `prisma migrate diff` emitted DROP INDEX for knowledge_chunk_embedding_hnsw
-- and knowledge_chunk_tsv_gin and they have been REMOVED by hand, as in every
-- previous migration (6th occurrence). Prisma cannot express an HNSW or a
-- GIN-on-tsvector index, so it reads both as drift and proposes deleting them.
-- Applying that would silently turn every knowledge retrieval into a sequential
-- scan. Verify after applying:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'KnowledgeChunk';

-- CreateTable
CREATE TABLE "CatalogFinding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "auditRunId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'low',
    "priorityReasons" JSONB,
    "affectedCount" INTEGER NOT NULL DEFAULT 0,
    "observedCount" INTEGER NOT NULL DEFAULT 0,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "sampleUnit" TEXT NOT NULL DEFAULT 'pages',
    "metric" TEXT NOT NULL,
    "finding" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditReport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "auditRunId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "companyName" TEXT,
    "websiteUrl" TEXT,
    "auditDate" TIMESTAMP(3) NOT NULL,
    "pagesInspected" INTEGER NOT NULL DEFAULT 0,
    "productPagesInspected" INTEGER NOT NULL DEFAULT 0,
    "categoryPagesInspected" INTEGER NOT NULL DEFAULT 0,
    "findingCount" INTEGER NOT NULL DEFAULT 0,
    "highPriorityCount" INTEGER NOT NULL DEFAULT 0,
    "collateral" JSONB,
    "pdfBytes" BYTEA,
    "pdfSha256" TEXT,
    "pdfPageCount" INTEGER,
    "pdfBytesSize" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ready_for_approval',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogFinding_auditRunId_priority_idx" ON "CatalogFinding"("auditRunId", "priority");

-- CreateIndex
CREATE INDEX "CatalogFinding_tenantId_crmCompanyId_createdAt_idx" ON "CatalogFinding"("tenantId", "crmCompanyId", "createdAt");

-- CreateIndex
CREATE INDEX "CatalogFinding_tenantId_code_idx" ON "CatalogFinding"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "AuditReport_auditRunId_key" ON "AuditReport"("auditRunId");

-- CreateIndex
CREATE INDEX "AuditReport_tenantId_crmCompanyId_generatedAt_idx" ON "AuditReport"("tenantId", "crmCompanyId", "generatedAt");

-- CreateIndex
CREATE INDEX "AuditReport_tenantId_status_idx" ON "AuditReport"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "CatalogFinding" ADD CONSTRAINT "CatalogFinding_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "WebsiteAuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditReport" ADD CONSTRAINT "AuditReport_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "WebsiteAuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

