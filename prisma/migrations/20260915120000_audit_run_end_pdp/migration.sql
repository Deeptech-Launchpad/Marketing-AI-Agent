-- The Website Audit now audits ONE page: the End PDP link recorded on the
-- company in NXT Sales, instead of crawling the whole website.
--
--   pdpAssessment     which case the link is in (valid product page / link
--                     problem / no link), with the issue and the recommended
--                     next step for the marketing agent
--   pdpEnrichment     the enriched product record built from a valid page,
--                     every attribute labelled with where its value came from
--   pdpBeforeCapture  photograph of the customer's product page (JPEG)
--   pdpAfterCapture   photograph of the enriched product page (JPEG)
--
-- Additive and nullable: existing runs keep their meaning.
ALTER TABLE "marketing"."WebsiteAuditRun" ADD COLUMN "pdpAssessment" JSONB;
ALTER TABLE "marketing"."WebsiteAuditRun" ADD COLUMN "pdpEnrichment" JSONB;
ALTER TABLE "marketing"."WebsiteAuditRun" ADD COLUMN "pdpBeforeCapture" BYTEA;
ALTER TABLE "marketing"."WebsiteAuditRun" ADD COLUMN "pdpAfterCapture" BYTEA;
