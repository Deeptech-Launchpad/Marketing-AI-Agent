-- Stage 3: intent detection. Purely additive.
--
-- The DROP INDEX statements prisma migrate diff emits for
-- knowledge_chunk_embedding_hnsw and knowledge_chunk_tsv_gin are stripped
-- here for the third time. Those indexes come from sql/002_indexes.sql
-- because HNSW/GIN over Unsupported columns cannot be expressed in
-- schema.prisma, so every diff reads them as drift. Dropping them would not
-- error and would not lose data - retrieval would silently fall back to
-- sequential scans.



-- CreateTable
CREATE TABLE "IntentDetectionRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "companyName" TEXT,
    "prospectSearchId" TEXT,
    "requestedByCrmUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "signalCount" INTEGER NOT NULL DEFAULT 0,
    "duplicatesCollapsed" INTEGER NOT NULL DEFAULT 0,
    "providerResults" JSONB,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "error" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntentDetectionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntentSignal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "intentRunId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "eventFingerprint" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "signalCategory" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "interpretation" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sourceType" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3),
    "ageDays" INTEGER,
    "freshness" TEXT NOT NULL DEFAULT 'unknown',
    "confidence" TEXT NOT NULL DEFAULT 'low',
    "confidenceReasons" JSONB,
    "polarity" TEXT NOT NULL DEFAULT 'neutral',
    "status" TEXT NOT NULL DEFAULT 'weak',
    "corroboratingEvidence" JSONB,
    "corroborationCount" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntentSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntentDetectionRun_tenantId_crmCompanyId_createdAt_idx" ON "IntentDetectionRun"("tenantId", "crmCompanyId", "createdAt");

-- CreateIndex
CREATE INDEX "IntentDetectionRun_tenantId_status_idx" ON "IntentDetectionRun"("tenantId", "status");

-- CreateIndex
CREATE INDEX "IntentDetectionRun_prospectSearchId_idx" ON "IntentDetectionRun"("prospectSearchId");

-- CreateIndex
CREATE INDEX "IntentSignal_tenantId_crmCompanyId_detectedAt_idx" ON "IntentSignal"("tenantId", "crmCompanyId", "detectedAt");

-- CreateIndex
CREATE INDEX "IntentSignal_tenantId_signalCategory_idx" ON "IntentSignal"("tenantId", "signalCategory");

-- CreateIndex
CREATE INDEX "IntentSignal_intentRunId_idx" ON "IntentSignal"("intentRunId");

-- CreateIndex
CREATE INDEX "IntentSignal_eventFingerprint_idx" ON "IntentSignal"("eventFingerprint");

-- AddForeignKey
ALTER TABLE "IntentSignal" ADD CONSTRAINT "IntentSignal_intentRunId_fkey" FOREIGN KEY ("intentRunId") REFERENCES "IntentDetectionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

