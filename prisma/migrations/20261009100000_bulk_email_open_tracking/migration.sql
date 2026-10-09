-- Bulk Email open tracking (2026-10-09). Additive: existing rows keep
-- trackingEnabled NULL ("sent before tracking existed") and openCount 0.
ALTER TABLE "BulkEmailRecipient" ADD COLUMN "trackingTokenHash" TEXT;
ALTER TABLE "BulkEmailRecipient" ADD COLUMN "trackingEnabled" BOOLEAN;
ALTER TABLE "BulkEmailRecipient" ADD COLUMN "trackingNote" TEXT;
ALTER TABLE "BulkEmailRecipient" ADD COLUMN "firstOpenedAt" TIMESTAMP(3);
ALTER TABLE "BulkEmailRecipient" ADD COLUMN "lastOpenedAt" TIMESTAMP(3);
ALTER TABLE "BulkEmailRecipient" ADD COLUMN "openCount" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "BulkEmailRecipient_trackingTokenHash_key" ON "BulkEmailRecipient"("trackingTokenHash");
