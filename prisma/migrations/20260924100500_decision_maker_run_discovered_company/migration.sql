-- Decision Maker Discovery must be able to run against a DiscoveredCompany
-- (open-web prospect, no CRM record yet) so a Direct Outreach draft can ever
-- be prepared for one — same disambiguator already added to
-- IntentDetectionRun / IntentSignal in company_discovery_identity.
--
-- AlterTable
ALTER TABLE "marketing"."DecisionMakerRun" ADD COLUMN "discoveredCompanyId" TEXT;

-- CreateIndex
CREATE INDEX "DecisionMakerRun_discoveredCompanyId_idx" ON "marketing"."DecisionMakerRun"("discoveredCompanyId");
