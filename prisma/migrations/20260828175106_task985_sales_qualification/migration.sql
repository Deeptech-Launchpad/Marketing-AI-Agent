-- TASK #985 — SALES QUALIFIED LEAD
--
-- Adds SalesQualificationPolicy, SalesQualification, SalesQualificationHistory,
-- SalesAlert and SalesFollowUpTask.
--
-- SalesAlert.idempotencyKey and SalesFollowUpTask.idempotencyKey are UNIQUE.
-- That is what makes a redelivered worker job converge on the existing alert or
-- task instead of notifying a salesperson twice about the same lead.
--
-- NOTE ON THE pgvector INDEXES
-- `prisma migrate diff` emits DROP INDEX for knowledge_chunk_embedding_hnsw and
-- knowledge_chunk_tsv_gin on every migration, because Prisma cannot model an
-- HNSW or a GIN index and therefore believes they are drift. They are not: they
-- are the vector and full-text search indexes the knowledge base depends on.
-- Both DROP statements are stripped here, as in every prior migration, and the
-- indexes are verified present afterwards.

-- CreateTable
CREATE TABLE "SalesQualificationPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'provisional',
    "description" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "deQualifyBand" INTEGER NOT NULL DEFAULT 0,
    "slaMinutes" INTEGER NOT NULL,
    "createAlert" BOOLEAN NOT NULL DEFAULT true,
    "createFollowUpTask" BOOLEAN NOT NULL DEFAULT true,
    "cancelTaskOnDeQualification" BOOLEAN NOT NULL DEFAULT false,
    "notes" JSONB NOT NULL,
    "activeFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeTo" TIMESTAMP(3),
    "createdByCrmUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesQualificationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesQualification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "companyName" TEXT,
    "status" TEXT NOT NULL,
    "scoreAtQualification" INTEGER NOT NULL,
    "thresholdAtQualification" INTEGER NOT NULL,
    "differenceAtQualification" INTEGER NOT NULL,
    "intentScoreId" TEXT,
    "intentScoreSnapshotId" TEXT,
    "scorePolicyVersion" TEXT NOT NULL,
    "scoreCalculationVersion" TEXT NOT NULL,
    "scoreEvaluatedAt" TIMESTAMP(3) NOT NULL,
    "qualificationPolicyVersion" TEXT NOT NULL,
    "qualificationEngineVersion" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ownerCrmUserId" TEXT,
    "ownerName" TEXT,
    "ownerEmail" TEXT,
    "ownerSource" TEXT NOT NULL DEFAULT 'none',
    "ownerReason" TEXT,
    "alertStatus" TEXT NOT NULL DEFAULT 'pending',
    "taskStatus" TEXT NOT NULL DEFAULT 'pending',
    "qualifiedAt" TIMESTAMP(3),
    "deQualifiedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "evaluationCount" INTEGER NOT NULL DEFAULT 0,
    "lastEvaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesQualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesQualificationHistory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "qualificationId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "previousStatus" TEXT,
    "newStatus" TEXT NOT NULL,
    "previousScore" INTEGER,
    "newScore" INTEGER NOT NULL,
    "threshold" INTEGER NOT NULL,
    "difference" INTEGER NOT NULL,
    "transition" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "qualificationPolicyVersion" TEXT NOT NULL,
    "scorePolicyVersion" TEXT,
    "intentScoreSnapshotId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'system',
    "actorCrmUserId" TEXT,
    "alertStatus" TEXT,
    "taskStatus" TEXT,
    "alertId" TEXT,
    "taskId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesQualificationHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesAlert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "qualificationId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "providerStatus" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "ownerCrmUserId" TEXT,
    "ownerName" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "scoreAtAlert" INTEGER NOT NULL,
    "threshold" INTEGER NOT NULL,
    "failureKind" TEXT,
    "reason" TEXT,
    "skipped" JSONB,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesFollowUpTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "qualificationId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "companyName" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "providerStatus" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "externalId" TEXT,
    "ownerCrmUserId" TEXT,
    "ownerName" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "recommendedAction" TEXT NOT NULL,
    "scoreAtCreation" INTEGER NOT NULL,
    "threshold" INTEGER NOT NULL,
    "slaMinutes" INTEGER NOT NULL,
    "slaPolicyVersion" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "completionStatus" TEXT NOT NULL DEFAULT 'open',
    "completedAt" TIMESTAMP(3),
    "completedByCrmUserId" TEXT,
    "cancelledReason" TEXT,
    "failureKind" TEXT,
    "reason" TEXT,
    "skipped" JSONB,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesFollowUpTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesQualificationPolicy_version_key" ON "SalesQualificationPolicy"("version");

