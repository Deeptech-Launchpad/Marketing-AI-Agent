-- Discovered companies: the live NXT Sales duplicate check and "Add to NXT Sales" (2026-09-29).
ALTER TABLE "DiscoveredCompany" ADD COLUMN "crmCheckedAt" TIMESTAMP(3);
ALTER TABLE "DiscoveredCompany" ADD COLUMN "crmMatchedOn" TEXT;
ALTER TABLE "DiscoveredCompany" ADD COLUMN "crmCheckNote" TEXT;
ALTER TABLE "DiscoveredCompany" ADD COLUMN "crmCreateStartedAt" TIMESTAMP(3);
ALTER TABLE "DiscoveredCompany" ADD COLUMN "crmCreatedAt" TIMESTAMP(3);
ALTER TABLE "DiscoveredCompany" ADD COLUMN "crmCreatedByCrmUserId" TEXT;
CREATE INDEX "DiscoveredCompany_tenantId_crmCompanyId_idx" ON "DiscoveredCompany"("tenantId", "crmCompanyId");
