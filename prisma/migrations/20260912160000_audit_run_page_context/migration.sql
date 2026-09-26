-- The customer's own page furniture and palette, cached on the audit run.
--
-- The Workbench's job is to say "this is YOUR page, and this is the same page
-- done properly". It could only say the first half once a report was approved
-- AND a demonstration had been built, because that is where the shell and the
-- theme were captured and stored. Every other company got a generic card.
--
-- These describe the CUSTOMER'S WEBSITE, not our demonstration of it, so they
-- belong on the run that read that website. Both nullable: null means "not
-- captured yet", and a capture that fails is stored as a failed capture so a
-- site that cannot be sampled is not re-fetched on every page view.
--
-- Additive and nullable, so every existing run keeps its current meaning.
ALTER TABLE "marketing"."WebsiteAuditRun" ADD COLUMN "websiteShell" JSONB;
ALTER TABLE "marketing"."WebsiteAuditRun" ADD COLUMN "pageTheme" JSONB;
