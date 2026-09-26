-- Prospect discovery reads one product page on each company's own website,
-- the way a PDP audit reads one, and records whether the company needs the
-- service. All nullable: searches that ran before this carry none of it.
--
-- AlterTable
ALTER TABLE "marketing"."DiscoveredCompany" ADD COLUMN "productPageUrl" TEXT;
ALTER TABLE "marketing"."DiscoveredCompany" ADD COLUMN "productAnalysis" JSONB;
ALTER TABLE "marketing"."DiscoveredCompany" ADD COLUMN "serviceNeed" TEXT;

-- CreateIndex
CREATE INDEX "DiscoveredCompany_searchId_serviceNeed_idx" ON "marketing"."DiscoveredCompany"("searchId", "serviceNeed");
