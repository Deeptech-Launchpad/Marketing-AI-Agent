-- Bulk Email through NXT Sales (2026-10-10): when each email was handed to
-- NXT Sales, for the 5-minute minimum between emails. Additive.
ALTER TABLE "BulkEmailRecipient" ADD COLUMN "crmAttemptedAt" TIMESTAMP(3);
CREATE INDEX "BulkEmailRecipient_crmAttemptedAt_idx" ON "BulkEmailRecipient"("crmAttemptedAt");
