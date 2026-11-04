-- Warm leads: the sample a run was chosen from (2026-10-31). Additive: one nullable column.
ALTER TABLE "WarmLeadRun" ADD COLUMN "sample" JSONB;
