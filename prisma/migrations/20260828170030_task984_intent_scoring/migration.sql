-- TASK #984 — INTENT SCORING
--
-- Adds IntentScoringPolicy, IntentScore, IntentScoreSnapshot and
-- IntentScoreContribution.
--
-- IntentScoreContribution.engagementEventId is NOT NULL with a foreign key onto
-- EngagementEvent. That is the structural guarantee behind "no score point
-- exists without an engagement event": a contribution with no resolvable event
-- cannot be inserted at all.
--
-- NOTE ON THE pgvector INDEXES
-- `prisma migrate diff` emits DROP INDEX for knowledge_chunk_embedding_hnsw and
-- knowledge_chunk_tsv_gin on every migration, because Prisma cannot model an
-- HNSW or a GIN index and therefore believes they are drift. They are not: they
-- are the vector and full-text search indexes the knowledge base depends on.
-- Both DROP statements are stripped here, as in every prior migration, and the
-- indexes are verified present afterwards.

-- CreateTable
CREATE TABLE "IntentScoringPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'provisional',
    "description" TEXT NOT NULL,
    "minScore" INTEGER NOT NULL DEFAULT 0,
    "maxScore" INTEGER NOT NULL DEFAULT 100,
    "rules" JSONB NOT NULL,
    "decayBands" JSONB NOT NULL,
    "levelBands" JSONB NOT NULL,
    "scoringActors" JSONB NOT NULL,
    "notes" JSONB NOT NULL,
    "activeFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeTo" TIMESTAMP(3),
    "createdByCrmUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntentScoringPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntentScore" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "companyName" TEXT,
    "rawScore" INTEGER NOT NULL,
    "normalizedScore" INTEGER NOT NULL,
    "minScore" INTEGER NOT NULL DEFAULT 0,
    "maxScore" INTEGER NOT NULL DEFAULT 100,
    "clamped" BOOLEAN NOT NULL DEFAULT false,
    "level" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "policyStatus" TEXT NOT NULL,
    "calculationVersion" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "contactabilityStatus" TEXT NOT NULL DEFAULT 'unknown',
    "contactabilityReasons" JSONB,
    "eventsConsidered" INTEGER NOT NULL DEFAULT 0,
    "eventsScored" INTEGER NOT NULL DEFAULT 0,
    "eventsExcluded" INTEGER NOT NULL DEFAULT 0,
    "resultHash" TEXT NOT NULL,
    "latestSnapshotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntentScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntentScoreSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "rawScore" INTEGER NOT NULL,
    "normalizedScore" INTEGER NOT NULL,
    "clamped" BOOLEAN NOT NULL DEFAULT false,
    "level" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "policyStatus" TEXT NOT NULL,
    "calculationVersion" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "contactabilityStatus" TEXT NOT NULL DEFAULT 'unknown',
    "contactabilityReasons" JSONB,
    "eventsConsidered" INTEGER NOT NULL DEFAULT 0,
    "eventsScored" INTEGER NOT NULL DEFAULT 0,
    "eventsExcluded" INTEGER NOT NULL DEFAULT 0,
    "deltaFromPrevious" INTEGER,
    "resultHash" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'recalculation',
    "requestedByCrmUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntentScoreSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntentScoreContribution" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "engagementEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "ruleId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL DEFAULT 'interest',
    "basePoints" INTEGER NOT NULL,
    "freshnessMultiplier" DECIMAL(4,3) NOT NULL,
    "freshnessLabel" TEXT NOT NULL,
    "ageDays" INTEGER NOT NULL,
    "adjustedPoints" INTEGER NOT NULL,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntentScoreContribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntentScoringPolicy_version_key" ON "IntentScoringPolicy"("version");

-- CreateIndex
CREATE INDEX "IntentScoringPolicy_tenantId_activeFrom_idx" ON "IntentScoringPolicy"("tenantId", "activeFrom");

-- CreateIndex
CREATE INDEX "IntentScoringPolicy_status_idx" ON "IntentScoringPolicy"("status");

-- CreateIndex
CREATE UNIQUE INDEX "IntentScore_latestSnapshotId_key" ON "IntentScore"("latestSnapshotId");

-- CreateIndex
CREATE INDEX "IntentScore_tenantId_level_normalizedScore_idx" ON "IntentScore"("tenantId", "level", "normalizedScore");

-- CreateIndex
CREATE INDEX "IntentScore_tenantId_evaluatedAt_idx" ON "IntentScore"("tenantId", "evaluatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IntentScore_tenantId_crmCompanyId_key" ON "IntentScore"("tenantId", "crmCompanyId");

-- CreateIndex
CREATE INDEX "IntentScoreSnapshot_tenantId_crmCompanyId_evaluatedAt_idx" ON "IntentScoreSnapshot"("tenantId", "crmCompanyId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "IntentScoreSnapshot_tenantId_crmCompanyId_createdAt_idx" ON "IntentScoreSnapshot"("tenantId", "crmCompanyId", "createdAt");

-- CreateIndex
CREATE INDEX "IntentScoreSnapshot_policyVersion_idx" ON "IntentScoreSnapshot"("policyVersion");

-- CreateIndex
CREATE INDEX "IntentScoreContribution_snapshotId_occurredAt_idx" ON "IntentScoreContribution"("snapshotId", "occurredAt");

-- CreateIndex
CREATE INDEX "IntentScoreContribution_engagementEventId_idx" ON "IntentScoreContribution"("engagementEventId");

-- CreateIndex
CREATE INDEX "IntentScoreContribution_tenantId_eventType_idx" ON "IntentScoreContribution"("tenantId", "eventType");

-- AddForeignKey
ALTER TABLE "IntentScore" ADD CONSTRAINT "IntentScore_policyVersion_fkey" FOREIGN KEY ("policyVersion") REFERENCES "IntentScoringPolicy"("version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntentScore" ADD CONSTRAINT "IntentScore_latestSnapshotId_fkey" FOREIGN KEY ("latestSnapshotId") REFERENCES "IntentScoreSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntentScoreSnapshot" ADD CONSTRAINT "IntentScoreSnapshot_policyVersion_fkey" FOREIGN KEY ("policyVersion") REFERENCES "IntentScoringPolicy"("version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntentScoreContribution" ADD CONSTRAINT "IntentScoreContribution_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "IntentScoreSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntentScoreContribution" ADD CONSTRAINT "IntentScoreContribution_engagementEventId_fkey" FOREIGN KEY ("engagementEventId") REFERENCES "EngagementEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

