-- Warm Leads: the permanent module (2026-11-04). ADDITIVE ONLY: three new tables and five new columns.
-- No existing column is changed or dropped; nothing here reads or writes another feature's tables.

-- AlterTable
ALTER TABLE "WarmLeadRun" ADD COLUMN "bucket" TEXT;
ALTER TABLE "WarmLeadEvaluation" ADD COLUMN "tier" TEXT,
  ADD COLUMN "researchIncomplete" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "geminiCalls" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "bucket" TEXT;

-- CreateTable
CREATE TABLE "WarmLeadSettings" (
    "tenantId" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT true,
    "dailyCompanyLimit" INTEGER NOT NULL DEFAULT 25,
    "dailyGeminiCeiling" INTEGER NOT NULL DEFAULT 300,
    "pilotSize" INTEGER NOT NULL DEFAULT 100,
    "pilotGeminiCeiling" INTEGER NOT NULL DEFAULT 1200,
    "approvedMaxCompanies" INTEGER NOT NULL DEFAULT 25,
    "approvedMaxCeiling" INTEGER NOT NULL DEFAULT 300,
    "retryShare" INTEGER NOT NULL DEFAULT 20,
    "windowStart" TEXT NOT NULL DEFAULT '23:00',
    "windowEnd" TEXT NOT NULL DEFAULT '06:00',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "pilotApprovedAt" TIMESTAMP(3),
    "pilotApprovedBy" TEXT,
    "scaleApprovedAt" TIMESTAMP(3),
    "scaleApprovedBy" TEXT,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "syncApprovedAt" TIMESTAMP(3),
    "syncApprovedBy" TEXT,
    "listRefreshRequestedAt" TIMESTAMP(3),
    "listRefreshedAt" TIMESTAMP(3),
    "listRefreshState" TEXT,
    "listRefreshMessage" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarmLeadSettings_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "WarmLeadCompany" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "country" TEXT,
    "industry" TEXT,
    "listPosition" INTEGER NOT NULL DEFAULT 0,
    "inCrm" BOOLEAN NOT NULL DEFAULT true,
    "cohort" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "researchIncomplete" BOOLEAN NOT NULL DEFAULT false,
    "lastEvaluationId" TEXT,
    "currentEvaluationId" TEXT,
    "classification" TEXT,
    "score" INTEGER,
    "confidence" TEXT,
    "summary" TEXT,
    "evaluatedAt" TIMESTAMP(3),
    "syncedEvaluationId" TEXT,
    "syncedAt" TIMESTAMP(3),
    "syncError" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarmLeadCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarmLeadUsage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "geminiCalls" INTEGER NOT NULL DEFAULT 0,
    "geminiCeiling" INTEGER NOT NULL DEFAULT 0,
    "companiesStarted" INTEGER NOT NULL DEFAULT 0,
    "companyLimit" INTEGER NOT NULL DEFAULT 0,
    "retriesStarted" INTEGER NOT NULL DEFAULT 0,
    "retryLimit" INTEGER NOT NULL DEFAULT 0,
    "screened" INTEGER NOT NULL DEFAULT 0,
    "deepResearched" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "incomplete" INTEGER NOT NULL DEFAULT 0,
    "pricedCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "unpricedCalls" INTEGER NOT NULL DEFAULT 0,
    "stoppedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarmLeadUsage_pkey" PRIMARY KEY ("id")
);


-- CreateIndex
CREATE INDEX "WarmLeadRun_tenantId_bucket_idx" ON "WarmLeadRun"("tenantId", "bucket");

-- CreateIndex
CREATE INDEX "WarmLeadCompany_tenantId_state_listPosition_idx" ON "WarmLeadCompany"("tenantId", "state", "listPosition");

-- CreateIndex
CREATE INDEX "WarmLeadCompany_tenantId_state_nextAttemptAt_idx" ON "WarmLeadCompany"("tenantId", "state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "WarmLeadCompany_tenantId_classification_idx" ON "WarmLeadCompany"("tenantId", "classification");

-- CreateIndex
CREATE INDEX "WarmLeadCompany_tenantId_cohort_state_idx" ON "WarmLeadCompany"("tenantId", "cohort", "state");

-- CreateIndex
CREATE UNIQUE INDEX "WarmLeadCompany_tenantId_crmCompanyId_key" ON "WarmLeadCompany"("tenantId", "crmCompanyId");

-- CreateIndex
CREATE UNIQUE INDEX "WarmLeadUsage_tenantId_bucket_key" ON "WarmLeadUsage"("tenantId", "bucket");

