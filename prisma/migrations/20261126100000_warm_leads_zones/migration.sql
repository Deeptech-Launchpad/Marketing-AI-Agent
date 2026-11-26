-- Warm Leads: work through the NXT Sales company list one zone (region) at a time (owner's decision 2026-11-26).
-- Additive only. A company's zone is derived from its NXT Sales country on every list read; existing rows start as
-- 'unknown' and get their zone on the next read. activeZone NULL = no zone chosen = the whole list, as before.
ALTER TABLE "WarmLeadCompany" ADD COLUMN "zone" TEXT NOT NULL DEFAULT 'unknown';
CREATE INDEX "WarmLeadCompany_tenantId_zone_state_listPosition_idx" ON "WarmLeadCompany"("tenantId", "zone", "state", "listPosition");
ALTER TABLE "WarmLeadSettings" ADD COLUMN "activeZone" TEXT;
-- Every class is now sent to NXT Sales. A company can change class without a new evaluation (a refusal found by a check that
-- could not finish moves a Warm company to human review); recording the class NXT Sales holds lets that change be sent too.
ALTER TABLE "WarmLeadCompany" ADD COLUMN "syncedClassification" TEXT;
UPDATE "WarmLeadCompany" SET "syncedClassification" = "classification" WHERE "syncedEvaluationId" IS NOT NULL;
