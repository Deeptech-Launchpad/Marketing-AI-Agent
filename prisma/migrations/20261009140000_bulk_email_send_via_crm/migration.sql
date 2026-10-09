-- Bulk Email sent through NXT Sales (2026-10-09). Additive: existing sends
-- keep sendVia 'smtp'; existing recipients have no CRM key.
ALTER TABLE "BulkEmailCampaign" ADD COLUMN "sendVia" TEXT NOT NULL DEFAULT 'smtp';
ALTER TABLE "BulkEmailRecipient" ADD COLUMN "crmSendKey" TEXT;
ALTER TABLE "BulkEmailRecipient" ADD COLUMN "crmOutcome" TEXT;
CREATE UNIQUE INDEX "BulkEmailRecipient_crmSendKey_key" ON "BulkEmailRecipient"("crmSendKey");
