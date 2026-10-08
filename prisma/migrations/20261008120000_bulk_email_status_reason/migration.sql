-- Bulk Email (2026-10-08): why a send was paused by the sender itself, for
-- example when its From address is no longer authorized. Additive.
ALTER TABLE "BulkEmailCampaign" ADD COLUMN "statusReason" TEXT;
