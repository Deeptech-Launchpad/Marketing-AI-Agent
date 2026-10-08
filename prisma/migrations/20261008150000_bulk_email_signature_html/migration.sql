-- Bulk Email (2026-10-08): the signature exactly as the user pasted it (HTML,
-- embedded images included). Additive.
ALTER TABLE "BulkEmailCampaign" ADD COLUMN "signatureHtml" TEXT NOT NULL DEFAULT '';
