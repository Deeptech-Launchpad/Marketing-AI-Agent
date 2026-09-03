-- Task #981: AI Workbench.
--
-- NOTE: `prisma migrate diff` emitted DROP INDEX for knowledge_chunk_embedding_hnsw
-- and knowledge_chunk_tsv_gin and they have been REMOVED by hand, as in every
-- previous migration (8th occurrence). Prisma cannot express an HNSW or a
-- GIN-on-tsvector index, so it reads both as drift and proposes deleting them.
-- Applying that would silently turn every knowledge retrieval into a sequential
-- scan. Verify after applying:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'KnowledgeChunk';

-- CreateTable
CREATE TABLE "WorkbenchDemo" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "auditRunId" TEXT NOT NULL,
    "auditReportId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "companyName" TEXT,
    "websiteUrl" TEXT,
    "productPageId" TEXT,
    "productPageUrl" TEXT,
    "productName" TEXT,
    "selectionReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "statusReason" TEXT,
    "theme" JSONB,
    "structuredData" JSONB,
    "valuePoints" JSONB,
    "observedFieldCount" INTEGER NOT NULL DEFAULT 0,
    "totalFieldCount" INTEGER NOT NULL DEFAULT 0,
    "improvedFieldCount" INTEGER NOT NULL DEFAULT 0,
    "sourceReportStatus" TEXT,
    "builtFromUnapproved" BOOLEAN NOT NULL DEFAULT false,
    "geminiUsed" BOOLEAN NOT NULL DEFAULT false,
    "geminiCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkbenchDemo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkbenchField" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "demoId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "beforeValue" TEXT,
    "afterValue" TEXT,
    "delta" TEXT NOT NULL DEFAULT 'unchanged',
    "headline" BOOLEAN NOT NULL DEFAULT false,
    "transformKind" TEXT NOT NULL,
    "sourceObservationId" TEXT,
    "sourceField" TEXT,
    "sourceUrl" TEXT,
    "sourcePath" TEXT,
    "sourceFragment" TEXT,
    "transformRule" TEXT NOT NULL,

    CONSTRAINT "WorkbenchField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkbenchLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "demoId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenHint" TEXT,
    "label" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByCrmUserId" TEXT,
    "maxViews" INTEGER,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "firstViewedAt" TIMESTAMP(3),
    "lastViewedAt" TIMESTAMP(3),
    "createdByCrmUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkbenchLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkbenchVisitor" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "demoId" TEXT NOT NULL,
    "linkId" TEXT,
    "fullName" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "workEmail" TEXT NOT NULL,
    "jobTitle" TEXT,
    "phone" TEXT,
    "sessionHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "WorkbenchVisitor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkbenchDemo_auditRunId_key" ON "WorkbenchDemo"("auditRunId");

-- CreateIndex
CREATE INDEX "WorkbenchDemo_tenantId_crmCompanyId_generatedAt_idx" ON "WorkbenchDemo"("tenantId", "crmCompanyId", "generatedAt");

-- CreateIndex
CREATE INDEX "WorkbenchDemo_tenantId_status_idx" ON "WorkbenchDemo"("tenantId", "status");

-- CreateIndex
CREATE INDEX "WorkbenchField_demoId_position_idx" ON "WorkbenchField"("demoId", "position");

-- CreateIndex
CREATE INDEX "WorkbenchField_tenantId_field_idx" ON "WorkbenchField"("tenantId", "field");

-- CreateIndex
CREATE UNIQUE INDEX "WorkbenchLink_tokenHash_key" ON "WorkbenchLink"("tokenHash");

-- CreateIndex
CREATE INDEX "WorkbenchLink_demoId_createdAt_idx" ON "WorkbenchLink"("demoId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkbenchLink_tenantId_expiresAt_idx" ON "WorkbenchLink"("tenantId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkbenchVisitor_sessionHash_key" ON "WorkbenchVisitor"("sessionHash");

-- CreateIndex
CREATE INDEX "WorkbenchVisitor_demoId_registeredAt_idx" ON "WorkbenchVisitor"("demoId", "registeredAt");

-- CreateIndex
CREATE INDEX "WorkbenchVisitor_tenantId_registeredAt_idx" ON "WorkbenchVisitor"("tenantId", "registeredAt");

-- AddForeignKey
ALTER TABLE "WorkbenchField" ADD CONSTRAINT "WorkbenchField_demoId_fkey" FOREIGN KEY ("demoId") REFERENCES "WorkbenchDemo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkbenchLink" ADD CONSTRAINT "WorkbenchLink_demoId_fkey" FOREIGN KEY ("demoId") REFERENCES "WorkbenchDemo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkbenchVisitor" ADD CONSTRAINT "WorkbenchVisitor_demoId_fkey" FOREIGN KEY ("demoId") REFERENCES "WorkbenchDemo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkbenchVisitor" ADD CONSTRAINT "WorkbenchVisitor_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "WorkbenchLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