-- CreateIndex
CREATE INDEX "SalesQualificationPolicy_tenantId_activeFrom_idx" ON "SalesQualificationPolicy"("tenantId", "activeFrom");

-- CreateIndex
CREATE INDEX "SalesQualificationPolicy_status_idx" ON "SalesQualificationPolicy"("status");

-- CreateIndex
CREATE INDEX "SalesQualification_tenantId_status_qualifiedAt_idx" ON "SalesQualification"("tenantId", "status", "qualifiedAt");

-- CreateIndex
CREATE INDEX "SalesQualification_tenantId_lastEvaluatedAt_idx" ON "SalesQualification"("tenantId", "lastEvaluatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SalesQualification_tenantId_crmCompanyId_key" ON "SalesQualification"("tenantId", "crmCompanyId");

-- CreateIndex
CREATE INDEX "SalesQualificationHistory_tenantId_crmCompanyId_occurredAt_idx" ON "SalesQualificationHistory"("tenantId", "crmCompanyId", "occurredAt");

-- CreateIndex
CREATE INDEX "SalesQualificationHistory_qualificationId_occurredAt_idx" ON "SalesQualificationHistory"("qualificationId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "SalesAlert_idempotencyKey_key" ON "SalesAlert"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SalesAlert_tenantId_status_createdAt_idx" ON "SalesAlert"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SalesAlert_qualificationId_createdAt_idx" ON "SalesAlert"("qualificationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SalesFollowUpTask_idempotencyKey_key" ON "SalesFollowUpTask"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SalesFollowUpTask_tenantId_completionStatus_dueAt_idx" ON "SalesFollowUpTask"("tenantId", "completionStatus", "dueAt");

-- CreateIndex
CREATE INDEX "SalesFollowUpTask_tenantId_ownerCrmUserId_dueAt_idx" ON "SalesFollowUpTask"("tenantId", "ownerCrmUserId", "dueAt");

-- CreateIndex
CREATE INDEX "SalesFollowUpTask_qualificationId_createdAt_idx" ON "SalesFollowUpTask"("qualificationId", "createdAt");

-- AddForeignKey
ALTER TABLE "SalesQualification" ADD CONSTRAINT "SalesQualification_qualificationPolicyVersion_fkey" FOREIGN KEY ("qualificationPolicyVersion") REFERENCES "SalesQualificationPolicy"("version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesQualificationHistory" ADD CONSTRAINT "SalesQualificationHistory_qualificationId_fkey" FOREIGN KEY ("qualificationId") REFERENCES "SalesQualification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesQualificationHistory" ADD CONSTRAINT "SalesQualificationHistory_qualificationPolicyVersion_fkey" FOREIGN KEY ("qualificationPolicyVersion") REFERENCES "SalesQualificationPolicy"("version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesAlert" ADD CONSTRAINT "SalesAlert_qualificationId_fkey" FOREIGN KEY ("qualificationId") REFERENCES "SalesQualification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesFollowUpTask" ADD CONSTRAINT "SalesFollowUpTask_qualificationId_fkey" FOREIGN KEY ("qualificationId") REFERENCES "SalesQualification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

