-- How many companies a web-discovery search was asked to return. Nullable:
-- null means no explicit ask, the same convention ProspectSearch.requestedCount
-- already uses.
--
-- AlterTable
ALTER TABLE "marketing"."CompanyDiscoverySearch" ADD COLUMN "requestedCount" INTEGER;
