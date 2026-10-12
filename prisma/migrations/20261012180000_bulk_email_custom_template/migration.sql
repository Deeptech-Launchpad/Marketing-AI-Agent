-- Bulk Email: the user's own template (2026-10-12). The HTML of the email as it was
-- reviewed, stored per recipient and sent as it is. Additive: one nullable column;
-- no existing row or column changes.
-- AlterTable
ALTER TABLE "BulkEmailRecipient" ADD COLUMN     "bodyHtml" TEXT;

