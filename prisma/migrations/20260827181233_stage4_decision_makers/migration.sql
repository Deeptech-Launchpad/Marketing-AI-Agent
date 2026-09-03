-- Stage 4: decision-maker discovery.
--
-- NOTE: `prisma migrate diff` emitted DROP INDEX for knowledge_chunk_embedding_hnsw
-- and knowledge_chunk_tsv_gin and they have been REMOVED by hand, as in every
-- previous migration. Prisma cannot express an HNSW or a GIN-on-tsvector index,
-- so it reads both as drift and helpfully proposes deleting them. Applying that
-- would silently turn every knowledge retrieval into a sequential scan.
-- Verify after applying:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'KnowledgeChunk';

-- CreateTable
CREATE TABLE "DecisionMakerRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "companyName" TEXT,
    "companyDomain" TEXT,
    "prospectSearchId" TEXT,
    "requestedByCrmUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "excludedCount" INTEGER NOT NULL DEFAULT 0,
    "duplicatesCollapsed" INTEGER NOT NULL DEFAULT 0,
    "providerResults" JSONB,
    "noResultsReason" TEXT,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "error" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DecisionMakerRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionMakerCandidate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dmRunId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "rawTitle" TEXT,
    "normalizedTitle" TEXT,
    "roleGroup" TEXT,
    "rolePriority" INTEGER,
    "seniority" TEXT,
    "statedCompany" TEXT,
    "companyMatch" TEXT NOT NULL DEFAULT 'unverified',
    "companyMatchReasons" JSONB,
    "profileUrl" TEXT,
    "location" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "confidence" TEXT NOT NULL DEFAULT 'low',
    "confidenceReasons" JSONB,
    "corroboratingProviders" JSONB,
    "corroborationCount" INTEGER NOT NULL DEFAULT 1,
    "rankScore" INTEGER NOT NULL DEFAULT 0,
    "rankReasons" JSONB,
    "rank" INTEGER,
    "evidence" JSONB,
    "outcome" TEXT NOT NULL DEFAULT 'shortlisted',
    "exclusionReason" TEXT,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecisionMakerCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DecisionMakerRun_tenantId_crmCompanyId_createdAt_idx" ON "DecisionMakerRun"("tenantId", "crmCompanyId", "createdAt");

-- CreateIndex
CREATE INDEX "DecisionMakerRun_tenantId_status_idx" ON "DecisionMakerRun"("tenantId", "status");

-- CreateIndex
CREATE INDEX "DecisionMakerRun_prospectSearchId_idx" ON "DecisionMakerRun"("prospectSearchId");

-- CreateIndex
CREATE INDEX "DecisionMakerCandidate_tenantId_crmCompanyId_discoveredAt_idx" ON "DecisionMakerCandidate"("tenantId", "crmCompanyId", "discoveredAt");

-- CreateIndex
CREATE INDEX "DecisionMakerCandidate_dmRunId_outcome_rank_idx" ON "DecisionMakerCandidate"("dmRunId", "outcome", "rank");

-- CreateIndex
CREATE INDEX "DecisionMakerCandidate_tenantId_identityKey_idx" ON "DecisionMakerCandidate"("tenantId", "identityKey");

-- AddForeignKey
ALTER TABLE "DecisionMakerCandidate" ADD CONSTRAINT "DecisionMakerCandidate_dmRunId_fkey" FOREIGN KEY ("dmRunId") REFERENCES "DecisionMakerRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

