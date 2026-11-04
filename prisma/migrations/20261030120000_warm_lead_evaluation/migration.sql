-- Warm leads (2026-10-30). Additive: two new tables; no existing table is changed.
-- CreateTable
CREATE TABLE "WarmLeadRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "requestedBy" TEXT NOT NULL,
    "companyIds" JSONB NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "deepCheckCap" INTEGER NOT NULL DEFAULT 0,
    "deepChecks" INTEGER NOT NULL DEFAULT 0,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarmLeadRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarmLeadEvaluation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "companyName" TEXT,
    "website" TEXT,
    "contact" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "classification" TEXT,
    "score" INTEGER,
    "confidence" TEXT,
    "summary" TEXT,
    "reasons" JSONB,
    "deepCheck" TEXT,
    "enrichmentId" TEXT,
    "intentRunId" TEXT,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "crmSyncedAt" TIMESTAMP(3),
    "crmSyncError" TEXT,
    "startedAt" TIMESTAMP(3),
    "evaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarmLeadEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WarmLeadRun_tenantId_kind_createdAt_idx" ON "WarmLeadRun"("tenantId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "WarmLeadRun_tenantId_status_idx" ON "WarmLeadRun"("tenantId", "status");

-- CreateIndex
CREATE INDEX "WarmLeadEvaluation_tenantId_crmCompanyId_status_idx" ON "WarmLeadEvaluation"("tenantId", "crmCompanyId", "status");

-- CreateIndex
CREATE INDEX "WarmLeadEvaluation_tenantId_classification_idx" ON "WarmLeadEvaluation"("tenantId", "classification");

-- CreateIndex
CREATE UNIQUE INDEX "WarmLeadEvaluation_runId_crmCompanyId_key" ON "WarmLeadEvaluation"("runId", "crmCompanyId");

-- AddForeignKey
ALTER TABLE "WarmLeadEvaluation" ADD CONSTRAINT "WarmLeadEvaluation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WarmLeadRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

