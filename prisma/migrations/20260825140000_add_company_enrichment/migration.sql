-- Stage 2: company enrichment. Purely additive.
--
-- The `DROP INDEX` statements that `prisma migrate diff` emits for
-- knowledge_chunk_embedding_hnsw and knowledge_chunk_tsv_gin were stripped
-- before saving. Those indexes are created by sql/002_indexes.sql because HNSW
-- and GIN over Unsupported vector/tsvector columns cannot be expressed in
-- schema.prisma, so Prisma reads them as drift on every diff. Dropping them
-- would not error and would not lose data — retrieval would silently fall back
-- to sequential scans.

-- CreateTable
CREATE TABLE "CompanyEnrichment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "companyName" TEXT,
    "prospectSearchId" TEXT,
    "requestedByCrmUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "sourceUrl" TEXT,
    "signals" JSONB,
    "technologies" JSONB,
    "technologyCount" INTEGER NOT NULL DEFAULT 0,
    "provenance" JSONB,
    "failureReason" TEXT,
    "error" JSONB,
    "fetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CompanyEnrichment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyEnrichment_tenantId_crmCompanyId_createdAt_idx" ON "CompanyEnrichment"("tenantId", "crmCompanyId", "createdAt");

-- CreateIndex
CREATE INDEX "CompanyEnrichment_tenantId_status_idx" ON "CompanyEnrichment"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CompanyEnrichment_prospectSearchId_idx" ON "CompanyEnrichment"("prospectSearchId");

