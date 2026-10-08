-- Bulk Email (2026-10-08): the approved version (1, 2 or 3) each person
-- receives; versions rotate down the list. Additive.
ALTER TABLE "BulkEmailRecipient" ADD COLUMN "templateKey" TEXT;
