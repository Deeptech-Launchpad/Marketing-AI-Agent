-- Bulk Email: ZIP of company-wise PDFs (2026-10-17). Additive: one column with a default on the
-- stored files (existing rows stay 'common') and one nullable column on the recipients.
-- AlterTable
ALTER TABLE "BulkAttachment" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'common';

-- AlterTable
ALTER TABLE "BulkEmailRecipient" ADD COLUMN     "attachmentId" TEXT;

