-- 2026-09-24 RESTRUCTURE — OPEN-WEB COMPANY DISCOVERY IDENTITY
--
-- ProspectSearch/AudienceMember stay CRM-only, by design (see the comment on
-- ProspectSearch). This is the additive, second way a prospect can enter the
-- pipeline: found on the open web, before (and independent of whether) it is
-- ever matched to or created in NXT Sales.
--
-- CreateTable
CREATE TABLE "marketing"."CompanyDiscoverySearch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "requestedByCrmUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "queriesRun" JSONB,
    "totalCandidatesFound" INTEGER NOT NULL DEFAULT 0,
    "totalAssessed" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CompanyDiscoverySearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing"."DiscoveredCompany" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "domain" TEXT,
    "sourceQuery" TEXT NOT NULL,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "websiteUrl" TEXT,
    "websiteSummary" TEXT,
    "fitAssessment" JSONB,
    "discoverySourceUrl" TEXT NOT NULL,
    "discoverySourceTitle" TEXT,
    "crmCompanyId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "createdByCrmUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "searchId" TEXT,

    CONSTRAINT "DiscoveredCompany_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyDiscoverySearch_tenantId_status_idx" ON "marketing"."CompanyDiscoverySearch"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CompanyDiscoverySearch_tenantId_createdAt_idx" ON "marketing"."CompanyDiscoverySearch"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "DiscoveredCompany_tenantId_status_idx" ON "marketing"."DiscoveredCompany"("tenantId", "status");

-- CreateIndex
CREATE INDEX "DiscoveredCompany_tenantId_domain_idx" ON "marketing"."DiscoveredCompany"("tenantId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredCompany_tenantId_searchId_discoverySourceUrl_key" ON "marketing"."DiscoveredCompany"("tenantId", "searchId", "discoverySourceUrl");

-- AddForeignKey
ALTER TABLE "marketing"."DiscoveredCompany" ADD CONSTRAINT "DiscoveredCompany_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "marketing"."CompanyDiscoverySearch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Companion disambiguator columns: when crmCompanyId on IntentDetectionRun /
-- IntentSignal actually holds a DiscoveredCompany.id placeholder rather than a
-- real NXT Sales id (see DiscoveredCompany's own comment), this says so. Every
-- existing row keeps null, meaning "a real CRM company", its current meaning.
--
-- AlterTable
ALTER TABLE "marketing"."IntentDetectionRun" ADD COLUMN "discoveredCompanyId" TEXT;

-- AlterTable
ALTER TABLE "marketing"."IntentSignal" ADD COLUMN "discoveredCompanyId" TEXT;

-- CreateIndex
CREATE INDEX "IntentDetectionRun_discoveredCompanyId_idx" ON "marketing"."IntentDetectionRun"("discoveredCompanyId");

-- CreateIndex
CREATE INDEX "IntentSignal_discoveredCompanyId_idx" ON "marketing"."IntentSignal"("discoveredCompanyId");
